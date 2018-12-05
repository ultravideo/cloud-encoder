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
        "STARTING" : 1,
        "DECODING" : 2,
        "ENCODING" : 3,
        "CONTAINERIZING" : 4,
        "READY" : 5,
        "FAILURE" : 6,
    }
);

// remove original file, extracted audio file and 
// raw video if the videos was containerized
function removeArtifacts(path, containerized) {
    var files = [".txt", "_logo.hevc", ".yuv", ".hevc"];

    if (containerized === true) {
        files = files.concat([".aac", "_new.hevc"]);
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

function ffmpegContainerize(videoPath, audioPath, container) {
    return new Promise((resolve, reject) => {
        const newPath = videoPath.split('.')[0] + "." + container;

        ffmpeg()
            .input(videoPath)
            .inputFormat("hevc")
            .videoCodec("copy")
            .input(audioPath)
            .inputFormat("aac")
            .audioCodec("copy")
            .inputOptions("-async 1")
            .on('error', function(err) {
                reject(err);
            })
            .on('end', function(err) {
                if (err)
                    reject(err);
                resolve(newPath);
            })
            .save(newPath);
    });
}

function moveToOutputFolder(path) {
    return new Promise((resolve, reject) => {
        const fileName = path.split("/").pop().replace("_new", "");
        const newPath  = "/tmp/cloud_uploads/output/" + fileName;

        fs.rename(path, newPath, function(err) {
            if (err)
                reject(err);
            resolve(newPath);
        });
    });
}

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
                        callback(null, pathPrefix + "_new.hevc");
                    }, (reason) => {
                        callback(reason);
                    });
                });
            });
    }, (reason) => {
        callback(reason);
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

        console.log("video options ok!");
        resolve([res[0], fps[0]]);
    });
}

function decodeVideo(fileOptions, kvazaarOptions) {
    let promise = new Promise((resolve, reject) => {
        ffprobe(fileOptions.file_path, { path: ffprobeStatic.path })
        .then((info) => {
            return validateVideoOptions(info);
        })
        .then((validated_options) => {
            console.log("video options have been validated!");
            fileOptions.resolution      = validated_options[0];
            kvazaarOptions["input-fps"] = validated_options[1];

            // extract audio
            if (kvazaarOptions.container !== "none") {
                console.log("extract audio...");
                callFFMPEG(fileOptions.file_path, [],
                           fileOptions.file_path + ".aac", ["-vn", "-acodec copy"])   
            }
        })
        .then(() => {
            // extract video in yuv420p format
            console.log("decoding video...");
            callFFMPEG(fileOptions.file_path, ["-r", kvazaarOptions['input-fps']],
                         fileOptions.file_path + ".yuv", ["-f rawvideo", "-pix_fmt yuv420p"])
            .then(() => {
                console.log("decoding done!");
                resolve(fileOptions.file_path + ".yuv");
            }, (reason) => {
                console.log("decoding video failed with error: " + reason);
                reject(reason);
            });
        })
        .catch(function(err) {
            reject(err);
        });
    });
    return promise;
}

// encode video using kvazaar with given options
// when the encoding is done update the work_queue status to "encoding done"
function kvazaarEncode(videoLocation, fileOptions, kvazaarOptions) {
    return new Promise((resolve, reject) => {
        console.log("starting kvazaar!");

        var options = ["-i", videoLocation,
                      "--input-res", fileOptions.resolution,
                      "--output", fileOptions.file_path + ".hevc"];

        // kvazaar options have been validated earlier so it's safe to use
        // them here without any extra safety checks
        for (var key in kvazaarOptions) {
            // TODO UGLY, REMOVE THIS
            if (key === "hash" || key === "container")
                continue;

            options.push("--" + key);
            options.push(kvazaarOptions[key]);
        }

        const child = spawn("kvazaar", options);

        child.stdout.on('data', function(data) { });
        child.stderr.on('data', function(data) { });

        child.on('exit', function(code, signal) {
            if (code === 0) {
                addLogo(fileOptions.file_path + ".hevc", fileOptions.resolution, function(err, newPath) {
                    if (err)
                        reject(err);
                    resolve(newPath);
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
        case workerStatus.FAILURE:
            break;
    }
}

function renameFile(oldPath, newPath) {
    let promise = new Promise((resolve, reject) => {
        fs.rename(oldPath, newPath, function(err) {
            if (err)
                reject(err);
            resolve(newPath);
        });
    });
    return promise;
}

function processFile(fileOptions, kvazaarOptions, taskInfo, done) {
    let preprocessFile = null;

    if (fileOptions.raw_video === 1) {
        preprocessFile = renameFile(fileOptions.file_path, fileOptions.file_path + ".yuv");
    } else {
        preprocessFile = decodeVideo(fileOptions, kvazaarOptions);
    }

    preprocessFile.then((rawVideoName) => {
        return kvazaarEncode(rawVideoName, fileOptions, kvazaarOptions);
    })
    .then((encodedVideoName) => {
        if (kvazaarOptions.container !== "none")
            return ffmpegContainerize(encodedVideoName, fileOptions.file_path + ".aac", kvazaarOptions.container);
        return encodedVideoName;
    })
    .then((path) => {
        return moveToOutputFolder(path);
    })
    .then((newPath) => {
        db.updateTask(taskInfo.taskID, {file_path : newPath})
        .then(() => {
            console.log(kvazaarOptions);
            removeArtifacts(fileOptions.file_path, kvazaarOptions.container !== "none");
            updateWorkerStatus(workerStatus.READY);
            done();
        }, (reason) => {
            updateWorkerStatus(workerStatus.FAILURE);
            console.log(reason);
        });
    })
    .catch(function(reason) {
        updateWorkerStatus(workerStatus.FAILURE);
        console.log(reason);
    });
}

queue.process('process_file', function(job, done) {
    updateWorkerStatus(workerStatus.STARTING);

    db.getTask(job.data.task_id).then((taskRow) => {
        let filePromise = db.getFile(taskRow.file_id);
        let optionsPromise = db.getOptions(taskRow.ops_id);

        Promise.all([filePromise, optionsPromise]).then(function(values) {
            processFile(values[0], values[1], taskRow, done);
        });
    })
    .catch(function(err) {
        console.log(err);
    });
});
