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
const constants = require("./constants");

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
    var files = [".txt", "_logo.yuv", ".hevc"];

    // decodeVideo creates temporary yuv file
    if (fileOptions.raw_video === 0) {
        files.push(".yuv");
    }

    if (fileOptions.container !== "none") {
        //files.push("_new.hevc");

        // raw video files don't have audio tracks
        if (fileOptions.raw_video === 0) {
            files.push("_audio.mp4");
            files.push("_audio.mp4.audio_info.txt");
        }            
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
            options.push(input);
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
            let inputs = ["-fflags","+genpts","-i", videoPath ];
            let outputOptions = [ "-c:v", "copy" ];

            if (!err) {
                try {
                    console.log("Reading audio info "+audioPath + ".audio_info.txt");
                    let audioOptionsRaw = fs.readFileSync(audioPath + ".audio_info.txt");
                    audioOptions = JSON.parse(audioOptionsRaw);
                } catch(e) {
                    console.log("Failed to open .audio_info.txt");
                }
                inputs = inputs.concat(["-i",audioPath]);
                outputOptions.push("-async", "1", "-c:a", "copy");
            }

            // There's a bug somewhere in ffmpeg, cloud or kvazaar which causes
            // mkv containers not to work (something about missing timestamps)
            // this bug can be mitigated by first using mp4 and converting the mp4 to mkv
            callFFMPEG(inputs, [], tmpPath, outputOptions).then(() => {
                if (container === "mkv")
                    return callFFMPEG(["-i",tmpPath], [], newPath, ["-c:v", "copy", "-c:a", "copy"]);
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
        let newPath = "/tmp/cloud_uploads/output/";
        let origNameNoExt = name.split(".").slice(0, -1).join(".");

        // in case the file name is not in "standard format"
        // (standard format being: "someletter maybewhitespace_andunderscore.extension")
        //
        // the code above for orignal name extraction may fail and it returns an empty string
        // which is not a valid name for output. Use unix timestamp as a fallback
        if (origNameNoExt === "") {
            origNameNoExt = new Date().getTime();
        }

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

    callFFMPEG(["-i","/tmp/cloud_uploads/misc/logo.png"], [],
               pathPrefix + "_logo.yuv", ["-vf", "scale=" + resolution.replace('x', ':') + ",setdar=1:1", "-pix_fmt", "yuv420p","-f", "rawvideo"])
    .then(() => {
        // Concat logo with the original video
        //console.log("Executing: "+"cat "+video_path+".logo.yuv"+ " >> "+video_path);
        exec("cat "+pathPrefix+"_logo.yuv"+ " >> "+video_path, (err, stdout, stderr) => {
            if (err) {
               // node couldn't execute the command
               throw err;
            }
            callback(null, video_path);
        });
    }, (reason) => {
        callback(reason);
    });
}

function checkIfAudioTrackExists(fileOptions, info) {
    return new Promise((resolve, reject) => {
        info.streams.forEach(function(stream) {
            if (stream.codec_type === "audio") {
                console.log("Writing audio info "+fileOptions.tmp_path + "_audio.mp4.audio_info.txt");
                const fd = fs.openSync(fileOptions.tmp_path + "_audio.mp4.audio_info.txt", "wx");
                if (!fd)
                    resolve(0);
                let fileData = JSON.stringify(stream);
                fs.writeSync(fd, fileData);
                fs.closeSync(fd);
                resolve(1);                    
            }
        });
        resolve(0);
    });
}

function validateVideoOptions(fileOptions, video_info) {
    var videoStream = 0;
    for(var i = 0; i < video_info.streams.length; i++) {
        if(video_info.streams[i].codec_type === "video") {
            videoStream = i;
            break;
        }
    }
    return Promise.all([
        parser.validateResolution(video_info.streams[videoStream].width + "x" + video_info.streams[videoStream].height),
        parser.validateFrameRate(video_info.streams[videoStream]),
        checkIfAudioTrackExists(fileOptions, video_info)
    ]);
}

function decodeVideo(fileOptions, kvazaarOptions, taskInfo) {
    let promise = new Promise((resolve, reject) => {
        ffprobe(fileOptions.file_path, { path: ffprobeStatic.path })
        .then((info) => {
            return validateVideoOptions(fileOptions, info);
        })
        .then((validated_options) => {
            fileOptions.resolution        = validated_options[0];
            kvazaarOptions["input-fps"]   = validated_options[1];

            let promises = [
                callFFMPEG(["-noautorotate","-i",fileOptions.file_path], [],
                            fileOptions.tmp_path + ".yuv", ["-f", "rawvideo", "-pix_fmt", "yuv420p"])
            ];

            // extract audio if it's viable (users wants the output to contain the audio track
            // and there's an audio track to extract [video is not raw])
            if (fileOptions.container !== "none" && fileOptions.raw_video === 0 && validated_options[2] === 1) {
                console.log("AUDIO TRACK PRESENT!");
                promises.push(callFFMPEG(["-i", fileOptions.file_path], [],
                              fileOptions.tmp_path + "_audio.mp4", ["-vn", "-codec:a", "copy"]));
            }

            return Promise.all(promises);
        })
        .then(() => {
            resolve(fileOptions.tmp_path + ".yuv");
        })
        .catch(function(err) {
           console.log(err);
            // If output is at least one frame, process it and ignore the error
            try {
              fs.stat(fileOptions.tmp_path + ".yuv",function(err2, data) {
                  if (err2)
                    reject(err);

                  let resolutionSplit = fileOptions.resolution.split('x');
                  if(!isNaN(resolutionSplit[0]) && !isNaN(resolutionSplit[1])) {
                      // Has to be at least one frame Width*Height*1.5
                      if(data.size >= parseInt(resolutionSplit[0])*parseInt(resolutionSplit[1])*1.5) {
                          resolve(fileOptions.tmp_path + ".yuv");
                      }
                  }                
                  reject(err);
              });
            } catch(err2) {
              reject(err);
            }
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

       addLogo(videoLocation, fileOptions.resolution, function(err, newPath) {
          if (err)
              reject(err);
        });

        const child = spawn("kvazaar", options);

        // update currentJobPid so we can kill the process if user so requests
        currentJobPid = child.pid;

        let stderr = "";
        child.stdout.on("data", function(data) { });
        child.stderr.on("data", function(data) { stderr += data.toString(); });

        child.on("exit", function(code, signal) {
            if (code === 0) {
                resolve(fileOptions.tmp_path + ".hevc");
            } else {
                reject(new Error("kvazaar failed with exit code " + code));
                console.log(options);
                console.log(stderr);
            }
        });
    });
}

// subtask has been finished, update db and send status message to user
function updateWorkerStatus(taskInfo, fileId, currentJob, fileInfo) {
    return new Promise((resolve, reject) => {
        let message = "";

        switch (currentJob) {
            case constants.READY:          message = "Done!";             break;
            case constants.FAILURE:        message = "Request failed!";   break;
            case constants.WAITING:        message = "Queued";            break;
            case constants.DECODING:       message = "Decoding";          break;
            case constants.ENCODING:       message = "Encoding";          break;
            case constants.CANCELLED:      message = "Request cancelled"; break;
            case constants.UPLOADING:      message = "Uploading file";    break;
            case constants.POSTPROCESSING: message = "Post-processing";   break;
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
                    size:     (fileInfo !== undefined) ? fileInfo[0] : null,
                    duration: (fileInfo !== undefined) ? fileInfo[1] : null
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
            resolve(fileOptions.file_path);
        }

        // kvazaar only understands yuv420p, do some converting
        let inputOptions = [ ];

        if (fileOptions.video_format === "h264") {
            inputOptions.push("-f", "h264")
        } else {
            inputOptions.push("-pix_fmt", fileOptions.video_format, "-s", fileOptions.resolution);
            inputOptions.push("-r", fileOptions.fps, "-vcodec", "rawvideo", "-f", "rawvideo");
        }

        callFFMPEG(["-i",fileOptions.file_path], inputOptions,
                    fileOptions.tmp_path + ".yuv", ["-f", "rawvideo", "-pix_fmt", "yuv420p"])
        .then(() => {
            resolve(fileOptions.tmp_path + ".yuv");
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
            resolve(ffmpegContainerize(encodedVideoName, fileOptions.tmp_path + "_audio.mp4", fileOptions.container));
        else
            resolve(encodedVideoName);
    });
}

function getFileSizeAndDuration(path) {
    return new Promise((resolve, reject) => {
        let fileSize = ((fs.statSync(path).size) / 1000 / 1000).toFixed(2) + " MB";

        ffprobe(path, { path: ffprobeStatic.path })
        .then((video_info) => {
            var videoStream = 0;

            for (var i = 0; i < video_info.streams.length; ++i) {
                if (video_info.streams[i].codec_type === "video") {
                    videoStream = i;
                    break;
                }
            }

            let duration = parseInt(video_info.streams[i].duration);

            if (isNaN(duration)) {
                duration = null;
            } else {
                duration = (duration < 60)
                    ? duration + " s"
                    : duration = (duration / 60).toFixed(0) + " min " + duration % 60 + " s";
            }

            resolve([path, fileSize, duration]);
        })
        .catch(function(err) {
           console.log(err);
           reject(err);
        });
    });
}

// the driving force of worker, all steps are sequential
// and f.ex. video decoding must finish before we can start encoding it
function processFile(fileOptions, kvazaarOptions, taskInfo, done) {
    let preprocessFile = null;

    if (fileOptions.raw_video === 1) {
        preprocessFile = Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, constants.DECODING),
            preprocessRawVideo(fileOptions)
        ]);
    } else {
        preprocessFile = Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, constants.DECODING),
            decodeVideo(fileOptions, kvazaarOptions, taskInfo)
        ]);
    }

    preprocessFile.then((rawVideoName) => {
        return Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, constants.ENCODING),
            kvazaarEncode(rawVideoName[1], fileOptions, kvazaarOptions, taskInfo)
        ]);
    })
    .then((encodedVideoName) => {
        return Promise.all([
            updateWorkerStatus(taskInfo, fileOptions.file_id, constants.POSTPROCESSING),
            postProcessVideo(encodedVideoName[1], fileOptions)
        ]);
    })
    .then((path) => {
        return moveToOutputFolder(fileOptions.name, path[1]);
    })
    .then((newPath) => {
        return getFileSizeAndDuration(newPath);
    })
    .then((fileInfo) => {

        const info = {
            file_path: fileInfo[0],
            file_size: fileInfo[1],
            file_duration: fileInfo[2]
        };

        // update file path to database so user can download the file,
        // remove all intermediate files and end this task
        db.updateTask(taskInfo.taskid, info).then(() => {
            removeArtifacts(fileOptions.tmp_path, fileOptions);
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, constants.READY, [info.file_size, info.file_duration]);
            done();
        }, (reason) => {
            updateWorkerStatus(taskInfo, fileOptions.uniq_id, constants.FAILURE);
            removeArtifacts(fileOptions.tmp_path, fileOptions);
            console.log(reason);
            done();
        });
    })
    .catch(function(reason) {
        let taskStatus = constants.FAILURE;

        if (taskCancelled === true)
            taskStatus = constants.CANCELLED;

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
