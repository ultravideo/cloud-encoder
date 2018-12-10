var express = require('express');
var resumable = require('./resumable-node.js')('/tmp/cloud_uploads/');
var app = express();
var multipart = require('connect-multiparty');
var crypto = require('crypto');
var WebSocketServer = require('websocket').server;
var http = require('http');
var fs = require('fs');
var concat = require('concat-files');
var sqlite3 = require('sqlite3').verbose();
var kue = require('kue');
var db = require('./db');
var ffprobe = require('ffprobe');
var ffprobeStatic = require('ffprobe-static');
var NRP = require('node-redis-pubsub');
const { fork, spawn } = require('child_process');

// worker queue
var queue = kue.createQueue({
    redis: {
        port: 7776,
        host: "127.0.0.1"
    }
});
for (var i = 0; i < 5; ++i) {
    console.log("forked!");
    fork('./worker');
}

// message queue
var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});
fork("./socket");

// ------------------------------ INTERNAL FUNCTIONS ------------------------------

// type can be either "action" or "status"
// "action" means that server is sending the client info regarding resumablejs 
// upload (upload accept/rejected) and "status" means that server is sending 
// the client status messages
//
// { type: "action", reply: "upload" }, { type: "action", reply: "cancel" } and
// { type: "status", reply: null } are all valid action/reply pairs that the 
// client side code understand and knows how to act upon
function sendMessage(user, type, reply, message) {
    nrp.emit('message', {
        user: user,
        type: type,
        reply: reply,
        message: message
    });
}

// concat all resumable file chunks, calculate sha256 checksum
// and rename file. Return new path and file hash
function concatChunks(numChunks, identifier, filename, callback) {
    const tmpFile     = "/tmp/cloud_uploads/" + identifier + ".tmp";
    const pathPrefix = "/tmp/cloud_uploads/resumable-";
    const chunkFiles = Array.from({length: numChunks},
        (v, k) => pathPrefix + filename + "." + (k + 1));

    concat(chunkFiles, tmpFile, function(err) {
        fs.readFile(tmpFile, function(err, data) {
            if (err)
                callback(err, null, null);

            chunkFiles.forEach(function(file) {
                fs.unlink(file, function(err) {
                    if (err)
                        callback(err, null, null);
                });
            });

            // TODO do we even need the file checksum anywhere??
            // const fileHash = crypto.createHash('sha256').update(data).digest('hex');
            const fileHash = crypto.randomBytes(64).toString('hex');
            const filePath = "/tmp/cloud_uploads/" + fileHash;

            fs.rename(tmpFile, filePath, function(err) {
                if (err)
                    callback(err, "", "");
                callback(null, fileHash, filePath);
            });
        });
    });
}

// Host most stuff in the public folder
app.use(express.static(__dirname + '/public'));
app.use(multipart());

