var express = require('express');
var resumable = require('../util/resumable-node.js')('/tmp/cloud_uploads/');
var app = express();
var multipart = require('connect-multiparty');
var crypto = require('crypto');
var fs = require('fs');
var kue = require('kue');
var db = require('./db');
var ffprobe = require('ffprobe');
var ffprobeStatic = require('ffprobe-static');
var NRP = require('node-redis-pubsub');
var redis_client = require('redis').createClient(7776);
const { fork, spawn } = require('child_process');
const constants = require("./constants");

// store kue's job id to redis so we can cancel tasks in constant time
redis_client.on('connect', function() {
    console.log('connected');
});

// worker queue
var queue = kue.createQueue({
    redis: {
        port: 7776,
        host: "127.0.0.1"
    }
});

for (var i = 0; i < constants.NUMBER_OF_WORKER_THREADS; ++i) {
    console.log("forked!");
    fork('./app/worker');
}

// message queue
var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});

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
        type: type,
        reply: reply,
        data: {
            user: user,
            token: token,
            message: message
        }
    });
}

function sendStatusMessage(user, file_id, token, type, reply, status, message) {
    nrp.emit('message', {
        type: type,
        reply: reply,
        data: {
            user: user,
            file_id: file_id,
            token: token,
            status: status,
            message: message
        }
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
        ffprobe(inputFile, { path: ffprobeStatic.path })
            .then((video_info) => {
                var videoStream = -1;
                for(var i = 0; i < video_info.streams.length; i++) {
                    if(video_info.streams[i].codec_type === "video") {
                        videoStream = i;
                        break;
                    }
                }
                
                // No video stream?
                if(videoStream === -1) {
                    reject("Error: No video track detected!");
                }

                // MKV does not contain the duration inside the stream, it's in tags.DURATION HH:MM:SS.sss format
                let numSeconds = 0;
                if(video_info.streams+1 >= videoStream) numSeconds = parseInt(video_info.streams[videoStream].duration);
                if(isNaN(numSeconds)
                   && video_info.streams.length > 0
                   && video_info.streams[videoStream].tags
                   && typeof video_info.streams[videoStream].tags.DURATION === "string") { 
                    var splitTime =  video_info.streams[videoStream].tags.DURATION.split(":");
                    if(splitTime.length == 3) {
                        numSeconds = parseInt(splitTime[0])*60*60 +  parseInt(splitTime[1])*60 +  parseInt(splitTime[2]);
                    }                    
                }
                
                if (isNaN(numSeconds)) {
                    console.log("Video duration extraction failed: "+video_info.streams[videoStream]);
                    // Default to allowing the input
                    resolve();
                    //reject(new Error("Failed to extract duration, file rejected. Maybe the input file wasn't a video file, it didn't contain duration field or it was raw video)"));
                } else if (numSeconds > constants.FILE_TIME_LIMIT_IN_SECONDS) {
                    console.log("Rejected too long file, "+numSeconds.toString()+"s");
                    reject(new Error("File is too big!"));
                } else {
                    resolve();
                }
            })
            .catch(function(err) {
               console.log(err);
               reject(err);
            });
    });
}

// make sure uploaded file is video and that it's duration is <= 30min
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

                            let promises = [ db.removeFile(identifier) ];

                            if (tasks[0])
                                promises.push(db.removeTask(tasks[0].taskid));
                            return Promise.all(promises);
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
                db.updateTask(rows[i].taskid, { status: constants.PREPROCESSING }).then(() => {
                    if (i + 1 == rows.length) {
                        resolve();
                    }

                    sendStatusMessage(rows[i].owner_id, rows[i].file_id,
                                      rows[i].token, "update", "task",
                                      constants.PREPROCESSING, "Preprocessing file");

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

// after the file upload has completed, we must concatenate the chunks, update tasks's status to WAITING
// and inform user about this change in state.
function processUploadedFile(req,res, identifier, original_filename) {
    return new Promise((resolve, reject) => {
        concatChunks(req.query.resumableChunkNumber, identifier, original_filename, function(err, hash, path) {
            if (err)
                reject(err);
              
            // checkFileValidity rejects promise if the file is invalid
            checkFileValidity(identifier, path).then(() => {            

                db.updateFile(identifier, { file_path : path, hash : hash }).then(() => {
                   return db.getTasks("file_id", identifier);
                })
                .then((tasks) => {
                    if (!tasks) {
                        sendMessage(req.query.token, identifier, "action", "cancel", "Error occurred during file processing!");
                        return;
                    }
                    tasks.forEach(function(task) {
                        if (task.status === constants.PREPROCESSING) {
                            db.updateTask(task.taskid, { status: constants.WAITING }).then(() => {

                                sendStatusMessage(task.owner_id, task.file_id, task.token, "update",
                                                  "task", constants.WAITING, "Queued");

                                let job = queue.create('process_file', {
                                    task_token: task.token
                                })
                                .save(function(err) {
                                    if (err)
                                        console.log("err", err);

                                    redis_client.set(task.token, job.id);
                                    console.log("server: job " + job.id + " saved to queue");
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
            })
            .catch(function(err) {
                sendMessage(req.query.token, identifier, "action", "cancel", err.toString());
                res.status(400).send();
                return;
            });
        });
    })
}


// Host most stuff in the public folder
app.use(express.static(__dirname + '/../public', { dotfiles: 'allow' }));
app.use(multipart());

// Handle uploads through Resumable.js
app.post('/upload', function(req, res) {
    resumable.post(req, function(status, filename, original_filename, identifier) {
        const chunkFile  = "/tmp/cloud_uploads/resumable-" + original_filename + "." + req.query.resumableChunkNumber;

        // file too large (>50GB), inform user, terminate upload and clean database
        if (req.query.resumableChunkNumber * req.query.resumableChunkSize > constants.FILE_SIZE_LIMIT_IN_BYTES) {
            sendMessage(req.query.token, identifier, "action", "cancel", "File is too large");
            db.getTasks("file_id", identifier)
            .then((tasks) => {
                return Promise.all([ db.removeTask(tasks[0].taskid), db.removeFile(identifier) ]);
            })
            .catch(function(err) {
                console.log(err);
            });

            res.status(400).end();
            return;
        } else if (status === "done") {
            res.send(status);
            
            // first update the status from upload to preprocessing so that
            // connection can be closed without wreacking havoc with other requests
            // db.updateTasks(identifier, { status: -3  }).then(() => {
            updateFileStatusToPreprocessing(identifier).then(() => {
                return processUploadedFile(req,res, identifier, original_filename);
            })
            .catch(function(err) {
                console.log("sending error message her!");
                sendMessage(req.query.token, identifier, "action", "cancel", err.toString());
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
            if (taskInfo.status != constants.READY) {
                res.send("file is not ready");
                res.status(403).end();
                res.end();
            }  else if (taskInfo.download_count >= constants.FILE_DOWNLOAD_LIMIT) {
                db.removeTask(taskInfo.taskid).then(() => {
                    fs.unlink(taskInfo.file_path, function(err) {
                        if (err)
                            console.log(err);
                        console.log(taskInfo.taskid, " has been removed from the database");
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
                    db.updateTask(taskInfo.taskid, { download_count: taskInfo.download_count + 1 });
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

module.exports = app;
