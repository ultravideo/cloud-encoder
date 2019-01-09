var express = require('express');
var resumable = require('../util/resumable-node.js')('/tmp/cloud_uploads/');
var app = express();
var multipart = require('connect-multiparty');
var crypto = require('crypto');
var WebSocketServer = require('websocket').server;
var http = require('http');
var fs = require('fs');
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
    fork('./app/worker');
}

// message queue
var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});
fork("./app/socket");

// ------------------------------ INTERNAL FUNCTIONS ------------------------------

// type can be either "action" or "status"
// "action" means that server is sending the client info regarding resumablejs 
// upload (upload accept/rejected) and "status" means that server is sending 
// the client status messages
//
// { type: "action", reply: "upload" }, { type: "action", reply: "cancel" } and
// { type: "status", reply: null } are all valid action/reply pairs that the 
// client side code understand and knows how to act upon
function sendMessage(user, token, type, reply, message) {
    nrp.emit('message', {
        user: user,
        token: token,
        type: type,
        reply: reply,
        message: message
    });
}

// concat all resumable file chunks, calculate sha256 checksum
// and rename file. Return new path and file hash
function concatChunks(numChunks, identifier, filename, callback) {
    const hash       = crypto.randomBytes(64).toString('hex');
    const outFile    = "/tmp/cloud_uploads/" + hash;
    const pathPrefix = "/tmp/cloud_uploads/resumable-";
    const chunkFiles = Array.from({length: numChunks},
        (v, k) => pathPrefix + filename + "." + (k + 1));

    // This is temporary hack to support large files
    // I'll rewrite this when I have read the EventStream documentation thoroughly
    let writestream = fs.createWriteStream(outFile, { encoding: "binary" });

    const child = spawn("cat", chunkFiles);
    let stderr = "";

    child.stdout.on("data", function(data) {
        writestream.write(data);
    });
    child.stderr.on("data", function(data) {
        stderr += data.toString();
    });

    child.on("exit", function(code, signal) {
        chunkFiles.forEach(function(chunkFile) {
            fs.unlink(chunkFile, function(err) {
                // ignore errors (for now)
            });
        });

        writestream.end();
        callback(null, hash, outFile);
    });
}

// extract video stream from input file and if it exists
// check that its duration is within limits (<30min)
function checkIsVideoFile(inputFile) {
    return new Promise((resolve, reject) => {
        const options = [
            "-v", "error", "-show_entries",
            "format=duration", "-of",
            "default=noprint_wrappers=1:nokey=1",
            inputFile
        ];
        const child = spawn("ffprobe", options);
        let result = "";

        // file size limit for containerized video is 30 minutes (1800 seconds)
        child.stdout.on("data", function(data) { result += data.toString(); });
        child.stderr.on("data", function(data) { result += data.toString(); });

        child.on("exit", function(code, signal) {
            let numSeconds = parseInt(result, 10);

            if (isNaN(numSeconds)) {
                reject(new Error("Failed to extract duration, file rejected"));
            } else if (numSeconds > 1800) {
                reject(new Error("File is too big!"));
            } else {
                resolve();
            }
        });
    });
}

function checkFileValidity(identifier, chunkFile) {
    return new Promise((resolve, reject) => {
        db.getFile(identifier).then(function(row) {
            // this file hasn't been approved, terminate download
            if (!row) {
                reject(new Error("File hasn't been approved!"));
            } else {
                // raw video, continue download (size limit for raw video is 50GB)
                if (row.raw_video === 1) {
                    resolve();
                } else {
                    checkIsVideoFile(chunkFile).then(() => {
                        resolve();
                    })
                    .catch(function(err) {
                        db.getTasks("file_id", identifier).then((tasks) => {
                            reject(err);
                            return Promise.all([ db.removeTask(tasks[0].taskID), db.removeFile(identifier) ]);
                        })
                        .catch(function(err) {
                            reject(err);
                            console.log(err);
                        });
                    });
                }
            }
        });
    });
}

// update every task in database having file_id identifier and
// inform user about the change in status (-1 -> -2)
function updateFileStatusToPreprocessing(identifier) {
    return new Promise((resolve, reject) => {
        db.getTasks("file_id", identifier).then((rows) => {
            for (let i = 0; i < rows.length; ++i) {
                db.updateTask(rows[i].taskID, { status: -2 }).then(() => {
                    if (i + 1 == rows.length) {
                        resolve();
                    }

                    nrp.emit('message', {
                        user: rows[i].owner_id,
                        file_id: rows[i].file_id,
                        token: rows[i].token,
                        type: "action",
                        reply: "taskUpdate",
                        status: -2,
                        message: "Preprocessing file"
                    });

                    i++;
                })
                .catch(function(err) {
                    reject(err);
                });
            }
        })
        .catch(function(err) {
            reject(err);
        });
    });
}

