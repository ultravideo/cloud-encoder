let WebSocket = require("ws");
let fs = require("fs");
let db = require("./db");
let parser = require("./parser");
let crypto = require('crypto');
let kue = require('kue');
var NRP = require('node-redis-pubsub');

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
        if (clients.clientList[msg.user]) {
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
                clients.saveClient(message.token, client);
                console.log("user", message.token, "has connected!");
            }

        } else if (message.type === "downloadRequest") {
            handleDownloadRequest(client, message.token);

        } else if (message.type === "deleteRequest") {
            handleDeleteRequest(client, message.token);
        } else if (message.type === "cancelRequest") {
            // TODO
        } else if (message.type === "taskQuery") {
            handleTaskRequest(client, message);

            // TODO rename to handleUploadRequst
        } else if (message.type === "uploadRequest") {
            let validatedKvazaarPromise = validateKvazaarOptions(message.kvazaar);
            let validatedFilePromise = validateFileOptions(message.other);

            // first validated both kvazaar options and file info
            Promise.all([validatedKvazaarPromise, validatedFilePromise]).then(function(values) {
                let kvazaarPromise = db.getOptions(values[0].hash);
                let filePromise = db.getFile(values[1].uniq_id);
                let taskPromise = db.getTask(message.token, values[1].uniq_id, values[0].hash);

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

                    // make sure connected user hasn't already done this request
                    if (!data.db.task ||
                        data.db.task.file_id != data.options.file.uniq_id ||
                        data.db.task.ops_id  != data.options.kvazaar.hash)
                    {
                        requestApproved = true;
                        message =  "Upload rejected (file already on the server), " + 
                                   "file has been added to work queue. ";

                        promisesToResolve.push(
                            db.insertTask({
                                status: -1, // upload hasn't started
                                owner_id: data.options.task.token, // saved so that worker can send messages to this user
                                token: token, // used for the download link
                                ops_id: data.options.kvazaar.hash,
                                file_id: data.options.file.uniq_id,
                            })
                        );

                        // enqueue task to kue's work queue if file is already on the server
                        if (data.db.file) {
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
                        message = "Upload rejected (file already on the server), file already in the work queue. ";
                        // TODO send token and create download button
                    }

                    // this combination of options doesn't exist in the database
                    if (!data.db.kvazaar) {
                        promisesToResolve.push(
                            db.insertOptions({
                                preset: data.options.kvazaar.preset,
                                container: data.options.kvazaar.container,
                                hash: data.options.kvazaar.hash
                            })
                        );
                    }

                    // file doesn't exist in the database
                    if (!data.db.file) {
                        uploadApproved = true;
                        message = "Starting file upload...\n";

                        promisesToResolve.push(
                            db.insertFile({
                                name: data.options.file.name,
                                resolution: data.options.file.resolution,
                                raw_video: data.options.file.raw_video,
                                uniq_id: data.options.file.uniq_id
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
                        console.log("uniq id", data.options.file.uniq_id);
                        client.send(
                            JSON.stringify({
                                type: "action",
                                reply: "uploadResponse",
                                status: uploadApproved ? "upload" : requestApproved ? "request_ok" : "request_nok",
                                token: data.options.file.uniq_id,
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
                        token: message.other.file_id,
                        reply: "cancel",
                        message: err.toString()
                    })
                );
                return;
            });
        }

        client.on('close', function(connection) {
            getUserTokenBySocket(connection).then((key) => {
                console.log(key, "disconnected!");
                delete clients.clientList[key];
            })
            .catch(function(err) {
                console.log(err);
            });
        })
    });
});


// --------------- socket stuff end --------------- 

function validateFileOptions(fileOptions) {
    return new Promise((resolve, reject) => {
        let validatedOptions = {
            resolution: 0,
            raw_video: 0,
            uniq_id: fileOptions.file_id,
            name: fileOptions.name
        };

        if (fileOptions.resolution !== "" && fileOptions.raw_video === "on") {
            parser.validateResolution(fileOptions.resolution).then((resolution) => {
                validatedOptions["resolution"] = resolution;
                validatedOptions["raw_video"]  = 1;
                resolve(validatedOptions);
            }, (reason) => {
                reject(reason);
            });
        } else {
            resolve(validatedOptions);
        }
    });
}

function validateKvazaarOptions(kvazaarOptions) {

    const validOptions = {
        'preset' : ["ultrafast", "superfast", "medium", "placebo"],
        'container' : ["none", "mp4", "mkv"],
    };

    return new Promise((resolve, reject) => {
        for (let key in kvazaarOptions) {
            if (validOptions.hasOwnProperty(key)) {
                if (validOptions[key].indexOf(kvazaarOptions[key]) === -1)
                    reject(new Error("Invalid Kvazaar options!"));
            } else {
                reject(new Error("Invalid Kvazaar options!"));
            }
        }

        const ops = JSON.stringify(kvazaarOptions);
        const hash = crypto.createHash("sha256").update(ops);
        kvazaarOptions['hash'] = hash.digest("hex");

        resolve(kvazaarOptions);
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
            if (taskInfo.status != 4) {
                client.send(JSON.stringify({
                    type: "action",
                    reply: "downloadResponse",
                    status: "rejected",
                    misc: "File is not ready!"
                }));
            }  else if (taskInfo.download_count >= 2) {
                client.send(JSON.stringify({
                    type: "action",
                    reply: "downloadResponse",
                    status: "exceeded",
                    misc:  "File download limit has been exceeded!",
                    file_id: taskInfo.file_id,
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
                    file_id: taskInfo.file_id,
                    count: taskInfo.download_count + 1,
                    misc: token
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
                    file_id: row.file_id
                }));
            })
        })
    })
    .catch(function(err) {
        console.log(err);
    });
}

function handleTaskRequest(client, message) {
    // TODO make sure this is safe!!!
    // TODO make sure this is safe!!!
    // TODO make sure this is safe!!!
    // TODO make sure this is safe!!!
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
            db.getFile(taskRow.file_id).then((fileRow) => {

                let msg = "Done";
                switch (taskRow.status) {
                    case -3:  msg = "Request cancelled"; break;
                    case -2:  msg = "Request failed!";   break;
                    case -1:  msg = "Uploading file";    break;
                    case  0:  msg = "Queued";            break;
                    case  1:  msg = "Decoding";          break;
                    case  2:  msg = "Encoding";          break;
                    case  3:  msg = "Post-processing";   break;
                }

                message.data.push({
                    name: fileRow.name,
                    uniq_id: taskRow.file_id,
                    status: taskRow.status,
                    message: msg,
                    download_count: taskRow.download_count,
                    token: taskRow.token
                });

                client.send(JSON.stringify(message));
            });
        });

    });
}
