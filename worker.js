let db = require('./db');
var exec = require('child_process').exec;
var ffmpeg = require('fluent-ffmpeg');
var ffprobe = require('ffprobe');
var ffprobeStatic = require('ffprobe-static');
var fs = require('fs');
let process = require('process');
var NRP = require('node-redis-pubsub');
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

var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});

function sendMessage(user, message) {
    nrp.emit('message', {
        user: user,
        status: null,
        reply: "status",
        message: message,
    });
}

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

function callFFMPEG(inputs, inputOptions, output, outputOptions) {
    return new Promise((resolve, reject) => {
        let options = inputOptions;

        inputs.forEach(function(input) {
            options.push("-i", input);
        });

        options = options.concat(outputOptions);
        options.push(output);

        const child = spawn("ffmpeg", options);

        let stderr_out = "";
        child.stderr.on("data", function(data) { stderr_out += data.toString(); });
        child.stdout.on("data", function(data) { });

        child.on("exit", function(code, signal) {
            if (code === 0) {
                resolve();
            } else {
                console.log(stderr_out);
                reject(new Error("ffmpeg failed with error code " + code));
                console.log(options);
            }
        });
    });
}

function ffmpegContainerize(videoPath, audioPath, container) {
    return new Promise((resolve, reject) => {
        const newPath = videoPath.split('.')[0] + "." + container;

        callFFMPEG([videoPath, audioPath], [],
                   newPath, ["-async", "1", "-c", "copy"])
        .then(() => {
            resolve(newPath);
        }, (reason) => {
            reject(reason);
        });
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

    callFFMPEG(["/tmp/cloud_uploads/misc/logo.png"], [],
               pathPrefix + "_logo.hevc", ["-vf", "scale=" + resolution.replace('x', ':') + ",setdar=1:1"])
    .then(() => {
            console.log("concat logo and video file");
            fs.open(pathPrefix + ".txt", "wx", (err, fd) => {
                if (err)
                    throw err;

                const fileData = "file '" + video_path + "'\n" +
                                 "file '" + pathPrefix + "_logo.hevc" + "'";

                fs.write(fd, fileData, function(err, a, b) {
                    callFFMPEG([pathPrefix + ".txt"],    ["-f", "concat", "-safe", "0"],
                               pathPrefix + "_new.hevc", ["-c", "copy"])
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
            if (fileOptions.container !== "none") {
                console.log("extract audio...");
                callFFMPEG([fileOptions.file_path], [],
                           fileOptions.file_path + ".aac", ["-vn", "-acodec", "copy"])   
            }
        })
        .then(() => {
            // extract video in yuv420p format
            console.log("decoding video...");
            callFFMPEG([fileOptions.file_path], ["-r", kvazaarOptions['input-fps']],
                         fileOptions.file_path + ".yuv", ["-f", "rawvideo", "-pix_fmt", "yuv420p"])
            .then(() => {
                console.log("decoding done!");
                resolve(fileOptions.file_path + ".yuv");
            }, (reason) => {
                console.log("decoding video failed with error: " + reason);
                reject(reason);
            });
        })
        .catch(function(err) {
            console.log("frpobe error" + err);
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
            options.push("--" + key);
            options.push(kvazaarOptions[key]);
        }

        const child = spawn("kvazaar", options);

        child.stdout.on("data", function(data) { });
        child.stderr.on("data", function(data) { });

        child.on("exit", function(code, signal) {
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

function updateWorkerStatus(taskInfo, status) {
    let message ="";

    switch (status) {
        case workerStatus.STARTING:
            message = "File encoding starting...";
            break;
        case workerStatus.ENCODING:
            message = "Starting to encode video...";
            break;
        case workerStatus.DECODING:
            message = "Starting to decode video...";
            break;
        case workerStatus.CONTAINERIZING:
            message = "Containerizing video...";
            break;
        case workerStatus.READY:
            message = "Video ready!";
            break;
        case workerStatus.FAILURE:
            message = "Encoding failed!";
            break;
    }

    sendMessage(taskInfo.owner_id, message);
    db.updateTask(taskInfo.taskID, {status: status}).then().catch(function(err) {
        console.log(err);
    });
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
        updateWorkerStatus(taskInfo, workerStatus.DECODING);
        preprocessFile = decodeVideo(fileOptions, kvazaarOptions);
    }

    preprocessFile.then((rawVideoName) => {
        updateWorkerStatus(taskInfo, workerStatus.ENCODING);
        return kvazaarEncode(rawVideoName, fileOptions, kvazaarOptions);
    })
    .then((encodedVideoName) => {
        if (fileOptions.container !== "none") {
            updateWorkerStatus(taskInfo, workerStatus.CONTAINERIZING);
            return ffmpegContainerize(encodedVideoName, fileOptions.file_path + ".aac", fileOptions.container);
        }
        return encodedVideoName;
    })
    .then((path) => {
        return moveToOutputFolder(path);
    })
    .then((newPath) => {
        db.updateTask(taskInfo.taskID, {file_path : newPath})
        .then(() => {
            console.log(kvazaarOptions);
            removeArtifacts(fileOptions.file_path, fileOptions.container !== "none");
            updateWorkerStatus(taskInfo, workerStatus.READY);
            done();
        }, (reason) => {
            updateWorkerStatus(taskInfo, workerStatus.FAILURE);
            removeArtifacts(fileOptions.file_path, fileOptions.container !== "none");
            console.log(reason);
        });
    })
    .catch(function(reason) {
        updateWorkerStatus(taskInfo, workerStatus.FAILURE);
        removeArtifacts(fileOptions.file_path, fileOptions.container !== "none");
        console.log(reason);
    });
}

queue.process("process_file", function(job, done) {

    db.getTask(job.data.task_token).then((taskRow) => {
        let filePromise = db.getFile(taskRow.file_id);
        let optionsPromise = db.getOptions(taskRow.ops_id);

        Promise.all([filePromise, optionsPromise]).then(function(values) {
            // (re)move unnecessary info from kvazaarOptions (to fileOptions)
            values[0]["container"] = values[1]["container"];
            delete values[1]["container"];
            delete values[1]["hash"];

            updateWorkerStatus(taskRow.owner_id, workerStatus.STARTING);

            processFile(values[0], values[1], taskRow, done);
        });
    })
    .catch(function(err) {
        console.log(err);
    });
});