// Handle uploads through Resumable.js
app.post('/upload', function(req, res) {
    resumable.post(req, function(status, filename, original_filename, identifier) {
        const tmpFile    = "/tmp/cloud_uploads/" + identifier + ".tmp";
        const chunkFile  = "/tmp/cloud_uploads/resumable-" + original_filename + "." + req.query.resumableChunkNumber;

        // file too large (>50GB), inform user, terminate upload and clean database
        if (req.query.resumableChunkNumber * req.query.resumableChunkSize > 50 * 1000 * 1000 * 1000) {
            sendMessage(req.query.token, "action", "cancel", "File is too large");
            db.getTasks("file_id", identifier)
            .then((tasks) => {
                return Promise.all([ db.removeTask(tasks[0].taskID), db.removeFile(identifier) ]);
            })
            .catch(function(err) {
                console.log(err);
            });

            res.status(400).end();
            return;
        } else if (req.query.resumableChunkNumber == 1 && status !== "done") { // TODO add comment about this check
            db.getFile(identifier).then(function(row) {
                // this file hasn't been approved, terminate download
                if (!row) {
                    sendMessage(req.query.token, "action", "cancel", "File hasn't  been approved, file upload rejected!");
                    res.status(400).send();
                    return;
                } else {
                    // raw video, continue download (size limit for raw video is 50GB)
                    if (row.raw_video === 1) {
                        return;
                    } else {
                        // check if containerized file is too large (duration > 30min)
                        const options = [
                            "-v", "error", "-show_entries",
                            "format=duration", "-of",
                            "default=noprint_wrappers=1:nokey=1",
                            chunkFile
                        ];
                        const child = spawn("ffprobe", options);
                        let result = "";

                        // file size limit for containerized video is 30 minutes (1800 seconds)
                        child.stdout.on("data", function(data) { result += data.toString(); });
                        child.stderr.on("data", function(data) { result += data.toString(); });
                        child.on("exit", function(code, signal) {
                            let numSeconds = parseInt(result, 10);

                            if (isNaN(numSeconds) || numSeconds > 1800) {
                                sendMessage(req.query.token, "action", "cancel", "File is too large!");

                                // remove file and the task associated with it
                                db.getTasks("file_id", identifier)
                                .then((tasks) => {
                                    return Promise.all([ db.removeTask(tasks[0].taskID), db.removeFile(identifier) ]);
                                })
                                .catch(function(err) {
                                    console.log(err);
                                });

                                res.status(400).send();
                                return;
                            }
                        });
                    }
                }
            });
        }

        // accept chunk
        res.send(status);

        if (status === "done") {
            sendMessage(req.query.token, "status", null, "Processing file...");

            concatChunks(req.query.resumableChunkNumber, identifier, original_filename, function(err, hash, path) {
                if (err)
                    console.log(err);

                db.updateFile(identifier, {file_path : path, hash : hash})
                .then(() => {
                   return db.getTasks("file_id", identifier);
                })
                .then((tasks) => {
                    if (!tasks) {
                        sendMessage(req.query.token, "action", "cancel", "Error occurred during file processing!");
                        return;
                    }
                    tasks.forEach(function(task) {
                        if (task.status === -1) {
                            db.updateTask(task.taskID, { status: 0 })
                            .then(() => {
                                let job = queue.create('process_file', {
                                    task_token: task.token
                                }).save(function(err) {
                                    if (err) throw err;
                                    console.log("job " + job.id + " saved to queue");
                                });
                                sendMessage(task.owner_id, "status", null, "File has been added to work queue!");
                            }, (reason) => {
                                console.log("failed to add task to work queue");
                            });
                        }
                    });
                })
                .catch(function(err) {
                    console.log(err);
                });
            });
        }
    });
});

// Handle status checks on chunks through Resumable.js
app.get('/upload', function(req, res){
    resumable.get(req, function(status, filename, original_filename, identifier) {
        console.log('GET', status);
        res.send((status == 'found' ? 200 : 404), status);
    });
});

app.get('/download/:hash', function(req, res) {
    db.getTask(req.params.hash).then(function(taskInfo) {
        if (!taskInfo) {
            res.send("file does not exists!");
            res.status(404).end();
        } else {
            if (taskInfo.status != 5) {
                res.send("file is not ready");
                res.status(403).end();
                res.end();
            }  else if (taskInfo.download_count >= 2) {
                db.removeTask(taskInfo.taskID).then(() => {
                    fs.unlink(taskInfo.file_path, function(err) {
                        if (err)
                            console.log(err);
                        console.log(taskInfo.taskID, " has been removed from the database");
                    });

                    res.send("download limit for this file has been exceeded");
                    res.status(403).end();
                }, (reason) => {
                    console.log(reason);
                });
            } else {
                res.download(String(taskInfo.file_path));
                db.updateTask(taskInfo.taskID, {download_count: taskInfo.download_count + 1});
            }
        }
    });
});

app.get('/resumable.js', function (req, res) {
    var fs = require('fs');
    res.setHeader("content-type", "application/javascript");
    fs.createReadStream("./resumable.js").pipe(res);
});

app.get('/frontend.js', function (req, res) {
    var fs = require('fs');
    res.setHeader("content-type", "application/javascript");
    fs.createReadStream("./frontend.js").pipe(res);
});

queue.on('job enqueue', function() {
    console.log("job saved to work queue");
}).on('job complete', function(id, result) {
    kue.Job.get(id, function(err, job){
        if (err)
            throw err;
        job.remove(function(err){
            if (err)
                throw err;
            console.log("JOB #%d DONE!", job.id);
        });
    });
});

app.listen(8080);
