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
const { fork } = require('child_process');

var ws_conn = null;
var ws_conns = {};

var queue = kue.createQueue({
    redis: {
        port: 7776,
        host: "127.0.0.1"
    }
});

const NUM_WORKERS = 5;
for (var i = 0; i < NUM_WORKERS; ++i) {
    console.log("forked!");
    fork('./worker');
}
// fork("./socket"); // TODO

// ------------------------------ INTERNAL FUNCTIONS ------------------------------

function sendMessage(socket, _status, _type, _message) {
    const message = {
        status:  _status,
        type:    _type,
        message: _message
    };

    socket.send(JSON.stringify(message));
}

function job_enqueue(taskID, token) {
    let job = queue.create('process_file', {
        task_id: taskID,
    })
    .save(function(err) {
        if (err)
            throw err;
        console.log("job " + job.id + " saved to queue");
    });
}

// TODO comment this
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

// TODO
function validateKvazaarOptions(kvazaarOptions) {
    return new Promise((resolve, reject) => {
        console.log(kvazaarOptions);
        resolve();
    });
}

// TODO explain function and parameters
function linkOptionsAndFiles(owner, fileOptions, kvazaarHash, messageCallback) {
    const token = crypto.randomBytes(64).toString('hex');

    db.getFile(fileOptions.file_id)
    .then(function(row) {
        // add new file to database and enqueue it to task queue
        if (!row) {
            const task_params = {
                token    : token,
                owner_id : owner,
                ops_id   : kvazaarHash,
                file_id  : fileOptions.file_id,
            };

            validateFileOptions(fileOptions)
            .then((validatedFileOptions) => {
                return db.insertFile(validatedFileOptions)
            })
            // TODO TÄMÄ EI TOIMI PITKÄSSÄ JUOKSUSSA!!!!!!!
            // .then(db.insertTask(task_params))
            .then(() => {
                return db.insertTask(task_params)
            })
            .then(function() {
                const json = {
                    status : "ok",
                    type : "reply",
                    message : "Starting file upload..."
                };

                // job is added to kue's work queue once the download has finished
                messageCallback(JSON.stringify(json));
            })
            .catch(function(err) {
                const json = {
                    status : "nok",
                    type : "reply",
                    message : err
                };

                messageCallback(JSON.stringify(json));
                console.log(err);
            });
        } else {
            db.getTask(owner, fileOptions.file_id, kvazaarHash)
            .then((row) => {
                if (!row) {
                    const task_params = {owner_id : owner, file_id : fileOptions.file_id,
                                         ops_id : kvazaarHash, token : token};
                    db.insertTask(task_params)
                    .then(db.getLastInsertedId)
                    .then((id) => {
                        console.log("new task added");
                        const downloadLink = '<a href=\"http://localhost:8080/download/' + token + '\">this link</a>';
                        const msg = "You can use " + downloadLink + " to download the file when it's ready";
                        const message =  "Upload rejected (file already on the server), " + 
                                         "file has been added to work queue\n" + msg;
                        const json = {
                            status : "nok",
                            type : "reply",
                            message : message
                        };

                        job_enqueue(id);
                        messageCallback(JSON.stringify(json));

                    }, (reason) => {
                        console.log(reason);
                    });
                } else {
                    const json = {
                        status : "nok",
                        type : "reply",
                        message :  "Upload rejected (file already on the server), file already in the work queue"
                    };
                    messageCallback(JSON.stringify(json));
                }
            }, (reason) => {
                console.log(err);
            });
        }
    });
}

// first check if kvz_options table already has these values
//  -> use it instead, else create new record
//
// then check if file with this hash (file_id) already exits
//  -> inform user about this and cancel file load
//      -> encode the file with new parameters
//  -> else create new record for file and inform frontend that 
//     it's ok to start the file upload
function prepareDBForRequest(options, callback) {
    const kvazaarHash = crypto.createHash('sha256').update(JSON.stringify(options.kvazaar)).digest('hex');
    options.kvazaar['hash'] = kvazaarHash;

    db.getOptions(kvazaarHash)
    .then((row) => {
        if (!row) {
            validateKvazaarOptions(options.kvazaar)
            .then(db.insertOptions(options.kvazaar))
            .then(() => {
            }, (reason) => {
                console.log(reason);
            });
        }
        linkOptionsAndFiles("testuser", options.other, kvazaarHash, callback);
    }, (reason) => {
        console.log(reason);
    });
}

