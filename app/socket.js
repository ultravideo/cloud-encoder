let WebSocket = require("ws");
let fs = require("fs");
let db = require("./db");
let parser = require("./parser");
let crypto = require('crypto');
let kue = require('kue');
var NRP = require('node-redis-pubsub');
const workerStatus = require("./constants");

var queue = kue.createQueue({
    redis: {
        port: 7776,
        host: "127.0.0.1"
    }
});

class Clients {
    constructor() {
        this.clientList = {};
        this.saveClient = this.saveClient.bind(this);
    }

    saveClient(token, socket) {
        this.clientList[token] = socket;
    }
}

const clients = new Clients();
const socket  = new WebSocket.Server({ port: 8083 });

// --------------- message queue stuff start ---------------
var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});

nrp.on("message", function(msg) {
    if (clients.clientList[msg.user]) {
        if (clients.clientList[msg.user] && clients.clientList[msg.user].readyState === 1) {
            clients.clientList[msg.user].send(JSON.stringify(msg));
        }
    }
});

// --------------- message queue stuff end --------------- 


// --------------- socket stuff start --------------- 

function getUserTokenBySocket(socket) {
    return new Promise((resolve, reject) => {
        for (let key in clients.clientList) {
            if (clients.clientList[key] === socket) {
                resolve(key);
            }
        }
        reject(new Error("Can't find client's user token"));
    });
}

function removeChunks(file_id) {
    fs.readdirSync("/tmp/cloud_uploads/").forEach(function(file) {
        if (file.includes(file_id)) {
            fs.unlink("/tmp/cloud_uploads/" + file, function(err) {
                if (err)
                    console.log(err);
            });
        }
    });
}

socket.on('connection', function(client) {
    client.on('message', function(msg) {
        try {
            var message = JSON.parse(msg);
        } catch (err) {
            console.log("failed to parse client message: ", err);
            return;
        }

        if (message.type === "init") {
            if (message.token) {
                parser.validateUserToken(message.token).then((validatedToken) => {

                    if (clients.clientList.hasOwnProperty(validatedToken)) {
                        clients.clientList[validatedToken] = client;
                    } else {
                        clients.saveClient(validatedToken, client);
                    }

                    console.log(validatedToken, "connected!");

                    // if (clients.clientList.hasOwnProperty(validatedToken)) {
                    // }
                    // clients.clientList[validatedToken] = client;
                    // console.log("user", message.token, "has connected!");
                })
                .catch(function(err) {
                    console.log(err);
                });
            }

        } else if (message.type === "reinit") {
            parser.validateUserToken(message.token).then((validatedToken) => {
                console.log("reiniting connection for ", message.token);
                clients.clientList[validatedToken] = client;
            })
            .catch(function(err) {
                console.log(err);
            });

        } else if (message.type === "downloadRequest") {
            handleDownloadRequest(client, message.token);

        } else if (message.type === "deleteRequest") {
            handleDeleteRequest(client, message.token);

        } else if (message.type === "cancelRequest") {
            handleCancelRequest(client, message.token);

        } else if (message.type === "taskQuery") {
            handleTaskRequest(client, message);

        } else if (message.type === "cancelInfo") {
            handleUploadCancellation(client, message);

        } else if (message.type === "uploadRequest") {
            handleUploadRequest(client, message);
            
        }
    });

    client.on('close', function(connection) {
        getUserTokenBySocket(client).then((key) => {
            // terminate ongoing download if such exists and remove user from client array
            terminateOngoingUpload(key);
            delete clients.clientList[key];
        })
        .catch(function(err) {
            // NOTE: client may no longer be in the array
            // (gc may have cleaned it) so ignore error
        });
    });
});


// --------------- socket stuff end --------------- 

// file options require validation only if the input file is raw video
// For raw video, resolution, bit depth and fps are validated and if
// all validations pass, function returns validated options
function validateFileOptions(fileOptions) {
    return new Promise((resolve, reject) => {
        let validatedOptions = {
            resolution: 0,
            raw_video: 0,
            bit_depth: 0,
            fps: 0,
            uniq_id: fileOptions.file_id,
            name: fileOptions.name
        };

        if (fileOptions.raw_video === "on") {
            Promise.all([
                parser.validateInputFPS(fileOptions.inputFPS),
                parser.validateBithDepth(fileOptions.bitDepth),
                parser.validateResolution(fileOptions.resolution)
            ]).then((validated) => {

                validatedOptions.fps        = validated[0];
                validatedOptions.bit_depth  = validated[1];
                validatedOptions.resolution = validated[2];
                validatedOptions.raw_video  = 1;

                resolve(validatedOptions);
            })
            .catch(function(err) {
                reject(err);
            });
        } else {
            resolve(validatedOptions);
        }
    });
}

