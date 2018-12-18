let db = require('./db');
let parser = require("./parser");
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

const workerStatus = Object.freeze({
    "CANCELLED": -3,
    "FAILURE": -2,
    "UPLOADING": -1,
    "WAITING": 0,
    "DECODING" : 1,
    "ENCODING" : 2,
    "POSTPROCESSING" : 3,
    "READY" : 4,
});

const workStatus = Object.freeze({
    "STARTING": 1,
    "DONE": 2,
    "FAILED": 3,
});

var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});

function sendMessage(user, fileId, message, status, misc) {
    nrp.emit('message', {
        user: user,
        token: fileId,
        status: status,
        reply: "status",
        message: message,
        misc: misc,
    });
}

// remove original file, extracted audio file and
// raw video if the videos was containerized
function removeArtifacts(path, fileOptions) {
    var files = [".txt", "_logo.hevc", ".hevc"];

    // decodeVideo creates temporary yuv file
    if (fileOptions.raw_video === 0) {
        files.push(".yuv");
    }

    if (fileOptions.container !== "none") {
        files.push("_new.hevc");

        // raw video files don't have audio tracks
        if (fileOptions.raw_video === 0)
            files.push(".wav");
    }

    files.forEach(function(extension) {
        fs.unlink(path + extension, function(err) {
            // some files may not be present, ignore errors
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
                reject(new Error("ffmpeg failed with error code " + code));
                console.log(stderr_out);
                console.log(options);
            }
        });
    });
}

