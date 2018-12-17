// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var numFiles = 0;
var fileIds = [];
var fileID = null;
var response = null;
var connection = new WebSocket('ws://127.0.0.1:8083');
var userToken  = generate_random_string(64);
var numRequests = 0; // TODO save this info to cookie

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

function updateRequestCount() {
    $("#linkRequests").text("My request (" + numRequests + ")");
}

function incRequestCount() {
    ++numRequests
    updateRequestCount();
}

function decRequestCount() {
    --numRequests
    updateRequestCount();
}

// check from server side if the file is available
// Server response is handled in connection.onmessage below
function sendDownloadRequest(token) {
    console.log("sending download request..");
    connection.send(JSON.stringify({
        type: "downloadRequest",
        token: token
    }));
}

// delete task from database
function sendDeleteRequest(token) {
    console.log("sending delete request...");
    connection.send(JSON.stringify({
        type: "deleteRequest",
        token: token,
    }));
}

// task is active -> stop all work on it,
// remove it from work queue and from database
function cancelTask(token) {
    console.log("sending cancel request...");
    connection.send(JSON.stringify({
        type: "cancelRequest",
        token: token,
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
        $("#table" + response.file_id + " #tdDownloadCount").html("Downloads left: " + (2 - response.count));
        var win = window.open("http://localhost:8080/download/" + response.misc, '_blank');
        win.focus();
    } else if (response.status === "rejected") {
        alert(response.misc);
    } else if (response.status === "exceeded") {
        // TODO use bootstrap modal here
        confirm(response.misc);

        decRequestCount();
        $("#" + response.file_id).remove();
        $("#table" + response.file_id).remove();
        $(".resumable-file-" + response.file_id).remove();
    }
}

// TODO comment
function drawFileTable(file) {
    let newHTML = 
        "<table id='table" + file.uniq_id + "'><tr><td>" + file.name + "</td>";

    if (file.status === 4) {
        newHTML +=
            "<td align='right'><button id='btnDownload' class='btn btn-success' " +
                "onclick=\"sendDownloadRequest('" + file.token + "')\">Download</button></td>" +
            "<td align='right'><button id='btnDelete' class='btn btn-danger' " + 
                "onclick=\"sendDeleteRequest('" + file.token + "')\">Delete</button></td></tr>";
    } else {
        newHTML +=
            "<td align='right'><button id='btnDownload' class='btn btn-success' disabled>Download</button></td>" +
            "<td align='right'><button id='btnDelete'   class='btn btn-danger' " +
                "onclick=\"cancelTask('" + file.token + "')\">Cancel</button></td></tr>";
    }

    newHTML +=
        "<tr><td id='tdDownloadCount' align='left'>Downloads left: " + (2 - file.download_count) + "</td></tr>" +
        "<tr><td id='tdStatus' align='left' id=''>Status: " + file.message + "</td></tr>" +
        "</table><br><br>";

    return newHTML;
}

// TODO comment
function handleTaskResponse(response) {
    $("#divRequests").empty();

    console.log("response:", response);

    if (response.numTasks === 0) {
        $("#divRequests").append("<p>You haven't done anything</p>");
    } else {
        // creating HTML dynamically like this is awful but whatevs
        response.data.forEach(function(file) {
            $("#divRequests").append(drawFileTable(file));
        });
    }
}

// TODO comment
function handleTaskUpdate(response) {
    if ($("#table" + response.file_id).length == 0) {
        // ignore update, "My requests" tab is not active
        console.log("table not present");
    } else {
        console.log("table is present", response.status);
        if (response.status === 4) {
            $("#table" + response.file_id + " #btnDownload").prop("disabled", false);
            $("#table" + response.file_id + " #btnDownload").removeAttr("onclick");
            $("#table" + response.file_id + " #btnDownload").attr("onClick", "sendDownloadRequest('" + response.token + "');");

            // remove Cancel button and add Delete button
            $("#table" + response.file_id + " #btnDelete").text("Delete");
            $("#table" + response.file_id + " #btnDelete").removeAttr("onclick");
            $("#table" + response.file_id + " #btnDelete").attr("onClick", "sendDeleteRequest('" + response.token + "');");
        } 

        $("#table" + response.file_id + " #tdStatus").html(response.message)
    }
}

function handleCancelResponse(response) {
    if (status === "ok") {
        decRequestCount();
        $("#table" + response.file_id).remove();
    } else {
        alert("Failed to cancel request");
    }
}

function handleDeleteResponse(response) {
    if (response.status === "ok") {
        decRequestCount();
        $("#table" + response.file_id).remove();
    } else {
        alert("Failed to delete request, reason: " + response.message);
    }
}

function resetResumable() {
    $(".resumable-list").empty();
    $(".resumable-progress").hide();
    $("#submitButton").prop("disabled", true);

    fileID = null, numFiles = 0, r.files = [];
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
}

$('#submitButton').click(function(){
    if (numFiles == 0) {
        console.log("no files");
        alert("select file!");
        return;
    }

    var other_options = {}, kvz_options = {};
    $(".kvz_options").serializeArray().map(function(x){kvz_options[x.name] = x.value;});
    $(".options").serializeArray().map(function(x){other_options[x.name] = x.value;});

    var options = { 'type' : 'uploadRequest', 'token': userToken, 'kvazaar' : kvz_options, 'other' : other_options };
    options['other']['file_id'] = fileID;
    options['other']['name'] = r.files[r.files.length - 1].fileName.toString()

    if (other_options.raw_video && other_options.raw_video === "on" && other_options.resolution === "") {
        document.getElementById("resMissing").style.display = "block";
        return;
    } else {
        document.getElementById("resMissing").style.display = "none";
    }

    console.log("sent options...");
    connection.send(JSON.stringify(options));
});

function deActivate(name) {
    $("#div" + name).hide();
    $("#li" + name).removeClass("active");
}

function activateView(name) {
    $("#div" + name).show();
    $("#li" + name).addClass("active");
}

$("#linkUpload").click(function() {
    if ($("#divUpload").is(":hidden")) {
        resetResumable();
    }

    deActivate("About");
    deActivate("Requests");
    activateView("Upload")
});

$("#linkRequests").click(function() {
    // send query only if linkRequests tab isn't active
    if ($("#divRequests").is(":hidden")) {
        connection.send(JSON.stringify({
            user: userToken,
            type: "taskQuery"
        }));
    }

    deActivate("About");
    deActivate("Upload");
    activateView("Requests")
});

$("#linkAbout").click(function() {
    deActivate("Requests");
    deActivate("Upload");
    activateView("About")
});

// ------------------------------- Resumablejs stuff ------------------------------- 
r.on('fileAdded', function(file){
    // remove previously selected files
    $('.resumable-list').empty();
    r.files = r.files.slice(-1);

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

    let fname = r.files[r.files.length - 1].fileName.toString();

    // set raw video to true if file extension is yuv
    if ($("#rawVideoCheck").is(":checked") === false) {
        let res  = fname.match(/\.yuv$/g);

        if (res && res.length != 0) {
            $("#rawVideoCheck").click();
        } 
    } else {
        let res  = fname.match(/\.yuv$/g);

        if (!res) {
            $("#rawVideoCheck").click();
            $("#resValue").val("");
        } 
    }

    // try to match file resolution from name
    let res  = fname.match(/[0-9]{1,4}\x[0-9]{1,4}/g);
    if (res && res.length != 0) {
        $("#resValue").val(res[0]);
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


// ------------------------------- WebSocket stuff ------------------------------- 
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

    // server send us message regarding resumable upload process
    if (message_data.type === "action") {
        if (message_data.reply === "uploadResponse") {
            if (message_data.status === "upload") {
                $(".resumable-progress .progress-resume-link").hide();
                $(".resumable-progress .progress-pause-link").show();
                r.upload();
            } else if (message_data.status === "request_ok") {
                resetResumable();
                incRequestCount();
                $(".resumable-list").html("<br><br><br>File already in the server, request has been added to work queue");
            } else {
                resetResumable();
                $(".resumable-list").html("<br><br><br>You have already made this request, check \"My requests\" tab");
            }
        } else if (message_data.reply == "cancel") {
            r.cancel();
            $('.resumable-list').empty();
        } else if (message_data.reply == "pause") {
            r.pause();
        } else if (message_data.reply == "continue") {
            incRequestCount();
            r.upload();
        } else if (message_data.reply === "downloadResponse") {
            downloadFile(message_data);
        } else if (message_data.reply === "taskResponse") {
            handleTaskResponse(message_data);
        }  else if (message_data.reply === "taskUpdate") {
            handleTaskUpdate(message_data);
        } else if (message_data.reply === "deleteResponse") {
            handleDeleteResponse(message_data);
        } else if (message_data.reply === "cancelResponse") {
            handleCancelResponse(message_data);
            
        }
    }
};

connection.onclose = function(error) {
    console.log("connection closed...");
};

connection.onerror = function(error) {
    console.log(error);
};
