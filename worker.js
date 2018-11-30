let db = require('./db');
var exec = require('child_process').exec;
var ffmpeg = require('fluent-ffmpeg');
var ffprobe = require('ffprobe');
var ffprobeStatic = require('ffprobe-static');
var fs = require('fs');
let process = require('process');
const { spawn } = require('child_process');
const fsPromises = require('fs').promises;

let kue = require('kue');
let queue = kue.createQueue({
    redis: {
        port: 7776,
        host: "127.0.0.1"
    }
});

const workerStatus = Object.freeze(
    {
        "DECODING" : 1,
        "ENCODING" : 2,
        "CONTAINERIZING" : 3,
        "READY" : 4
    }
);

// remove original file, extracted audio file and 
// raw video if the videos was containerized
//
// TODO discuss with Marko which files we should keep
function removeArtifacts(path, containerized) {
    let files = [".txt", "_logo.hevc"];

    if (containerized) {
        files.concat([".aac", ".hevc", ".yuv", "_new.hevc"]);
    }

    files.forEach(function(extension) {
        fs.unlink(path + extension, function(err) {
            if (err)
                console.log(err);
        });
    });
}

// TODO add support for multiple inputs
function callFFMPEG(inputs, inputOptions, output, outputOptions) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(inputs)
            .inputOptions(inputOptions)
            .outputOptions(outputOptions)
            .on("error", function(err) {
                reject(err);
            })
            .on("end", function(err) {
                if (err)
                    reject(err);
                resolve();
            })
            .save(output);
    });
}

function ffmpegContainerize(video_path, audio_path, container, callback) {
    ffmpeg()
        .input(video_path)
        .inputFormat("hevc")
        .videoCodec("copy")
        .input(audio_path)
        .inputFormat("aac")
        .audioCodec("copy")
        .inputOptions("-async 1")
        .on('error', function(err) {
            console.log(err);
        })
        .on('end', function(err) {
            if (err)
                throw err;
            callback();
        })
        .save(video_path.split('.')[0] + "." + container);
}

function moveToOutputFolder(path) {
    return new Promise((resolve, reject) => {
        const fileName = path.split("/").pop().replace("_new", "");
        const newPath  = "/tmp/cloud_uploads/output/" + fileName;

        return fsPromises.rename(path, newPath);
    });
}

// TODO add comment
function addLogo(video_path, resolution, callback) {
    const pathPrefix = video_path.split('.')[0];

    callFFMPEG("/tmp/cloud_uploads/misc/logo.png", [],
               pathPrefix + "_logo.hevc", ["-vf scale=" + resolution.replace('x', ':') + ",setdar=1:1"])
    .then(() => {
            console.log("concat logo and video file");
            fs.open(pathPrefix + ".txt", "wx", (err, fd) => {
                if (err)
                    throw err;

                const fileData = "file '" + video_path + "'\n" +
                                 "file '" + pathPrefix + "_logo.hevc" + "'";

                fs.write(fd, fileData, function(err, a, b) {
                    callFFMPEG(pathPrefix + ".txt",      ["-f concat", "-safe 0"],
                               pathPrefix + "_new.hevc", ["-c:v copy"])
                    .then(() => {
                        callback();
                    }, (reason) => {
                        console.log("failed to add logo to video: " + reason);
                    });
                });
            });
    }, (reason) => {
        console.log("failed to create logo: " + reason);
    });
}

function validateVideoOptions(video_info) {
    return new Promise((resolve, reject) => {
        let tmp = video_info.streams[0].width + "x" + video_info.streams[0].height;
        let res = tmp.match(/[0-9]{1,4}\x[0-9]{1,4}/g);
        if (!res) {
            reject(new Error("Invalid resolution!"));
        }

        tmp = video_info.streams[0].avg_frame_rate;
        let fps = tmp.match(/[0-9]{1,4}\/[0-9]{1,4}/g);
        if (!fps) {
            reject(new Error("Invalid FPS!"));
        }

        resolve([res[0], fps[0]]);
    });
}

// TODO comment
function decodeVideo(file_ops, kvz_ops, finalizeEncoding) {
    console.log("decoding video...");
    ffprobe(file_ops.file_path, { path: ffprobeStatic.path })
    .then((info) => {
        validateVideoOptions(info)
        .then((parsed_info) => {
            file_ops.resolution  = parsed_info[0];
            kvz_ops['input-fps'] = parsed_info[1];

            // extract audio track before decoding the video
            if (file_ops.container !== "none") {
                console.log("extracting audio track...");
                callFFMPEG(file_ops.file_path, [],
                           file_ops.file_path + ".aac", ["-vn", "-acodec copy"])
                .then(() => {
                    console.log("audio extracted!");
                }, (reason) => {
                    console.log("failed to extract audio: " + reason);
                });
            }

            callFFMPEG(file_ops.file_path,          ["-r", kvz_ops['input-fps']],
                       file_ops.file_path + ".yuv", ["-f rawvideo", "-pix_fmt yuv420p"])
            .then(() => {
                console.log("decoding done!");
                finalizeEncoding();
            }, (reason) => {
                console.log("decoding failed: " + reason);
            });
        }, (reason) => {
            console.log("failed to parse video options: " + reason);
        });
    }, (reason) => {
        console.log("probing failed: " + reason);
    });
}

