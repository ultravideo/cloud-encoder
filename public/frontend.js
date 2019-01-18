// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var fileID = null;
// var response = null;
var connection = new WebSocket('ws://127.0.0.1:8083');
var userToken = getUserToken();
var numRequests = 0;
var uploading = false;
var uploadFileToken = null;
let selectedOptions = { };

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


// user token is stored in a cookie, if the cloudUserToken is not set,
// create user token and cookie for the user
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

// helper functions for updating request count shown in navbar
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

// cancel task. Task may be in the work queue waiting to be processed
// in which case the task is just deleted or it may be already under work
// which means we have to kill the process and then remove all intermediate files
function sendCancelRequest(token) {
    console.log("sending cancel request...");
    connection.send(JSON.stringify({
        type: "cancelRequest",
        token: token,
    }));
};

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
        decRequestCount();
        $("#" + response.token).remove();
        $("#table" + response.token).remove();
        $(".resumable-file-" + response.token).remove();
    }
}

// My requests view consists of tables. Each request has it's own table to make the ordering easy
// These tables are drawn every time user clicks the My requests link
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

    // request done
    if (file.status === 4) {
        newHTML +=
            "<tr><td align='left'><button id='btnDownload' class='btn btn-success' " +
            "onclick=\"sendDownloadRequest('" + file.token + "')\">Download</button>" +
            "<button class='btn btn-danger' data-toggle='modal'" +
            "data-href='" + file.token + "' data-target='#confirm-delete'>Delete</button></td>";
    } else {
        newHTML +=
            "<tr><td align='left'><button id='btnDownload' class='btn btn-success' disabled>Download</button>";

        // file cancelled or request failed
        if (file.status < -2) {
            newHTML +=
                "<button class='btn btn-danger' id='btnDelete' data-toggle='modal'" +
                "data-href='" + file.token + "' data-target='#confirm-delete'>Delete</button></td>";
        } else {
            newHTML +=
                "<button class='btn btn-danger' id='btnDelete' data-toggle='modal'" +
                "data-href='" + file.token + "' data-target='#confirm-cancel'>Cancel</button></td>";
        }
    }

    newHTML += "</tr></table></span><br><br>";

    return newHTML;
}

// we got a response for our task query. Draw task file tables
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

// worker, socket or server sent us task update regarding one of our files
// Update the task if My requests view is active
function handleTaskUpdate(response) {
    if ($("#table" + response.token).length == 0) {
        // ignore update, "My requests" tab is not active
    } else {
        // request ready
        if (response.status === 4) {
            $("#table" + response.token + " #btnDownload").prop("disabled", false);
            $("#table" + response.token + " #btnDownload").removeAttr("onclick");
            $("#table" + response.token + " #btnDownload").attr("onClick", "sendDownloadRequest('" + response.token + "');");
        }

        // request succeeded, failed or got cancelled -> show delete button
        if (response.status === 4 || response.status < -2) {
            // remove Cancel button and add Delete button
            $("#table" + response.token + " #btnDelete").text("Delete");
            $("#table" + response.token + " #btnDelete").attr("data-target", "#confirm-delete");
        }

        $("#table" + response.token + " #tdStatus").html("Status: " + response.message)
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

// enable file browse again when the file upload is completed
function enableFileBrowse() {
    $("#resumableBrowse").removeClass("resumable-browse-disabled");
    $("#resumableBrowse").addClass("resumable-browse");

    r.assignDrop($('.resumable-drop')[0]);
    r.assignBrowse($('.resumable-browse')[0]);
}

// file browse is disabled for the duration of file upload
function disableFileBrowse() {
    r.unAssignDrop($('.resumable-drop')[0]);
    r.unAssignBrowse($('.resumable-browse')[0]);

    $("#resumableBrowse").addClass("resumable-browse-disabled");
    $("#resumableBrowse").removeClass("resumable-browse");
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
        $("#kvazaarCmdButton").text("Hide options");
    } else {
        $("#kvazaarCmdButton").text("Add more Kvazaar options");
        $("#kvazaarExtraOptionsDiv").hide();
    }
});