// Kvazaar options are validated in two phases, first validated the options
// that have their own form items (right now container and preset) 
// If that validation passes, then all extra options that are given
// using textarea are validated.
//
// If both validations pass, function returns all validated options in an array
function validateKvazaarOptions(kvazaarOptions, kvazaarExtraOptions) {

    const PRESETS = [
        "placebo", "veryslow", "slower", "slow", "medium",
        "fast", "faster", "veryfast","superfast", "ultrafast",
    ];

    return new Promise((resolve, reject) => {
        if (kvazaarOptions.preset < 1 || kvazaarOptions.preset > 10) {
            reject(new Error("Invalid preset!"));
        }

        if (kvazaarOptions.container != "none" && kvazaarOptions.container != "mp4" &&
            kvazaarOptions.container != "mkv") {
            reject(new Error("Invalid container!"));
        }

        const SELECTED_PRESET = "preset " + PRESETS[kvazaarOptions.preset - 1];
        delete kvazaarOptions["preset"];

        if (kvazaarExtraOptions && kvazaarExtraOptions.length > 0) {
            parser.validateKvazaarOptions(kvazaarExtraOptions).then((validatedExtraOptions) => {
                let sortedOps = validatedExtraOptions.sort(validatedExtraOptions);
                sortedOps.unshift(SELECTED_PRESET);

                kvazaarOptions.hash = crypto.createHash("sha256").update(sortedOps.join()).digest("hex");

                resolve([kvazaarOptions, sortedOps]);
            })
            .catch(function(err) {
                reject(err);
            });
        } else {
            kvazaarOptions.hash = crypto.createHash("sha256").update(SELECTED_PRESET).digest("hex");
            resolve([kvazaarOptions, SELECTED_PRESET]);
        }
    });
}

// check if the requested file is available
// NOTE: these response messagse use incorrectly the misc field
// TODO: create *CLEAR* spec for client<->server messages and freeze the spec
function handleDownloadRequest(client, token) {
    db.getTask(token).then(function(taskInfo) {
        if (!taskInfo) {
            client.send(JSON.stringify({
                type: "action",
                reply: "downloadResponse",
                status: "deleted",
        }));
        } else {
            if (taskInfo.status != workerStatus.READY) {
                client.send(JSON.stringify({
                    type: "action",
                    reply: "downloadResponse",
                    status: "rejected",
                    message: "File is not ready!"
                }));
            }  else if (taskInfo.download_count >= 2) {
                console.log("download count exceeded");
                client.send(JSON.stringify({
                    type: "action",
                    reply: "downloadResponse",
                    status: "exceeded",
                    message:  "File download limit has been exceeded!",
                    token: taskInfo.token,
                }));

                // remove task and associated file
                db.removeTask(taskInfo.taskID).then(() => {
                    fs.unlink(taskInfo.file_path, function(err) {
                        console.log(taskInfo.taskID, " has been removed from the database");
                    });
                }, (reason) => {
                    console.log(reason);
                });
            } else {
                client.send(JSON.stringify({
                    type: "action",
                    reply: "downloadResponse",
                    status: "accepted",
                    token: token,
                    count: taskInfo.download_count + 1,
                }));
            }
        }
    });
}

// use both user token and task token to ensure that this user 
// really owns the task he/she is requesting the delete
function handleDeleteRequest(client, token) {
    getUserTokenBySocket(client).then((key) => {
        db.getTask(token).then((row) => {

            // "authentication" failure
            if (!row || row.owner_id !== key) {
                client.send(JSON.stringify({
                    type: "action",
                    reply: "deleteResponse",
                    status: "nok",
                }));

                return;
            }

            db.removeTask(token).then(() => {
                console.log("task delete succeeded!");
                client.send(JSON.stringify({
                    type: "action",
                    reply: "deleteResponse",
                    status: "ok",
                    file_id: row.file_id,
                    token: row.token
                }));
            })
        })
    })
    .catch(function(err) {
        console.log(err);
    });
}