// encode video using kvazaar with given options
// when the encoding is done update the work_queue status to "encoding done"
function kvazaarEncode(file_ops, kvz_ops) {
    return new Promise((resolve, reject) => {
        console.log("starting kvazaar!");

        var options = ["-i", file_ops.file_path + ".yuv",
                      "--input-res", file_ops.resolution,
                      "--output", file_ops.file_path + ".hevc"];

        // kvazaar options have been validated earlier so it's safe to use
        // them here without any extra safety checks
        for (var key in kvz_ops) {
            options.push("--" + key);
            options.push(kvz_ops[key]);
        }

        const child = spawn("kvazaar", options);

        child.stdout.on('data', function(data) { });
        child.stderr.on('data', function(data) { });

        child.on('exit', function(code, signal) {
            if (code === 0) {
                addLogo(file_ops.file_path + ".hevc", file_ops.resolution, function() {
                    resolve();
                });
            } else {
                reject(new Error("kvazaar failed with exit code " + code));
                console.log(options);
            }
        });
    });
}

// TODO 
//
// 1) send message to socket.js and inform user at the other end of websocket about this change in state
// 2) update work_queue's task's state
function updateWorkerStatus(status) {
    switch (status) {
        case workerStatus.ENCODING:
            break;
        case workerStatus.DECODING:
            break;
        case workerStatus.CONTAINERIZING:
            break;
        case workerStatus.READY:
            break;
    }
}

// TODO add comment
// TODO REFACTOR THIS FUNCTION
function processFile(fileOptions, kvazaarOptions, taskInfo, done) {
    if (fileOptions.raw_video === 1) {
        updateWorkerStatus(workerStatus.ENCODING);

        fsPromises.rename(fileOptions.file_path, fileOptions.file_path + ".yuv")
        .then(kvazaarEncode(fileOptions, kvazaarOptions))
        .then(moveToOutputFolder(fileOptions.file_path + "_new.hevc"))
        .then((newPath) => {
            updateWorkerStatus(workerStatus.READY);
            removeArtifacts(fileOptions.file_path.false);
            db.updateTask(taskInfo.taskID, {file_path : newPath, status : workerStatus.READY})
            .then(() => {
                console.log("all done");
                done();
            }, (reason) => {
                console.log(reason);
            });
        })
        .catch(function(err) {
            console.log(err);
        });
/*
        fs.rename(file_ops.file_path, file_ops.file_path + ".yuv", function() {
            kvazaarEncode(fileOptions, kvazaarOptions, function() {
                // encoding done, file is ready to be downloaded
                moveToOutputFolder(file_ops.file_path + "_new.hevc", function(err, newPath) {
                    if (err) throw err;

                    console.log("encoding done!");
                    updateWorkerStatus(workerStatus.READY);
                    removeArtifacts(file_ops.file_path, false);
                    done();
                    // db.addOutputPath(message.token, newPath, function() {});
                });
            });
        });
        */
    } else {
        throw "NOT YET IMPLEMENTED!!";
        updateWorkerStatus(workerStatus.DECODING).then().catch();

        // decodeVideo(TOKEN, NUMBER)
        // .then(kvazaarEncode(fileOptions, kvazaarOptions)
        // .then(() => {

        // })
    }

    throw "old code";

    /*
    db.getFileDataAndOptions(message.file_ops, function(file_ops, kvz_ops) {
        if (file_ops.raw_video === 0 && file_ops.resolution === null) {
            // start decoding
            db.updateWorkerStatus(message.token, 1, function() {});

            decodeVideo(file_ops, kvz_ops, function() {
                // decoding done, start encoding
                db.updateWorkerStatus(message.token, 2, function() {});

                kvazaarEncode(file_ops, kvz_ops, function() {
                    console.log("encoding done!");

                    if (file_ops.container !== "none") {
                        const fpvideo = file_ops.file_path + "_new.hevc";
                        const fpaudio = file_ops.file_path + ".aac";

                        // encoding done, start containerization
                        db.updateWorkerStatus(message.token, 3, function() {});
                        // socket.sendUpdate(""); // TODO

                        ffmpegContainerize(fpvideo, fpaudio, file_ops.container, function() {
                            moveToOutputFolder(file_ops.file_path + "_new." + file_ops.container, function(err, newPath) {
                                if (err) throw err;

                                db.addOutputPath(message.token, newPath, function() {});
                                removeArtifacts(file_ops.file_path, true);
                                done();
                            });
                        });
                    } else {
                        // encoding done, mark file as ready
                        moveToOutputFolder(file_ops.file_path + "_new.hevc", function(err, newPath) {
                            if (err) throw err;

                            db.addOutputPath(message.token, newPath, function() {});
                            removeArtifacts(file_ops.file_path, false);
                            done();
                        });
                    }
                });
            });
        } else {
            // decoding done, start encoding
            db.updateWorkerStatus(message.token, 2, function() {});

            fs.rename(file_ops.file_path, file_ops.file_path + ".yuv", function() {
                kvazaarEncode(file_ops, kvz_ops, function() {

                    // encoding done, file is ready to be downloaded
                    moveToOutputFolder(file_ops.file_path + "_new.hevc", function(err, newPath) {
                        if (err) throw err;

                        db.addOutputPath(message.token, newPath, function() {});
                        console.log("encoding done!");
                        removeArtifacts(file_ops.file_path, false);
                        done();
                    });
                });
            });
        }
    });
*/
}

queue.process('process_file', function(job, done) {
    console.log("pid " + process.pid + " is working on job " + job.id);

    // TODO update client here that his/her task has been started

    // TODO REFACTOR THIS!!!!!!
    db.getTask(job.data.task_id)
    .then(task_row => {
        db.getFile(task_row.file_id)
        .then(function(file_row) {
            db.getOptions(task_row.ops_id)
            .then(options_row => {
                processFile(file_row, options_row, task_row, done);
            }, reason => {
                console.log(reason);
            });
        }, reason => {
            console.log(reason);
        });
    }, reason => {
        console.log(reason);
    });
});