// concatenate chunks, 
function processUploadedFile(req, identifier, original_filename) {
    return new Promise((resolve, reject) => {
        concatChunks(req.query.resumableChunkNumber, identifier, original_filename, function(err, hash, path) {
            if (err)
                reject(err);

            db.updateFile(identifier, { file_path : path, hash : hash }).then(() => {
               return db.getTasks("file_id", identifier);
            })
            .then((tasks) => {
                if (!tasks) {
                    sendMessage(req.query.token, identifier, "action", "cancel", "Error occurred during file processing!");
                    return;
                }
                tasks.forEach(function(task) {
                    if (task.status === -2) {
                        db.updateTask(task.taskID, { status: 0 }).then(() => {
                            let job = queue.create('process_file', {
                                task_token: task.token
                            }).save(function(err) {
                                if (err)
                                    reject(err);
                                resolve();
                            });
                        }, (reason) => {
                            reject(reason);
                        });
                    }
                });
            })
            .catch(function(err) {
                reject(err);
            });
        });
    })
}


// Host most stuff in the public folder
app.use(express.static(__dirname + '/../public'));
app.use(multipart());

// Handle uploads through Resumable.js
app.post('/upload', function(req, res) {
    resumable.post(req, function(status, filename, original_filename, identifier) {
        const chunkFile  = "/tmp/cloud_uploads/resumable-" + original_filename + "." + req.query.resumableChunkNumber;

        // file too large (>50GB), inform user, terminate upload and clean database
        if (req.query.resumableChunkNumber * req.query.resumableChunkSize > 50 * 1000 * 1000 * 1000) {
            sendMessage(req.query.token, identifier, "action", "cancel", "File is too large");
            db.getTasks("file_id", identifier)
            .then((tasks) => {
                return Promise.all([ db.removeTask(tasks[0].taskID), db.removeFile(identifier) ]);
            })
            .catch(function(err) {
                console.log(err);
            });

            res.status(400).end();
            return;
        } else if (req.query.resumableChunkNumber == 1) {
            res.send(status);
            sendMessage(req.query.token, identifier, "action", "pause", null);

            checkFileValidity(identifier, chunkFile).then(() => {
                sendMessage(req.query.token, identifier, "action", "continue", null);

                if (status !== "done") {
                    console.log("continue uploading......");
                    return;
                }

                // input file was smaller than one chunk (1MB), it must be processes 
                // explicitly here
                //
                // first update the status from upload to preprocessing so that
                // connection can be closed without wreacking havoc with other requests
                // db.updateTasks(identifier, { status: -3  }).then(() => {
                updateFileStatusToPreprocessing(identifier).then(() => {
                    return processUploadedFile(req, identifier, original_filename);
                })
                .catch(function(err) {
                    sendMessage(req.query.token, identifier, "status", null, err.toString());
                    console.log(err);
                });
            })
            .catch(function(err) {
                sendMessage(req.query.token, identifier, "action", "cancel", err.toString());
                res.status(400).send();
                return;
            });

        } else if (status === "done") {
            res.send(status);

                updateFileStatusToPreprocessing(identifier).then(() => {
                    return processUploadedFile(req, identifier, original_filename);
                })
                .catch(function(err) {
                    sendMessage(req.query.token, identifier, "status", null, err.toString());
                    console.log(err);
                });
        } else {
            res.send(status);
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
            if (taskInfo.status != 4) {
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
                res.download(String(taskInfo.file_path), function(err) {
                    if (err) {
                        console.log(err);
                    }
                    db.updateTask(taskInfo.taskID, { download_count: taskInfo.download_count + 1 });
                });
            }
        }
    });
});

app.get('/resumable.js', function (req, res) {
    var fs = require('fs');
    res.setHeader("content-type", "application/javascript");
    fs.createReadStream("./util/resumable.js").pipe(res);
});

app.get('/frontend.js', function (req, res) {
    var fs = require('fs');
    res.setHeader("content-type", "application/javascript");
    fs.createReadStream("./public/frontend.js").pipe(res);
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