// user clicked "My requests" tab and queried all tasks
function handleTaskRequest(client, message) {
    db.getTasks("owner_id", message.user).then((rows) => {
        if (!rows || rows.length === 0) {
            client.send(JSON.stringify({
                type: "action",
                reply: "taskResponse",
                numTasks: 0,
            }));
            return;
        }

        let message = {
            type: "action",
            reply: "taskResponse",
            numTasks: rows.length,
            data: [],
        };

        rows.forEach(function(taskRow) {

            Promise.all([
                db.getFile(taskRow.file_id),
                db.getOptions(taskRow.ops_id)
            ]).then((values) => {
                let msg = "Done";
                switch (taskRow.status) {
                    case workerStatus.CANCELLED:      msg = "Request cancelled";  break;
                    case workerStatus.FAILURE:        msg = "Request failed!";    break;
                    case workerStatus.PREPROCESSING:  msg = "Preprocessing file"; break;
                    case workerStatus.UPLOADING:      msg = "Uploading file";     break;
                    case workerStatus.WAITING:        msg = "Queued";             break;
                    case workerStatus.DECODING:       msg = "Decoding";           break;
                    case workerStatus.ENCODING:       msg = "Encoding";           break;
                    case workerStatus.POSTPROCESSING: msg = "Post-processing";    break;
                }

                const kvazaarOps = {
                    "Container": values[1]["container"],
                    "Options":   values[1]["extra"]
                };

                message.data.push({
                    name: values[0] ? values[0].name : "Error",
                    uniq_id: taskRow.file_id,
                    status: taskRow.status,
                    message: msg,
                    download_count: taskRow.download_count,
                    token: taskRow.token,
                    options: kvazaarOps
                });

                client.send(JSON.stringify(message));
            });
        });
    });
}   

// user cancelled the file upload, remove task AND file from database
// and remove all chunks files
function handleUploadCancellation(client, message) {
    db.getTask(message.token).then((taskRow) => {
        if (!taskRow) {
            console.log(message.token, " doesn't exist!");
            return;
        }

        // remove all uploaded chunk files, task and file records
        removeChunks(taskRow.file_id);

        // update all other tasks that depend on this (cancelled) file
        // their state is now failed and user must re-submit the request
        let promisesToResolve = [ 
            db.removeTask(message.token),
            db.removeFile(taskRow.file_id)
        ];

        db.getTasks("file_id", taskRow.file_id).then((rows) => {
            rows.forEach(function(row) {
                if (row.token != message.token) {
                    promisesToResolve.push(
                        db.updateTask(row.taskID, { status: workerStatus.FAILURE })
                    );
                }
            });
        })
        .catch(function(err) {
            console.log(err);
        });

        return Promise.all(promisesToResolve);
    })
    .catch(function(err) {
        console.log(err);
    });
}

function handleCancelRequest(client, token) {
    // TODO check if task is still in the queue
    // TODO if it is -> remove and update database
    // TODO if not -> find out who is working on it
    // TODO needs supervisor???
}

