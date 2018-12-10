let WebSocket = require("ws");
let fs = require("fs");
let db = require("./db");
let crypto = require('crypto');
let kue = require('kue');
var NRP = require('node-redis-pubsub');
let sleep = require("sleep");

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
        } else if (message.type === "options") {
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
                    let message = "";

                    // make sure connected user hasn't already done this request
                    if (!data.db.task ||
                        data.db.task.file_id != data.options.file.uniq_id ||
                        data.db.task.ops_id  != data.options.kvazaar.hash)
                    {
                        message =  "Upload rejected (file already on the server), " + 
                                   "file has been added to work queue\n";

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
                                if (err)
                                    throw err;
                                console.log("job " + job.id + " saved to queue");
                            });
                        }
                    } else {
                        message = "Upload rejected (file already on the server), file already in the work queue";
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
                                resolution: data.options.file.resolution,
                                raw_video: data.options.file.raw_video,
                                uniq_id: data.options.file.uniq_id
                            })
                        );
                    }

                    Promise.all(promisesToResolve).then(() => {
                        return {
                            approved: uploadApproved,
                            message: message + makeDownloadLink(token)
                        };
                    })
                    .then((uploadInfo) => {
                        client.send(
                            JSON.stringify({
                                type: "action",
                                reply: uploadInfo.approved ? "upload" : "abort",
                                message: uploadInfo.message
                            })
                        );
                    })
                    .catch(function(err) {
                        console.log("Invalid options:", err);
                        return;
                    });
                })
            });
        }

        client.on('close', function(connection) {
            for (let key in clients.clientList) {
                if (clients.clientList[key] === client) {
                    console.log(key, "disconnected!");

                    delete clients.clientList[key];
                    break;
                }
            }
        })
    });
});
// --------------- socket stuff end --------------- 

function validateFileOptions(fileOptions) {
    return new Promise((resolve, reject) => {
        let validatedOptions = {
            resolution: 0,
            raw_video: 0,
            uniq_id: fileOptions.file_id
        };

        if (fileOptions.resolution !== "") {
            let res = fileOptions.resolution.match(/[0-9]{1,4}\x[0-9]{1,4}/g);
            if (!res) {
                reject(new Error("Invalid resolution!"));
            }

            validatedOptions["resolution"] = res[0];
            validatedOptions["raw_video"]  = 1;
        }

        resolve(validatedOptions);
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
                    reject(new Error("Invalid kvazaar options!"));
            } else {
                reject(new Error("Invalid kvazaar options!"));
            }
        }

        const ops = JSON.stringify(kvazaarOptions);
        const hash = crypto.createHash("sha256").update(ops);
        kvazaarOptions['hash'] = hash.digest("hex");

        resolve(kvazaarOptions);
    });
}

function makeDownloadLink(token) {
    const downloadLink = '<a href=\"http://localhost:8080/download/' + token + '\">this link</a>';
    const msg = "You can use " + downloadLink + " to download the file when it's ready";

    return msg;
}