function ffmpegContainerize(videoPath, audioPath, container) {
    return new Promise((resolve, reject) => {
        const newPath = videoPath.split('.')[0] + "." + container;

        // check if audio track exists, user may have given us
        // raw video to encode and the containerize in which case
        // we wouldn't have an audio track
        fs.access(audioPath, fs.constants.F_OK, function(err) {
            let inputs = [ videoPath ];
            let outputOptions = [ "-c:v", "copy" ];

            if (!err) {
                inputs.push(audioPath);
                outputOptions.push("-async", "1", "-c:a", "aac");
            }

            callFFMPEG(inputs, [], newPath, outputOptions).then(() => {
                resolve(newPath);
            })
            .catch(function(err) {
                reject(err);
            });
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
    return Promise.all([
        parser.validateResolution(video_info.streams[0].width + "x" + video_info.streams[0].height),
        parser.validateFrameRate(video_info.streams[0].avg_frame_rate)
    ]);
}

function decodeVideo(fileOptions, kvazaarOptions) {
    let promise = new Promise((resolve, reject) => {
        ffprobe(fileOptions.file_path, { path: ffprobeStatic.path })
        .then((info) => {
            return validateVideoOptions(info);
        })
        .then((validated_options) => {
            fileOptions.resolution      = validated_options[0];
            kvazaarOptions["input-fps"] = validated_options[1];

            let promises = [
                callFFMPEG([fileOptions.file_path], ["-r", kvazaarOptions['input-fps']],
                            fileOptions.tmp_path + ".yuv", ["-f", "rawvideo", "-pix_fmt", "yuv420p"])
            ];

            // extract audio if it's viable (users wants the output to contain the audio track
            // and there's an audio track to extract [video is not raw])
            if (fileOptions.container !== "none" && fileOptions.raw_video === 0) {
                promises.push(callFFMPEG([fileOptions.file_path], [],
                              fileOptions.tmp_path + ".wav", ["-vn", "-codec:a", "pcm_s16le", "-ac", "1"]));
            }

            return Promise.all(promises);
        })
        .then(() => {
            resolve(fileOptions.tmp_path + ".yuv");
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
                      "--output", fileOptions.tmp_path + ".hevc"];

        // kvazaar options have been validated earlier so it's safe to use
        // them here without any extra safety checks
        for (var key in kvazaarOptions) {
            options.push("--" + key);

            if (kvazaarOptions[key] != null)
                options.push(kvazaarOptions[key]);
        }

        const child = spawn("kvazaar", options);

        let stderr = "";
        child.stdout.on("data", function(data) { });
        child.stderr.on("data", function(data) { stderr += data.toString(); });

        child.on("exit", function(code, signal) {
            if (code === 0) {
                addLogo(fileOptions.tmp_path + ".hevc", fileOptions.resolution, function(err, newPath) {
                    if (err)
                        reject(err);
                    resolve(newPath);
                });
            } else {
                reject(new Error("kvazaar failed with exit code " + code));
                console.log(options);
                console.log(stderr);
            }
        });
    });
}

function updateWorkerStatus(taskInfo, fileId, currentJob) {
    let message = "";

    switch (currentJob) {
        case workerStatus.READY:          message = "Done!";             break;
        case workerStatus.FAILURE:        message = "Request failed!";   break;
        case workerStatus.WAITING:        message = "Queued";            break;
        case workerStatus.DECODING:       message = "Decoding";          break;
        case workerStatus.ENCODING:       message = "Encoding";          break;
        case workerStatus.CANCELLED:      message = "Request cancelled"; break;
        case workerStatus.UPLOADING:      message = "Uploading file";    break;
        case workerStatus.POSTPROCESSING: message = "Post-processing";   break;
    }

    db.updateTask(taskInfo.taskID, { status: currentJob }).then(() => {
        nrp.emit('message', {
            user: taskInfo.owner_id,
            file_id: fileId,
            token: taskInfo.token,
            type: "action",
            reply: "taskUpdate",
            status: currentJob,
            message: message
        });
    });
}

// raw video doesn't require any preprocessing (at least for now)
function preprocessRawVideo(path) {
    let promise = new Promise((resolve, reject) => {
        resolve(path);
    });
    return promise;
}

function processFile(fileOptions, kvazaarOptions, taskInfo, done) {
    let preprocessFile = null;

    if (fileOptions.raw_video === 1) {
        preprocessFile = preprocessRawVideo(fileOptions.file_path);
    } else {
        updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.DECODING);
        preprocessFile = decodeVideo(fileOptions, kvazaarOptions);
    }

    preprocessFile.then((rawVideoName) => {
        updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.ENCODING);
        return kvazaarEncode(rawVideoName, fileOptions, kvazaarOptions);
    })
    .then((encodedVideoName) => {
        updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.POSTPROCESSING);

        if (fileOptions.container !== "none") {
            return ffmpegContainerize(encodedVideoName, fileOptions.tmp_path + ".wav", fileOptions.container);
        }
        return encodedVideoName;
    })
    .then((path) => {
        return moveToOutputFolder(path);
    })
    .then((newPath) => {
        db.updateTask(taskInfo.taskID, { file_path : newPath }).then(() => {
            removeArtifacts(fileOptions.tmp_path, fileOptions);
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.READY);
            done();
        }, (reason) => {
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.FAILURE);
            removeArtifacts(fileOptions.tmp_path, fileOptions);
            console.log(reason);
        });
    })
    .catch(function(reason) {
        updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.FAILURE);
        removeArtifacts(fileOptions.tmp_path, fileOptions);
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

            // add bit depth and input fps to kvazaar options if file is raw
            if (values[0].raw_video === 1) {
                values[1]["input-fps"] = values[0].fps;
                values[1]["input-bitdepth"] = values[0].bit_depth;
            }

            // if user gave us extra options, do a small reformat and add them to kvazaar options
            if (values[1].extra !== "") {
                let allOptions = values[1].extra.split(",");

                allOptions.forEach(function(option) {
                    let parts = option.split(" ");

                    if (parts.length > 1)
                        values[1][parts[0]] = parts[1];
                    else
                        values[1][parts[0]] = null;
                });
            }
            delete values[1].extra;

            // use generated token to handle all intermediate files (.hevc, .acc, _logo.hevc etc)
            // this way N users can create request for the same file without "corrupting" each others processes
            values[0]["tmp_path"] = "/tmp/cloud_uploads/" + taskRow.token;

            processFile(values[0], values[1], taskRow, done);
        });
    })
    .catch(function(err) {
        console.log(err);
    });
});