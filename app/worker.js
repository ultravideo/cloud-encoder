let db = require("./db");
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
const workerStatus = require("./constants");

let kue = require('kue');
let queue = kue.createQueue({
    redis: {
        port: 7776,
        host: "127.0.0.1"
    }
});

// ------------------- message queue stuff -------------------
var nrp = new NRP({
    port: 7776,
    scope: "msg_queue"
});

// this variable holds the PID of currently running external program
// It's updaded every time task moves forward (e.g. from decoding to encoding)
let currentJobPid = null;

// This variable is checked before updating the fault state of task
// If true, task's status is set to CANCELLED otherwise FAILURE
let taskCancelled = false;

// this variable holds the token of current task
// It's set when processing the task is started
let currentJobToken = null;

// user pressed cancel button and socket send us cancel request
// check if we're processing the request and if we are, kill the process
nrp.on("message", function(msg) {
    if (msg.type === "cancelRequest" && msg.token === currentJobToken) {

        taskCancelled = true;

        // currently executing process (kvazaar or ffmpeg) will catch this signal
        // and reject the Promise. processFile shall then clean up all intermediate
        // files and set the status of taks to CANCELLED
        process.kill(currentJobPid);
    }
});

// ------------------- /message queue stuff -------------------

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

// generic ffmepg function.
// @inputs: array of input files
// @inputOptions: array of input options
// @output: output file name
// @outputOptions: array of output options
function callFFMPEG(inputs, inputOptions, output, outputOptions) {
    return new Promise((resolve, reject) => {
        let options = inputOptions;

        inputs.forEach(function(input) {
            options.push("-i", input);
        });

        options = options.concat(outputOptions);
        options.push(output);

        const child = spawn("ffmpeg", options);

        // update currentJobPid so we can kill the process if user so requests
        currentJobPid = child.pid;

        let stderr_out = "";
        child.stderr.on("data", function(data) { stderr_out += data.toString(); });
        child.stdout.on("data", function(data) { });

        child.on("exit", function(code, signal) {
            if (code === 0) {
                resolve();
            } else {
                console.log(options);
                console.log(stderr_out);
                reject(new Error("ffmpeg failed with error code " + code));
            }
        });
    });
}

// user requested that the output file is in container (eg. not just HEVC video)
// add hevc video and original audio track to requested container
function ffmpegContainerize(videoPath, audioPath, container) {
    return new Promise((resolve, reject) => {
        const newPath = videoPath.split('.')[0] + "." + container;
        const tmpPath = videoPath.split('.')[0] + ".mp4";

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

            // There's a bug somewhere in ffmpeg, cloud or kvazaar which causes
            // mkv containers not to work (something about missing timestamps)
            // this bug can be mitigated by first using mp4 and converting the mp4 to mkv
            callFFMPEG(inputs, [], tmpPath, outputOptions).then(() => {
                if (container === "mkv")
                    return callFFMPEG([tmpPath], [], newPath, ["-c:v", "copy", "-c:a", "copy"]);
                else
                    resolve(newPath);
            })
            .then(() => {
                resolve(newPath);
            })
            .catch(function(err) {
                reject(err);
            });
        });
    });
}