$('#confirm-delete').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendDeleteRequest('" +  $(e.relatedTarget).data('href') + "')");
});

$('#confirm-cancel').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendCancelRequest('" +  $(e.relatedTarget).data('href') + "')");
});

// add clicked option to kvazaar extra options if it hasnt' been added yet
// Use separate hashmap for storing all options to make searching faster
$(document).on('click', '.kvzExtraOption', function(){

    if (selectedOptions[$(this).val()] === undefined) {
        var txt = $.trim($("#kvazaarExtraOptions").val());
        $("#kvazaarExtraOptions").val(txt + " --" + $(this).val() + " ");

        selectedOptions[$(this).val()] = 3;

        if ($(this).hasClass("paramRequired")) {
            $("#kvazaarExtraOptions").focus();
        }
    } else {
        console.log("already has value");
    }
});

$("#kvazaarExtraOptions").focusout(function() {
    // extrat parameter names from textarea and remove -- from parameter name
    let values = this.value.split(" ").filter(x => x.startsWith("--")).map(x => x.slice(2, x.length));
    let keys   = Object.keys(selectedOptions);

    // number of parameters didn't change, check if user "changed" some parameter
    if (values.length === keys.length) {
        values = values.sort();
        keys   = keys.sort();

        for (let i = 0; i < keys.length; ++i) {
            if (values[i] !== keys[i]) {
                delete selectedOptions[keys[i]];
                selectedOptions[values[i]] = 1;
            }
        }
    }
    // user deleted manually some parameters, find and remove them from selectedOptions
    // to make buttons work correctly
    else if (values.length < keys.length) {
        let set = new Set(values);
        let deletedKeys = keys.filter(x => !set.has(x));

        deletedKeys.forEach((key) => {
            delete selectedOptions[key];
        });
    }
    // user added manually some parameters, find and add them to selectedOptions
    // to make buttons work correctly
    else {
        let set = new Set(keys)
        let addedKeys = values.filter(x => !set.has(x));

        addedKeys.forEach((key) => {
            selectedOptions[key] = 1;
        });
    }
});

// margin's of the last button has to be adjusted manually
$("#idVideoUsability").click(function() {
    console.log("clicked");
    if ($("#idVideoUsability").hasClass("padded-bottom")) {
        $("#idVideoUsability").removeClass("padded-bottom");
    } else {
        $("#idVideoUsability").addClass("padded-bottom");
    }
});