// first validate file and kvazaar options. If validation is OK,
// query database to make sure that user hasn't already made this request
// (this file and these options).
//
// If this is unique request, save file and options info to database and create task
// for this request. Then inform the frontend that upload can be started
//
//
// If at any point error is encoutered (invalid options, request already made etc.)
// file upload is rejected and user is informed about this
function handleUploadRequest(client, message) {
    let validatedKvazaarPromise = validateKvazaarOptions(message.kvazaar, message.kvazaar_extra);
    let validatedFilePromise = validateFileOptions(message.other);

    // first validated both kvazaar options and file info
    Promise.all([validatedKvazaarPromise, validatedFilePromise]).then(function(values) {
        let kvazaarPromise = db.getOptions(values[0][0].hash);
        let filePromise = db.getFile(values[1].uniq_id);
        let taskPromise = db.getTask(message.token, values[1].uniq_id, values[0][0].hash);

        // data validation ok, check if database already has these values
        Promise.all([kvazaarPromise, filePromise, taskPromise]).then((data) => {
            // return both database response and validated options
            return {
                options: {
                    kvazaar: values[0],
                    file: values[1],
                    task: {
                        token: message.token
                    },
                },
                db: {
                    kvazaar: data[0],
                    file: data[1],
                    task: data[2]
                }
            };
        })
        .then((data) => {
            // now check what info has already been stored. Save all insert queries 
            // to promisesToResolve array which is then executed with Promise.all. 
            // We can execute all queries at once because the insert queries 
            // dont depend on each other
            const token = crypto.randomBytes(64).toString('hex');
            let promisesToResolve = [ ];
            let uploadApproved = false;
            let requestApproved = false;
            let message = "";

            // this combination of options doesn't exist in the database
            if (!data.db.kvazaar) {
                promisesToResolve.push(
                    db.insertOptions({
                        container: data.options.kvazaar[0].container,
                        hash: data.options.kvazaar[0].hash,
                        extra: data.options.kvazaar[1]
                    })
                );
            }

            // file doesn't exist in the database
            if (!data.db.file) {
                promisesToResolve.push(
                    db.insertFile({
                        name: data.options.file.name,
                        resolution: data.options.file.resolution,
                        raw_video: data.options.file.raw_video,
                        fps: data.options.file.fps,
                        bit_depth: data.options.file.bit_depth,
                        uniq_id: data.options.file.uniq_id
                    })
                );
            }

            // user has already made this request
            if (data.db.task) {
                message = "Upload rejected (file already on the server), file already in the work queue. ";
            } else {
                // new (unique) request from user
                requestApproved = true;
                message = "Upload rejected (file already on the server), " +
                          "file has been added to work queue. ";

                // it's very rare but possible that user A is uploading file abc.mp4 and user B
                // tries to do the same file. We must check what is status of file abc.mp4 before
                // inserting new data task data to db
                //
                // This can be checked easily because files that are not ready have their file_path set to NULL
                let status = workerStatus.UPLOADING;

                if (data.db.file) {
                    status = workerStatus.WAITING;

                    // file_path is not null (file upload is not in progress),
                    // add task to work queue right away
                    if (data.db.file.file_path !== null) {
                        let job = queue.create('process_file', {
                            task_token: token
                        })
                        .save(function(err) {
                            if (err) {
                                console.log("err", err);
                            }
                            console.log("job " + job.id + " saved to queue");
                        });
                    }
                } else {
                    uploadApproved = true;

                    message = "Starting file upload...\n";
                    console.log("upload approved!");
                }

                promisesToResolve.push(
                    db.insertTask({
                        status: status,
                        owner_id: data.options.task.token, // saved so that worker can send messages to this user
                        token: token, // used for the download link
                        ops_id: data.options.kvazaar[0].hash,
                        file_id: data.options.file.uniq_id,
                    })
                );
            }

            Promise.all(promisesToResolve).then(() => {
                return {
                    approved: uploadApproved,
                    message: message
                };
            })
            .then((uploadInfo) => {
                client.send(
                    JSON.stringify({
                        type: "action",
                        reply: "uploadResponse",
                        status: uploadApproved ? "upload" : requestApproved ? "request_ok" : "request_nok",
                        token: token,
                        message: uploadInfo.message
                    })
                );
            })
            .catch(function(err) {
                client.send(
                    JSON.stringify({
                        type: "action",
                        token: data.options.file.uniq_id,
                        reply: "cancel",
                        message: "Error, try again later"
                    })
                );
                console.log("Something failed with database", err);
                return;
            });
        })
    }).catch(function(err) {
        client.send(
            JSON.stringify({
                type: "action",
                reply: "cancel",
                message: err.toString()
            })
        );
        return;
    });
}

function terminateOngoingUpload(key) {
    db.getTasks("owner_id", key).then((rows) => {
        rows.forEach(row => {
            // file upload ongoing
            if (rows.status == workerStatus.UPLOADING) {
                // file can be removed because the upload was approved
                // (ie the server didn't have the file before upload)
                //
                // TODO this approach has one problem that'll be addresses in the near future
                let promises = [
                    db.removeTask(row.taskID),
                    db.removeFile(row.file_id)
                ];

                Promise.all(promises).then(() => {
                    removeChunks(row.file_id);
                })
                .catch(function(err) {
                    console.log(err);
                });
            }
        });
    });
}
