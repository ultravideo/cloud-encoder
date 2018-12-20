// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var fileID = null;
// var response = null;
var connection = new WebSocket('ws://127.0.0.1:8083');
var userToken = getUserToken();
var numRequests = 0;
var uploadFileToken = null;

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

function getUserToken() {
    let token = Cookies.get("cloudUserToken");

    if (!token) {
        token = generate_random_string(64);

        Cookies.set("cloudUserToken", token,
            { expires: 365, path: "" }
        );
    }

    return token;
}

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
    $("#linkRequests").text("My requests (" + numRequests + ")");
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
        $("#table" + response.token + " #tdDownloadCount").html("Downloads left: " + (2 - response.count));
        var win = window.open("http://localhost:8080/download/" + response.token, '_blank');
        win.focus();
    } else if (response.status === "rejected") {
        alert(response.message);
    } else if (response.status === "exceeded") {
        // TODO use bootstrap modal here
        confirm(response.message);

        console.log(response);

        decRequestCount();
        $("#" + response.token).remove();
        $("#table" + response.token).remove();
        $(".resumable-file-" + response.token).remove();
    }
}

// TODO comment
function drawFileTable(file) {

    let newHTML = 
        "<span class='border'>" + 
        "<table id='table" + file.token + "'><tr><td><h4>" + file.name + "</h4></td></tr>";

    Object.keys(file.options).forEach(function(key) {
        newHTML += "<tr><td align='left'>" + key + ": " + file.options[key] + "</td></tr>";
    });

    newHTML +=
        "<tr><td id='tdDownloadCount' align='left'>Downloads left: " + (2 - file.download_count) + "</td></tr>" +
        "<tr><td id='tdStatus' align='left'>Status: " + file.message + "</td></tr>";

    if (file.status === 4) {
        newHTML +=
            "<tr><td align='left'><button id='btnDownload' class='btn btn-success' " +
            "onclick=\"sendDownloadRequest('" + file.token + "')\">Download</button>" +
            "<button class='btn btn-danger' data-toggle='modal'" + 
            "data-href='" + file.token + "' data-target='#confirm-delete'>Delete</button></td>";
    } else {
        newHTML +=
            "<tr><td align='left'><button id='btnDownload' class='btn btn-success' disabled>Download</button>" +
            "<button id='btnDelete'   class='btn btn-danger' " +
            "<button class='btn btn-danger' data-toggle='modal'" + 
            "data-href='" + file.token + "' data-target='#confirm-cancel'>Cancel</button></td>";
    }

    newHTML += "</tr></table></span><br><br>";

    return newHTML;
}

// TODO comment
function handleTaskResponse(response) {
    $("#divRequests").empty();

    if (response.numTasks === 0) {
        $("#divRequests").append("<p>You haven't made requests</p>");
    } else {
        numRequests = response.data.length;
        updateRequestCount();

        // creating HTML dynamically like this is awful but whatevs
        response.data.forEach(function(file) {
            $("#divRequests").append(drawFileTable(file));
        });
    }
}

// TODO comment
function handleTaskUpdate(response) {
    if ($("#table" + response.token).length == 0) {
        // ignore update, "My requests" tab is not active
    } else {
        if (response.status === 4) {
            $("#table" + response.token + " #btnDownload").prop("disabled", false);
            $("#table" + response.token + " #btnDownload").removeAttr("onclick");
            $("#table" + response.token + " #btnDownload").attr("onClick", "sendDownloadRequest('" + response.token + "');");

            // remove Cancel button and add Delete button
            $("#table" + response.token + " #btnDelete").text("Delete");
            $("#table" + response.token + " #btnDelete").attr("data-target", "#confirm-delete");
        } 

        $("#table" + response.token + " #tdStatus").html(response.message)
    }
}

function handleCancelResponse(response) {
    if (status === "ok") {
        decRequestCount();
        $("#table" + response.token).remove();
    } else {
        alert("Failed to cancel request");
    }
}

function handleDeleteResponse(response) {
    if (response.status === "ok") {
        console.log("deleting table", response.token);
        decRequestCount();
        $("#table" + response.token).remove();
    } else {
        alert("Failed to delete request, reason: " + response.message);
    }
}

function resetUploadFileInfo() {
    fileID = null;
    uploadFileToken = null;
    r.files = [];
};

function resetResumable() {
    $(".resumable-list").empty();
    $(".resumable-progress").hide();
    $("#submitButton").prop("disabled", true);

    resetUploadFileInfo();
}

function validateResolution(str) {
    let res  = str.toString().match(/^[0-9]{1,4}\x[0-9]{1,4}$/g), resVal = "";

    if (res && res.length != 0) {
        resVal = res[0];
        $("#resMissing").hide();
    }
    $("#resValue").val(resVal);
}

