// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var fileID = null;
var fileName = null;
// var response = null;
var connection = new WebSocket('ws://127.0.0.1:8083');
var userToken = getUserToken();
var numRequests = 0;
var uploading = false;
var uploadFileToken = null;
let selectedOptions = { };
let fpsOk = false;
let resOk = true;
let inputFileRaw = false;

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
    $("#linkRequests").text("My videos (" + numRequests + ")");
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

function sendOptionsValidationRequest(options) {
    connection.send(JSON.stringify({
        type: "optionsValidationRequest",
        options: options
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
        $("#table" + response.token + " #tdDownloadCount").html(2 - response.count);
        var win = window.open("http://localhost:8080/download/" + response.token, '_blank');
        win.focus();

        if (response.count === 2) {
            $("#table" + response.token + " #btnDownload").prop("disabled", true);
        }
    }
}

// My videos view consists of tables. Each request has it's own table to make the ordering easy
// These tables are drawn every time user clicks the My videos link
function drawFileTable(file) {

    let newHTML  = "";
    let dotClass = "";

    Object.keys(file.options).forEach(function(key) {
        newHTML += "<tr><td>" + key + ":</td><td >" + file.options[key] + "</td></tr>";
    });

    newHTML += "<tr><td>Downloads left:</td><td id='tdDownloadCount'>" + (2 - file.download_count) + "</td></tr></table>";

    // request done
    if (file.status === 4) {
        newHTML +=
            "<button id='btnDownload' class='btn btn-success' " +
            "onclick=\"sendDownloadRequest('" + file.token + "')\">Download</button>" +
            "<button style='margin-left: 2px' class='btn btn-danger' data-toggle='modal'" +
            "data-href='" + file.token + "' data-target='#confirm-delete'>Delete</button>";
        dotClass = "dot_ready";
    } else {
        if (file.status < -2) {
            newHTML +=
                "<button id='btnDownload' class='btn btn-success' disabled>Download</button>" +
                "<button class='btn btn-danger' style='margin-left: 2px' id='btnDelete' data-toggle='modal'" +
                "data-href='" + file.token + "' data-target='#confirm-delete'>Delete</button>";
            dotClass = "dot_failure";
        } else {
            newHTML +=
                "<button id='btnDownload' class='btn btn-success' disabled>Download</button>" + 
                "<button class='btn btn-danger' style='margin-left: 2px' id='btnDelete' data-toggle='modal'" +
                "data-href='" + file.token + "' data-target='#confirm-cancel'>Cancel</button>";
            dotClass = "dot_inprogress";
        }
    }

    newHTML = 
        "</div>" +
        "<div id='div" + file.token + "'><hr id='separator" + file.token + "' class='separator'></hr>" +
        "<span id='reqStatus' class='dot " + dotClass + "'></span> <b>" + file.name + "</b>" +
        "<table class='fileReqTable' id='table" + file.token + "'><tr><td colspan='2'></td></tr><tr></tr>" +
        "<tr><td>Status:</td><td id='tdStatus'>" + file.message + "</td></tr>" +
        newHTML;

    return newHTML;
}

// we got a response for our task query. Draw task file tables
function handleTaskResponse(response) {
    $("#divRequests").empty();

    if (response.numTasks === 0) {
        $("#divRequests").append("<p>You haven't made requests.</p>");
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
// Update the task if My videos view is active
function handleTaskUpdate(response) {
    if ($("#table" + response.token).length == 0) {
        // ignore update, "My videos" tab is not active
    } else {
        // request ready
        if (response.status === 4) {
            $("#div" + response.token + " #btnDownload").prop("disabled", false);
            $("#div" + response.token + " #btnDownload").removeAttr("onclick");
            $("#div" + response.token + " #btnDownload").attr("onClick", "sendDownloadRequest('" + response.token + "');");
            $("#div" + response.token + " #btnDelete").text("Delete");

            $("#div" + response.token + " #btnDelete").attr("data-target", "#confirm-delete");
            $("#div" + response.token + " #tdStatus").html(response.message)
            $("#div" + response.token + " #reqStatus").removeAttr("class");
            $("#div" + response.token + " #reqStatus").addClass("dot dot_ready");
        }

        // request succeeded, failed or got cancelled -> show delete button
        else if (response.status === 4 || response.status < -2) {
            // remove Cancel button and add Delete button
            $("#div" + response.token + " #btnDelete").text("Delete");
            $("#div" + response.token + " #btnDelete").attr("data-target", "#confirm-delete");
            $("#div" + response.token + " #tdStatus").html(response.message)
            $("#div" + response.token + " #reqStatus").removeAttr("class");
            $("#div" + response.token + " #reqStatus").addClass("dot dot_failure");
        }
        else {
            $("#div" + response.token + " #tdStatus").html(response.message)
            $("#div" + response.token + " #reqStatus").removeAttr("class");
            $("#div" + response.token + " #reqStatus").addClass("dot dot_inprogress");
        }
    }
}

function handleCancelResponse(response) {
    if (status === "ok") {
        decRequestCount();
        $("#div" + response.token).remove();
    } else {
        alert("Failed to cancel request");
    }
}

function handleDeleteResponse(response) {
    if (response.status === "ok") {
        decRequestCount();
        $("#div" + response.token).remove();

        if (numRequests === 0) {
            console.log("erorr heree");
            $("#divRequests").empty();
            $("#divRequests").append("<p>You haven't made requests.</p>");
        }
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
    $("#selectedFile").html("");
    $("#selectedFile").hide();
    $(".resumable-list").empty();
    $(".resumable-progress").hide();
    $("#submitButton").prop("disabled", true);

    resetUploadFileInfo();
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

// enable html for multiline tooltips
$('.multilinett').tooltip({html: true})

// enable bootstrap tooltips
$(document).ready(function() {
    $("body").tooltip({ selector: '[data-toggle=tooltip]' });
});

// Resumable.js isn't supported, fall back on a different method
if(!r.support) {
    $('.resumable-error').show();
} else {
    r.assignDrop($('.resumable-drop')[0]);
    r.assignBrowse($('.resumable-browse')[0]);
}

$("#kvazaarCmdButton").click(function() {
    if ($("#kvazaarExtraOptionsDiv").is(":hidden")) {
        $("#kvazaarExtraOptionsDiv").show();
        $("#kvazaarCmdButton").text("Hide options");
    } else {
        $("#kvazaarCmdButton").text("Kvazaar options");
        $("#kvazaarExtraOptionsDiv").hide();
    }
});

$("#resValue").change(function() {
    if (this.value === "custom") {
        $("#resValueTxtId").show();
    } else {
        $("#resValueTxt").val("");
        $("#resValueTxtId").hide();
    }
});

$("#resValueTxt").focusout(function() {
    let res  = this.value.match(/^[0-9]{1,4}\x[0-9]{1,4}$/g);

    if (res && res.length != 0) {
        $("#resValueTxt").val(res[0]);
        $("#inputResError").hide();

        if (fpsOk) 
            $("#rawInfoDoneBtn").prop("disabled", false);

        resOk = true;
        return;
    }

    resOk = false;
    $("#inputResError").html("<strong>Invalid resolution!</strong>");
    $("#inputResError").show();
    $("#rawInfoDoneBtn").prop("disabled", true);
});

$("#inputFPSValue").focusout(function() {
    if (this.value === "") {
        $("#inputFPSError").html("<font color='red'><b>FPS can't be empty!</b></font>");
        $("#inputFPSError").show();
        return;
    }

    let fps = this.value.match(/^[1-9]{1}[0-9]{0,2}$/g);
    if (fps && fps.length != 0) {
        $("#inputFPSValue").val(fps[0]);
        $("#inputFPSError").hide();

        if (resOk)
            $("#rawInfoDoneBtn").prop("disabled", false);

        fpsOk = true;
        return;
    }

    fpsOk = false;
    $("#rawInfoDoneBtn").prop("disabled", true);
    $("#inputFPSError").html("<strong>Invalid FPS!</strong>");
    $("#inputFPSError").show();
});

function getRawFileInfo() {
    let fname = fileName;
    $("#rawVideoInfo").modal();
    inputFileRaw = true;

    let resVal = "1920x1080",
        fpsVal = "",
        fmtVal = "yuv420p",
        bdVal  = "8";

    let res = fname.match(/[0-9]{1,4}\x[0-9]{1,4}/g);
    if (res && res.length != 0) {
        resVal = res[0];
    }

    let fps = fname.match(/[1-9]{1}[0-9]{0,2}[-_\s]?(FPS)/ig);
    if (fps && fps.length != 0) {
        fpsVal = fps[0].match(/[1-9]{1}[0-9]{0,2}/)[0]; // extract only the number
        $("#rawInfoDoneBtn").prop("disabled", false);
        fpsOk = true;
    }

    let bitDepth = fname.match(/([89]|1[0-6])[_-\s]?(bit)/ig);
    if (bitDepth && bitDepth.length != 0) {
        bdVal = bitDepth[0].match(/([89]|1[0-6])/)[0]; // extract only the number
    }

    let ext = fname.match(/\.(raw|yuv|yuyv|rgb(32|a)?|bgra|h264)$/g);
    if (ext) {
        switch (ext[0]) {
            case ".rgba":  fmtVal = "rgba";    break;
            case ".yuyv":  fmtVal = "yuyv422"; break;
            case ".h264":  fmtVal = "h264";    break;

            case ".rgb":  // fallthrough
            case ".rgb32":
            case ".bgra":
                fmtVal = "bgra";
                break;

            case ".yuv": // fallthrough
            default:
                fmtVal = "yuv420p";
                break;
        }
    }

    $("#bitDepthValue").val(bdVal);
    $("#inputFPSValue").val(fpsVal);
    $("#resValue").val(resVal);
    $("#videoFormatValue").val(fmtVal);
}

$('#confirm-delete').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendDeleteRequest('" +  $(e.relatedTarget).data('href') + "')");
});

$('#confirm-cancel').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendCancelRequest('" +  $(e.relatedTarget).data('href') + "')");
});

// clear state if user clicks cancel button when inputting raw video info
$('#rawVideoInfo').on('show.bs.modal', function(e) {
    $(this).find('.btn-cancel').attr('onclick', "resetResumable()");
});

$('#rawVideoCheck').on('show.bs.modal', function(e) {
    $(this).find('.btn-success').attr('onclick', "getRawFileInfo()");
});

// add clicked option to kvazaar extra options if it hasnt' been added yet
// Use separate hashmap for storing all options to make searching faster
$(document).on('click', '.kvzExtraOption', function(){

    // input field doesn't have this value yet, add it to hashmap and then to the field
    if (selectedOptions[$(this).val()] === undefined) {
        var txt = $.trim($("#kvazaarExtraOptions").val());
        $("#kvazaarExtraOptions").val(" " + txt + " --" + $(this).val() + " ");

        selectedOptions[$(this).val()] = null;

        if ($(this).hasClass("paramRequired")) {
            $("#kvazaarExtraOptions").focus();
        }
    } else {
        // we don't know the exact location of this option in the text field (offset from start)
        // let's just remove the value from hashmap and reset the text field's text
        delete selectedOptions[$(this).val()];

        let options = "";
        Object.keys(selectedOptions).forEach((key) => {
            options += " --" + key;

            console.log(selectedOptions[key]);
            if (selectedOptions[key] !== null)
                options += " " + selectedOptions[key];
        });

        $("#kvazaarExtraOptions").val(options);
        sendOptionsValidationRequest($("#kvazaarExtraOptions").val());
    }
});

$("#kvazaarExtraOptions").focusout(function() {
    // split text into key values pairs. If option doesn't take a parameter, it's paramter is null
    let values = { };
    let pairs  = this.value.split(" --")
                    .slice(1)                // remove first element (white space)
                    .map(x => x.split(" ")); // split "--key value" string into two-element arrays

    // create hashmap (key value pairs) from arrays
    pairs.forEach(([key, value]) => values[key] = value ? value : null);

    let newKeys = Object.keys(values);
    let oldKeys = Object.keys(selectedOptions);

    // number of parameters didn't change, check if user "changed" some parameter
    if (newKeys.length === oldKeys.length) {
        newKeys = newKeys.sort();
        oldKeys = oldKeys.sort();

        for (let i = 0; i < oldKeys.length; ++i) {
            if (newKeys[i] !== oldKeys[i]) {
                delete selectedOptions[oldKeys[i]];
                selectedOptions[newKeys[i]] = values[newKeys[i]];
            }

            selectedOptions[newKeys[i]] = values[newKeys[i]];
        }
    }
    // user deleted manually some parameters, find and remove them from selectedOptions
    // to make buttons work correctly
    else if (newKeys.length < oldKeys.length) {
        let set = new Set(newKeys);
        let deletedKeys = oldKeys.filter(x => !set.has(x));

        deletedKeys.forEach((key) => {
            delete selectedOptions[key];
        });
    }
    // user added manually some parameters, find and add them to selectedOptions
    // to make buttons work correctly
    else {
        let set = new Set(oldKeys)
        let addedKeys = newKeys.filter(x => !set.has(x));

        addedKeys.forEach((key) => {
            console.log(values[key], " for ", key);
            selectedOptions[key] = values[key];
        });
    }

    sendOptionsValidationRequest(this.value);
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
    $('.resumable-file-progress').html(0 + '%');
    $('.progress-bar').css({width:0 + '%'});

    $('.resumable-file-' + fileID + ' .resumable-file-name')
        .html("<div class='alert alert-info'>Uploading " +  fileName +
            "...<span class='resumable-file-progress'><br></div>");

    var other_options = {}, kvz_options = {};

    // kvazaar options (preset and container)
    $(".kvz_options").serializeArray().map(function(x){kvz_options[x.name] = x.value;});

    // raw video options
    $(".options").serializeArray().map(function(x){other_options[x.name] = x.value;});

    if (inputFileRaw) {
        other_options.raw_video = "on";
    }

    // use resolution from input field instead
    if (other_options.resolution_txt !== "") {
        other_options.resolution = other_options.resolution_txt;
        delete other_options["resolution_txt"];
    }

    var options = {
        'type' : 'uploadRequest',
        'token': userToken,
        'kvazaar' : kvz_options,
        'kvazaar_extra' : $("#kvazaarExtraOptions").val(),
        'other' : other_options
    };

    options['other']['file_id'] = fileID;
    options['other']['name'] = r.files[r.files.length - 1].fileName.toString();

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

$(document).on('click', ".linkRequestLinkClass", function() {
    showRequests();
});

$("#linkAbout").click(function() {
    deActivate("Requests");
    deActivate("Upload");
    activateView("About")
});

$("#presetSlider").change(function() {
    const presets = [
        "Veryslow (slowest, highest quality)", "Slower",
        "Slow", "Medium", "Fast", "Faster", "Veryfast",
        "Superfast", "Ultrafast (fastest, lowest quality)"
    ];

    $("#idSelectedPreset").text("Selected encoding level: " + presets[$("#presetSlider").val() - 1]);
});

// reset all views and made changes when user presses f5
// (this doesn't for whatevereason happen automatically)
$(document.body).on("keydown", this, function (event) {

    if (event.keyCode == 116) {
        resetUploadFileInfo();
        resetResumable();

        $("#kvazaarExtraOptions").val("");
        $("#inputFPSValue").val("");
        $("#resValue").val("");

        $("#presetSlider").val(9);
        $("#containerSelect").val("none");

        selectedOptions = { };
    }
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

    // show link for raw video info input
    $("#rawInputLink").show();

    // Add the file to the list but don't show the list yet
    // $('.resumable-list').append('<li class="resumable-file-'+file.uniqueIdentifier+'">'
    //     + '<span class="resumable-file-name"></span> <span class="resumable-file-progress">ready for upload</span>');
    $('.resumable-list').append('<li class="resumable-file-'+file.uniqueIdentifier+'">'
        + '<span class="resumable-file-name"></span>');
    $('.resumable-file-'+file.uniqueIdentifier+' .resumable-file-name').html(file.fileName);
    $('.resumable-progress').hide();
    $('.resumable-list').hide();

    $("#selectedFile").html("<label>Selected file: " + file.fileName  + "</label><br>");
    $("#selectedFile").show();

    fileID   = file.uniqueIdentifier;
    fileName = file.fileName;

    // initially set the inputFileRaw to false so non-raw videos work too
    inputFileRaw = false;

    // selected file may be raw but doesn't have the fps value in its name
    // so disable the Submit button
    $("#rawInfoDoneBtn").prop("disabled", true);
    fpsOk = false;

    let fname = r.files[r.files.length - 1].fileName.toString();
    let ext   = fname.match(/\.(raw|yuv|yuyv|rgb(32|a)?|bgra|h264)$/g);

    // try to match as match information from the file name as possible
    if (ext) {
        getRawFileInfo();
    } else {
        ext = fname.match(/\.(mp4|webm|avi|mkv|flv)$/g);
        if (!ext) {
            $("#rawVideoCheck").modal();
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
    $('.resumable-progress .progress-cancel-link').hide();
    $('.resumable-progress .progress-pause-link').hide();
});

r.on('fileSuccess', function(file, message){
    $('.resumable-file-' + fileID + ' .resumable-file-name')
        .html("<div class='alert alert-success'>Uploaded " +  fileName + "!<br>" + 
        "You can follow the progress <a href='#' class='linkRequestLinkClass'>here</a></div>");

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
    $('.progress-container').css( "background-color", "red" );
    $("#submitButton").prop("disabled", true);
    $(".resumable-drop").show();
    $(".progress-cancel-link").hide();
    $("#dlDoneInfo").hide();

    $('.resumable-file-' + fileID + ' .resumable-file-name')
        .html("<div class='alert alert-danger'>Failed to upload " +  fileName + "!");

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
                $(".resumable-list").html("<br><div  class='alert alert-info' role='alert'>" +
                    "File already in the server, request has been added to work queue<br>" + 
                    "You can follow the progress <a href='#' class='linkRequestLinkClass'>here</a></div>");
                $(".resumable-drop").show();
                enableFileBrowse();
            } else {
                // 
                resetResumable();
                $(".resumable-list").html("<br><div class='alert alert-warning' role='alert'>" +
                    "You have already made this request, check <a href='#' class='linkRequestLinkClass'>" +
                    "My videos</a> tab</div>");
                $(".resumable-drop").show();
                enableFileBrowse();
            }
        } else if (message_data.reply == "cancel") {
            // file upload was cancelled (the file may be invalid, of invalid length or something similar)
            // inform user about this
            r.cancel();
            resetResumable();

            let html = "<br><div class='alert alert-danger' role='alert'>";
            let parts = message_data.message.split("\n");
            parts.forEach(function(part) {
                html += part + "</div>";
            });

            incRequestCount();
            $(".resumable-list").html(html);

        } else if (message_data.reply === "pause") {
            // file upload is paused for the duration of file validity check
            // (uploaded file IS video and that the duration is <30min)
            r.pause();

        } else if (message_data.reply === "continue") {
            // file has approved (it was a video file of valid length), continue upload
            incRequestCount();
            // $(".resumable-list").html("<br><div  class='alert alert-info' role='alert'>" +
            //     "You can follow the progress <a href='#' id='linkRequestLink'>here</a></div>");
            // $(".resumable-list").html("<br><div class='alert alert-warning' role='alert'>" +
            //     "<strong>You have already made this request, check \"My videos\" tab</strong></div>");
            // $("#dlDoneInfo").show();
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

        } else if (message_data.reply === "optionsValidationReply") {
            if (message_data.valid === true) {
                $("#invalidOptions").hide();
                $("#submitButton").prop("disabled", false);
            } else {
                $("#invalidOptions").show();
                $("#invalidOptions").html("<strong>" + message_data.message + "</strong>");
                $("#submitButton").prop("disabled", true);
			}
        }
    }
};

connection.onclose = function(error) {
    console.log("connection closed...");
};

connection.onerror = function(error) {
    console.log(error);
};