var server = http.createServer(function(request, response) {
}).listen(8081, function() { });

// create the server
wsServer = new WebSocketServer({
    httpServer: server
});

// WebSocket server
wsServer.on('request', function(request) {
    ws_conn = request.accept(null, request.origin);

    ws_conn.on('message', function(message) {
        if (message.type === 'utf8') {
            var data = JSON.parse(message.utf8Data);

            // create temporary file for data chunks
            fs.writeFile('/tmp/cloud_uploads/' + data.other.file_id + '.tmp', '', function (err) {
                if (err) throw err;

                sendMessage(ws_conn, null, "status", "Checking database....");
                prepareDBForRequest(data, function(status) {
                    ws_conn.send(status);
                });
            }); 
        }
    });

    ws_conn.on('close', function(connection) {
        console.log("connection closed");
    });
});

// Host most stuff in the public folder
app.use(express.static(__dirname + '/public'));
app.use(multipart());

// Handle uploads through Resumable.js
app.post('/upload', function(req, res) {
    resumable.post(req, function(status, filename, original_filename, identifier) {
        const tmpFile    = "/tmp/cloud_uploads/" + identifier + ".tmp";
        const chunkFile  = "/tmp/cloud_uploads/resumable-" + original_filename + "." + req.query.resumableChunkNumber;

        // file too large (>50GB), inform user, terminate upload and clean database
        if (req.query.resumableChunkNumber * req.query.resumableChunkSize > 5 * 1000 * 1000 * 1000) {
            sendMessage(ws_conn, "nok", "reply", "File too big");
            res.sendStatus(400);
            // TODO clean database
            return;
        } else if (req.query.resumableChunkNumber == 1) {
            // TODO ffprobe
        }

        // TODO refaktoroi tämä niin että tässä on 
        // processChunk()-kutsu tarkistuen jälkeen ja callbackissa lähetetään response

        fs.readFile(chunkFile, function(err, data) {
            if (err) {
                throw err;
            }

            fs.appendFile(tmpFile, data, function(err) {
                if (err) {
                    throw err;
                }

                if (status === "done") {
                    sendMessage(ws_conn, null, "status", "File upload done!");

                    // TODO rewrite chunk transmission in resumable-node.js so blocks
                    // can be deleted after their data has been read and then this loop 
                    // can be deleted all together
                    const pathPrefix = "/tmp/cloud_uploads/resumable-";
                    const chunkFiles = Array.from({length: req.query.resumableChunkNumber},
                        (v, k) => pathPrefix + original_filename + "." + (k + 1)); 

                    chunkFiles.forEach(function(filepath) {
                        fs.unlink(filepath, function(err) {
                            if (err) {
                                throw err;
                            }
                        });
                    });

                    fs.readFile(tmpFile, function(err, data) {
                        const fileHash = crypto.createHash('sha256').update(data).digest('hex');
                        const filePath = '/tmp/cloud_uploads/' + fileHash;
                        const token    = crypto.randomBytes(64).toString('hex');

                        const downloadLink = '<a href=\"http://localhost:8080/download/' + token + '\">this link</a>';
                        const msg = "you can use " + downloadLink + " to download the file when it's ready";
                        sendMessage(ws_conn, null, "status", msg);

                        fs.rename(tmpFile, filePath, function(err) {
                            if (err) {
                                throw err;
                            }

                            db.updateFile(identifier, {file_path : filePath, hash : fileHash})
                            .then(db.getLastInsertedId)
                            .then((id) => {
                                job_enqueue(id);
                                sendMessage(ws_conn, null, "status", "file has been added to work queue!");
                            }, (reason) => {
                                console.log(err);
                            });
                        });
                    });
                }
                res.send(status);
            });
        });
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