function validateInputFPS(str) {
    let fps = str.toString().match(/^[1-9]{1}[0-9]{0,2}$/g), fpsVal = "";

    if (fps && fps.length != 0) {
        fpsVal = fps[0]; // extract only the number
        $("#inputFPSMissing").hide();
    }
    $("#inputFPSValue").val(fpsVal);
}

function validateBithDepth(str) {
    let bitDepth = str.toString().match(/^([89]|1[0-6])$/g), bitDepthVal = "";

    if (bitDepth && bitDepth.length != 0) {
        bitDepthVal = bitDepth[0]; // extract only the number
        $("#bitDepthMissing").hide();
    }
    $("#bitDepthValue").val(bitDepthVal);
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
    r.assignDrop($('.resumable-drop')[0]);
    r.assignBrowse($('.resumable-browse')[0]);
}

$("#rawVideoCheck").click(function() {
    $("#rawDiv").toggle();
});

$("#kvazaarCmdButton").click(function() {
    if ($("#kvazaarExtraOptionsDiv").is(":hidden")) {
        $("#kvazaarExtraOptionsDiv").show();
        $("<br>").insertAfter("#kvazaarExtraOptions");
    }
});

$('#confirm-delete').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendDeleteRequest('" +  $(e.relatedTarget).data('href') + "')");
});

$('#confirm-cancel').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendCancelRequest('" +  $(e.relatedTarget).data('href') + "')");
});