function moveToOutputFolder(name, path) {
    return new Promise((resolve, reject) => {
        const outputFileExt = path.split(".")[1];
        const origNameNoExt = name.split(".").slice(0, -1).join(".");
        let newPath = "/tmp/cloud_uploads/output/";

        if (outputFileExt === "hevc") {
            newPath += origNameNoExt + ".hevc";
        } else {
            newPath += origNameNoExt + ".hevc." + outputFileExt;
        }

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

function checkIfAudioTrackExists(info) {
    return new Promise((resolve, reject) => {
        info.streams.forEach(function(stream) {
            if (stream.codec_type === "audio")
                resolve(1);
        });
        resolve(0);
    });
}

function validateVideoOptions(video_info) {
    return Promise.all([
        parser.validateResolution(video_info.streams[0].width + "x" + video_info.streams[0].height),
        parser.validateFrameRate(video_info.streams[0].avg_frame_rate),
        checkIfAudioTrackExists(video_info)
    ]);
}

function decodeVideo(fileOptions, kvazaarOptions, taskInfo) {
    let promise = new Promise((resolve, reject) => {
        ffprobe(fileOptions.file_path, { path: ffprobeStatic.path })
        .then((info) => {
            return validateVideoOptions(info);
        })
        .then((validated_options) => {
            fileOptions.resolution        = validated_options[0];
            kvazaarOptions["input-fps"]   = validated_options[1];

            let promises = [
                callFFMPEG([fileOptions.file_path], ["-r", kvazaarOptions['input-fps']],
                            fileOptions.tmp_path + ".yuv", ["-f", "rawvideo", "-pix_fmt", "yuv420p"])
            ];

            // extract audio if it's viable (users wants the output to contain the audio track
            // and there's an audio track to extract [video is not raw])
            if (fileOptions.container !== "none" && fileOptions.raw_video === 0 && validated_options[2] === 1) {
                console.log("AUDIO TRACK PRESENT!");
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
function kvazaarEncode(videoLocation, fileOptions, kvazaarOptions, taskInfo) {
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

        let kvz_exec = "kvazaar";

        if (kvazaarOptions["input-bitdepth"] === 10) {
            kvz_exec = "kvazaar_10bit";
        }

        const child = spawn(kvz_exec, options);

        // update currentJobPid so we can kill the process if user so requests
        currentJobPid = child.pid;

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

// subtask has been finished, update db and send status message to user
function updateWorkerStatus(taskInfo, fileId, currentJob) {
    return new Promise((resolve, reject) => {
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

        db.updateTask(taskInfo.taskid, { status : currentJob }).then(() => {
            nrp.emit('message', {
                type: "update",
                reply: "task",
                data: {
                    user: taskInfo.owner_id,
                    file_id: fileId,
                    token: taskInfo.token,
                    status: currentJob,
                    message: message,
                }
            });
            resolve();
        });
    });
}

// raw video doesn't require any preprocessing (at least for now)
function preprocessRawVideo(fileOptions) {
    return new Promise((resolve, reject) => {
        if (fileOptions.video_format === "yuv420p") {
            resolve(["", fileOptions.file_path]);
        }

        // kvazaar only understands yuv420p, do some converting
        let inputOptions = [ ];

        if (fileOptions.video_format === "h264") {
            inputOptions.push("-f", "h264")
        } else {
            inputOptions.push("-pix_fmt", fileOptions.video_format, "-s", fileOptions.resolution);
            inputOptions.push("-r", fileOptions.fps, "-vcodec", "rawvideo", "-f", "rawvideo");
        }

        callFFMPEG([fileOptions.file_path], inputOptions,
                    fileOptions.tmp_path + ".yuv", ["-f", "rawvideo", "-pix_fmt", "yuv420p"])
        .then(() => {
            resolve(["", fileOptions.tmp_path + ".yuv"]);
        })
        .catch(function(err) {
            reject(err);
        });
    });
}

// post-processing is needed only if user wants the output to be in container
function postProcessVideo(encodedVideoName, fileOptions) {
    return new Promise((resolve, reject) => {
        if (fileOptions.container !== "none")
            resolve(ffmpegContainerize(encodedVideoName, fileOptions.tmp_path + ".wav", fileOptions.container));
        else
            resolve(encodedVideoName);
    });
}

// the driving force of worker, all steps are sequential
// and f.ex. video decoding must finish before we can start encoding it
function processFile(fileOptions, kvazaarOptions, taskInfo, done) {
    let preprocessFile = null;

    if (fileOptions.raw_video === 1) {
        preprocessFile = preprocessRawVideo(fileOptions);
    } else {
        preprocessFile = Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.DECODING),
            decodeVideo(fileOptions, kvazaarOptions, taskInfo)
        ]);
    }

    preprocessFile.then((rawVideoName) => {
        return Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.ENCODING),
            kvazaarEncode(rawVideoName[1], fileOptions, kvazaarOptions, taskInfo)
        ]);
    })
    .then((encodedVideoName) => {
        return Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.file_id, workerStatus.POSTPROCESSING),
            postProcessVideo(encodedVideoName[1], fileOptions)
        ]);
    })
    .then((path) => {
        return moveToOutputFolder(fileOptions.name, path[1]);
    })
    .then((newPath) => {
        // update file path to database so user can download the file,
        // remove all intermediate files and end this task
        db.updateTask(taskInfo.taskid, { file_path : newPath }).then(() => {
            removeArtifacts(fileOptions.tmp_path, fileOptions);
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.READY);
            done();
        }, (reason) => {
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, workerStatus.FAILURE);
            removeArtifacts(fileOptions.tmp_path, fileOptions);
            console.log(reason);
            done();
        });
    })
    .catch(function(reason) {
        let taskStatus = workerStatus.FAILURE;

        if (taskCancelled === true)
            taskStatus = workerStatus.CANCELLED;

        updateWorkerStatus(taskInfo, fileOptions.uniq_id, taskStatus);
        removeArtifacts(fileOptions.tmp_path, fileOptions);
        console.log(reason);
        done();
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

            // update currentJobToken so that cancel request can be processed
            currentJobToken = job.data.task_token;

            processFile(values[0], values[1], taskRow, done);
        });
    })
    .catch(function(err) {
        console.log(err);
    });
});