$('#submitButton').click(function(){
    if (fileID === null) {
        return;
    }

    $("#submitButton").prop("disabled", false);
    disableFileBrowse();

    $(".progress-cancel-link").show();

    // reset progress-container color
    $('.progress-container').css( "background", "#9CBD94" );
    $('.resumable-progress').show();
    $('.resumable-list').show();
    $("#selectedFile").hide();

    $('.resumable-progress .progress-resume-link').hide();
    $('.resumable-progress .progress-pause-link').hide();
    $('.resumable-file-'+ fileID +' .resumable-file-progress').html(0 + '%');
    $('.progress-bar').css({width:0 + '%'});

    var other_options = {}, kvz_options = {};

    // kvazaar options (preset and container)
    $(".kvz_options").serializeArray().map(function(x){kvz_options[x.name] = x.value;});

    // raw video options
    $(".options").serializeArray().map(function(x){other_options[x.name] = x.value;});

    var options = {
        'type' : 'uploadRequest',
        'token': userToken,
        'kvazaar' : kvz_options,
        'kvazaar_extra' : $("#kvazaarExtraOptions").val(),
        'other' : other_options
    };

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

    $("#selectedFile").html("");

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

$("#presetSlider").change(function() {
    const presets = [
        "Placebo", "Veryslow (slowest, highest quality)",
        "Slower", "Slow", "Medium", "Fast", "Faster",
        "Veryfast", "Superfast", "Ultrafast (fastest, lowest quality)"
    ];

    $("#idSelectedPreset").text("Selected preset: " + presets[$("#presetSlider").val() - 1]);
});

// ------------------------------- Resumablejs stuff -------------------------------
r.on('fileAdded', function(file){
    // remove previously selected files
    $('.resumable-list').empty();
    r.files = r.files.slice(-1);

    // hide raw video related warnings
    $(".rawVideoWarning").hide();

    // hide download info
    $("#dlDoneInfo").hide();

    // Add the file to the list but don't show the list yet
    $('.resumable-list').append('<li class="resumable-file-'+file.uniqueIdentifier+'">'
        + '<span class="resumable-file-name"></span> <span class="resumable-file-progress">ready for upload</span>');
    $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-name').html(file.fileName);
    $('.resumable-progress').hide();
    $('.resumable-list').hide();

    $("#selectedFile").html("<label>Selected file: " + file.fileName  + "</label><br>");
    $("#selectedFile").show();

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
    enableFileBrowse();
    uploading = false;
});

r.on('fileError', function(file, message){
    $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-progress').html('(file could not be uploaded: '+message+')');
    $('.progress-container').css( "background", "red" );

    resetUploadFileInfo();
    enableFileBrowse();
    uploading = false;
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

    // if the file upload has been started, we must inform the server that now it has been cancelled
    // and we must remove all chunks files and remove the task from database
    if (uploading) {
        connection.send(JSON.stringify({
            token: uploadFileToken,
            type: "cancelInfo"
        }));

        decRequestCount();
        resetUploadFileInfo();
        resetUploadFileInfo();
    }

    uploading = false;
    enableFileBrowse();
});

r.on('uploadStart', function(){
    $('.resumable-progress .progress-resume-link').hide();
    $('.resumable-progress .progress-pause-link').show();
    $('.resumable-progress .progress-cancel-link').show();
    uploading = true;
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
                // file upload has been approved, the file doesn't exist on the server
                $(".resumable-progress .progress-resume-link").hide();
                $(".resumable-progress .progress-pause-link").show();
                $("#submitButton").prop("disabled", true);

                uploadFileToken = message_data.token;
                r.upload();
            } else if (message_data.status === "request_ok") {
                // file request was ok (unique set of options + file) but file already on the server
                resetResumable();
                incRequestCount();
                $(".resumable-list").html("<br><br><br>File already in the server, request has been added to work queue");
                $("#dlDoneInfo").show();
                $(".resumable-drop").show();
                enableFileBrowse();
            } else {
                // 
                resetResumable();
                $(".resumable-list").html("<br><br><br>You have already made this request, check \"My requests\" tab");
                $(".resumable-drop").show();
                enableFileBrowse();
            }
        } else if (message_data.reply == "cancel") {
            // file upload was cancelled (the file may be invalid, of invalid length or something similar)
            // inform user about this
            r.cancel();
            resetResumable();

            let html = "<br>";
            let parts = message_data.message.split("\n");
            parts.forEach(function(part) {
                html += part + "<br>";
            });

            $(".resumable-list").html(html);

        } else if (message_data.reply === "pause") {
            // file upload is paused for the duration of file validity check
            // (uploaded file IS video and that the duration is <30min)
            r.pause();

        } else if (message_data.reply === "continue") {
            // file has approved (it was a video file of valid length), continue upload
            incRequestCount();
            $("#dlDoneInfo").show();
            r.upload();

        } else if (message_data.reply === "downloadResponse") {
            downloadFile(message_data);
        } else if (message_data.reply === "taskResponse") {
            handleTaskResponse(message_data);
        }  else if (message_data.reply === "taskUpdate") {
            console.log("got message!");
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