$('#submitButton').click(function(){
    if (fileID === null) {
        return;
    }

    $("#submitButton").prop("disabled", false);

    var other_options = {}, kvz_options = {};
    $(".kvz_options").serializeArray().map(function(x){kvz_options[x.name] = x.value;});
    $(".options").serializeArray().map(function(x){other_options[x.name] = x.value;});

    var options = { 'type' : 'uploadRequest', 'token': userToken, 'kvazaar' : kvz_options,
                    'kvazaar_extra' : $("#kvazaarExtraOptions").val(), 'other' : other_options };
    options['other']['file_id'] = fileID;
    options['other']['name'] = r.files[r.files.length - 1].fileName.toString();

    // make sure that user has entered all necessary values for raw video
    if (other_options.raw_video === "on") {
        $("#resMissing").hide();
        $("#inputFPSMissing").hide();
        $("#bitDepthMissing").hide();
        let error = false;

        if (other_options.resolution === "") {
            $("#resMissing").show();
            error = true;
        }

        if (other_options.inputFPS === "") {
            $("#inputFPSMissing").show();
            error = true;
        }

        if (other_options.bitDepth === "") {
            $("#bitDepthMissing").show();
            error = true;
        }

        if (error)
            return;
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
    if ($("#divUpload").is(":hidden") && !r.isUploading()) {
        resetResumable();
        if ($("#rawVideoCheck").is(":checked") === true) {
            $("#rawVideoCheck").click();
            $("#rawDiv").hide();
            $("#kvazaarExtraOptionsDiv").hide();
        }
    }

    if (!r.isUploading()) {
        $("#dlDoneInfo").hide();
        $(".resumable-drop").show();
    }

    deActivate("About");
    deActivate("Requests");
    activateView("Upload")
});

function showRequests() {
    // send query only if linkRequests tab isn't active
    if ($("#divRequests").is(":hidden")) {
        connection.send(JSON.stringify({
            user: userToken,
            type: "taskQuery"
        }));
    }

    deActivate("About");
    deActivate("Upload");
    activateView("Requests");
}

$("#linkRequests").click(showRequests);
$("#linkRequestLink").click(showRequests);

$("#linkAbout").click(function() {
    deActivate("Requests");
    deActivate("Upload");
    activateView("About")
});

$("#resValue").focusout(function() {
    validateResolution($("#resValue").val())
});

$("#inputFPSValue").focusout(function() {
    validateInputFPS($("#inputFPSValue").val());
});

$("#bitDepthValue").focusout(function() {
    validateBithDepth($("#bitDepthValue").val());
});

$("#presetDropDown").change(function() {
    $("#presetSlider").val($("#presetDropDown").val());
});

$("#presetSlider").change(function() {
    $("#presetDropDown").val($("#presetSlider").val());
});

// ------------------------------- Resumablejs stuff ------------------------------- 
r.on('fileAdded', function(file){
    // remove previously selected files
    $('.resumable-list').empty();
    r.files = r.files.slice(-1);

    // hide raw video related warnings
    $(".rawVideoWarning").hide();

    // hide drag and drop
    $(".resumable-drop").hide();

    // hide download info
    $("#dlDoneInfo").hide();

    $(".progress-cancel-link").show();

    // reset progress-container color
    $('.progress-container').css( "background", "#9CBD94" );

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

    let fname = r.files[r.files.length - 1].fileName.toString();

    // set raw video to true if file extension is yuv
    // if ($("#rawVideoCheck").is(":checked") === false) {
    let res  = fname.match(/\.yuv$/g);
    let checked = $("#rawVideoCheck").is(":checked");

    if (res && res.length != 0) {
        if (checked === false) {
            $("#rawVideoCheck").click();
        }

        // try to match file resolution, fps and bit depth from file name
        let res  = fname.match(/[0-9]{1,4}\x[0-9]{1,4}/g), resVal = "";
        if (res && res.length != 0) {
            resVal = res[0];
        }
        $("#resValue").val(resVal);

        let fps = fname.match(/[1-9]{1}[0-9]{0,2}[-_\s]?(FPS)/ig), fpsVal = "";
        if (fps && fps.length != 0) {
            fpsVal = fps[0].match(/[1-9]{1}[0-9]{0,2}/)[0]; // extract only the number
        }
        $("#inputFPSValue").val(fpsVal);

        let bitDepth = fname.match(/([89]|1[0-6])[_-\s]?(bit)/ig), bitDepthVal = "";
        if (bitDepth && bitDepth.length != 0) {
            bitDepthVal = bitDepth[0].match(/([89]|1[0-6])/)[0]; // extract only the number
        }
        $("#bitDepthValue").val(bitDepthVal);
    }  else {
        if (checked === true) {
            $("#rawVideoCheck").click();
        }

        $("#resValue").val("");
        $("#bitDepthValue").val("");
        $("#inputFPSValue").val("");
    }

    $("#submitButton").prop("disabled", false);
});

r.on('pause', function(){
    // Show resume, hide pause
    $('.resumable-progress .progress-resume-link').show();
    $('.resumable-progress .progress-pause-link').hide();
});

r.on('complete', function(){
    $('.resumable-progress .progress-cancel-link').hide();
    $('.resumable-progress .progress-pause-link').hide();
});

r.on('fileSuccess', function(file,message){
    $('.resumable-file-' + file.uniqueIdentifier + ' .resumable-file-progress').html('(completed)');

    $(".resumable-drop").show();
    resetUploadFileInfo();
});

r.on('fileError', function(file, message){
    $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html('(file could not be uploaded: '+message+')');
    $('.progress-container').css( "background", "red" );

    resetUploadFileInfo();
});

r.on('fileProgress', function(file){
    $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html(Math.floor(file.progress()*100) + '%');
    $('.progress-bar').css({width:Math.floor(r.progress()*100) + '%'});
});

r.on('cancel', function(){
    $('.resumable-file-progress').html('canceled');
    $('.progress-container').css( "background-color", "red" );
    $("#submitButton").prop("disabled", true);
    $(".resumable-drop").show();
    $(".progress-cancel-link").hide();
    $("#dlDoneInfo").hide();

    if (r.isUploading) {
        // inform server that upload has been cancelled
        connection.send(JSON.stringify({
            token: uploadFileToken,
            type: "cancelInfo"
        }));

        decRequestCount();
        resetUploadFileInfo();
        resetUploadFileInfo();
    }
});

r.on('uploadStart', function(){
    $('.resumable-progress .progress-resume-link').hide();
    $('.resumable-progress .progress-pause-link').show();
    $('.resumable-progress .progress-cancel-link').show();
});


// ------------------------------- WebSocket stuff ------------------------------- 
connection.onopen = function() {
    console.log("connection established");

    connection.send(JSON.stringify({
        type: "init",
        token: userToken,
    }));

    connection.send(JSON.stringify({
        user: userToken,
        type: "taskQuery"
    }));
    console.log("init", userToken);
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
                $("#submitButton").prop("disabled", true);

                uploadFileToken = message_data.token;
                r.upload();
            } else if (message_data.status === "request_ok") {
                resetResumable();
                incRequestCount();
                $(".resumable-list").html("<br><br><br>File already in the server, request has been added to work queue");
                $("#dlDoneInfo").show();
                $(".resumable-drop").show();
            } else {
                resetResumable();
                $(".resumable-list").html("<br><br><br>You have already made this request, check \"My requests\" tab");
                $(".resumable-drop").show();
            }
        } else if (message_data.reply == "cancel") {
            r.cancel();
            resetResumable();

            let html = "<br>";
            let parts = message_data.message.split("\n");
            parts.forEach(function(part) {
                html += part + "<br>";
            });

            $(".resumable-list").html(html);
        } else if (message_data.reply === "pause") {
            r.pause();
        } else if (message_data.reply === "continue") {
            incRequestCount();
            $("#dlDoneInfo").show();
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
