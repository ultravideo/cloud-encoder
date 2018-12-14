// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var numFiles = 0;
var fileIds = [];
var fileID = null;
var response = null;
var connection = new WebSocket('ws://127.0.0.1:8083');
var userToken  = generate_random_string(64);

var r = new Resumable({
    target: '/upload',
    chunkSize: 5 * 1024 * 1024,
    simultaneousUploads: 1,
    testChunks: false,
    throttleProgressCallbacks: 1,
    query: {
        token: userToken
    }
});

function generate_random_string(string_length){
    let random_string = '';
    let random_ascii;
    let ascii_low = 65;
    let ascii_high = 90

    for(let i = 0; i < string_length; i++) {
        random_ascii = Math.floor((Math.random() * (ascii_high - ascii_low)) + ascii_low);
        random_string += String.fromCharCode(random_ascii)
    }
    return random_string
}


// check from server side if the file is available
// Server response is handled in connection.onmessage below
function sendDownloadRequest(token) {
    console.log("sending download request..");
    connection.send(JSON.stringify({
        type: "download",
        token: token
    }));
}

// server gave us response regarding file download
// the download request may have been rejected (file doesn't exist or
// download limit has been exceeded) in which case we remove this div
// from #files and inform user about it
//
// if the download request has been approved, download the file
function downloadFile(response) {
    if (response.status === "accepted") {
        var win = window.open("http://localhost:8080/download/" + response.misc, '_blank');
        win.focus();
    } else if (response.status === "rejected") {
        alert(response.misc);
    } else if (response.status === "exceeded") {
        confirm(response.misc);
        $("#" + response.file_id).remove();
        $(".resumable-file-" + response.file_id).remove();
    }
}

// append new message to request's own div
//
// create div if it doesn't exist
function appendToDiv(message_data) {
    $('#files').show();

    if ($("#" + message_data.token).length == 0) {
        $("#files").append("<br><div id='" + message_data.token + "' class='file-request'></div>");
        $("#" + message_data.token).append("<h2>" + r.files[r.files.length - 1].fileName + "</h2>");
        $("#" + message_data.token).show();
    }

    var message = "";

    if (message_data.status === 1) {
        message = "<div class='status-msg-starting'>" + message_data.message + "</div><br>";
    } else if (message_data.status === 2) {
        $("#" + message_data.token + " div:last").hide();
        message = "<div class='status-msg-ready'>" + message_data.message + "</div><br>";
    } else if (message_data.status === 3) {
        message = "<div class='status-msg-error'>" + message_data.message + "</div><br>";
    } else if (message_data.misc === undefined) {
        message = "<div>" + message_data.message + "</div>"
    } else {
        message = "<div>" + "<button onclick=\"sendDownloadRequest('" + message_data.misc +
                  "')\">Download video</button>" + "</div><br>";
    }

    $("#" + message_data.token).append(message);
}

// Resumable.js isn't supported, fall back on a different method
if(!r.support) {
    $('.resumable-error').show();
} else {
    r.assignBrowse($('#browseButton'));

    $('#submitButton').click(function(){
        if (numFiles == 0) {
            console.log("no files");
            alert("select file!");
            return;
        }

        var other_options = {}, kvz_options = {};
        $(".kvz_options").serializeArray().map(function(x){kvz_options[x.name] = x.value;});
        $(".options").serializeArray().map(function(x){other_options[x.name] = x.value;});

        var options = { 'type' : 'options', 'token': userToken, 'kvazaar' : kvz_options, 'other' : other_options };
        options['other']['file_id'] = fileID;

        if (other_options.raw_video && other_options.raw_video === "on" && other_options.resolution === "") {
            document.getElementById("resMissing").style.display = "block";
            return;
        } else {
            document.getElementById("resMissing").style.display = "none";
        }

        console.log("sent options...");
        connection.send(JSON.stringify(options));
    });

    // Handle file add event
    r.on('fileAdded', function(file){
        // Show progress pabr
        $('.resumable-progress, .resumable-list').show();
        $('.resumable-progress .progress-resume-link').hide();
        $('.resumable-progress .progress-pause-link').hide();
        $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html(0 + '%');
        $('.progress-bar').css({width:0 + '%'});

        // Add the file to the list
        $('.resumable-list').append('<li class="resumable-file-'+file.uniqueIdentifier+'">'
            + '<span class="resumable-file-name"></span> <span class="resumable-file-progress">ready for upload</span>');
        $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-name').html(file.fileName);

        fileID = file.uniqueIdentifier;
        numFiles = 1;

        // try to extract video resolution from name
        if ($("#resValue").val() === "") {
            var str = r.files[r.files.length - 1].fileName.toString();
            var res  = str.match(/[0-9]{1,4}\x[0-9]{1,4}/g);

            if (res && res.length != 0) {
                $("#resValue").val(res[0]);
            }
        }

        $("#submitButton").prop("disabled", false);
    });

    r.on('pause', function(){
        // Show resume, hide pause
        $('.resumable-progress .progress-resume-link').show();
        $('.resumable-progress .progress-pause-link').hide();
    });

    r.on('complete', function(){
        // Hide pause/resume when the upload has completed
        $('.resumable-progress .progress-resume-link, .resumable-progress .progress-pause-link').hide();
    });

    r.on('fileSuccess', function(file,message){
        // Reflect that the file upload has completed
        $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html('(completed)');
    });

    r.on('fileError', function(file, message){
        // Reflect that the file upload has resulted in error
        $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html('(file could not be uploaded: '+message+')');
    });

    r.on('fileProgress', function(file){
        // Handle progress for both the file and the overall upload
        $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html(Math.floor(file.progress()*100) + '%');
        $('.progress-bar').css({width:Math.floor(r.progress()*100) + '%'});
    });

    r.on('cancel', function(){
        $('.resumable-file-progress').html('canceled');
        $("#submitButton").prop("disabled", true);
        numFiles = 0;
    });

    r.on('uploadStart', function(){
        // Show pause, hide resume
        $('.resumable-progress .progress-resume-link').hide();
        $('.resumable-progress .progress-pause-link').show();
    });

    // WebSocket stuff
    connection.onopen = function() {
        console.log("connection established");

        // generate token for this connection so server knows to
        // send status updates to correct client
        let message = {
            type: "init",
            token: userToken
        };

        connection.send(JSON.stringify(message));
        console.log(JSON.stringify(message));
    };

    connection.onmessage = function(message) {
        var message_data = null;

        try {
            message_data = JSON.parse(message.data);
        } catch (e) {
            console.log(message.data);
            console.log(e);
            return;
        }

        if (message_data.message != null) {
            appendToDiv(message_data);
        }

        // server send us message regarding resumable upload process
        if (message_data.type === "action") {
            if (message_data.reply == "upload") {
                $('.resumable-progress .progress-resume-link').hide();
                $('.resumable-progress .progress-pause-link').show();
                r.upload();
            } else if (message_data.reply == "cancel") {
                r.cancel();
                $('.resumable-list').empty();
            } else if (message_data.reply == "pause") {
                r.pause();
            } else if (message_data.reply == "continue") {
                r.upload();
            } else if (message_data.reply === "download") {
                downloadFile(message_data);
            }
        }
    };

    connection.onclose = function(error) {
        console.log("connection closed...");
    };

    connection.onerror = function(error) {
        console.log(error);
    };
}
