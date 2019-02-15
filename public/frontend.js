// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var fileID = null;
var fileName = null;
var connection = new WebSocket('wss://' + document.location.host);
var userToken = getUserToken();
var numRequests = 0;
var uploading = false;
var uploadFileToken = null;
let selectedOptions = { };
let inputFileRaw = false;
let enableRateControl = false;

// TODO start using the list from server
const taskStatus = Object.freeze({
    "CANCELLED": -4,
    "FAILURE": -3,
    "PREPROCESSING": -2,
    "UPLOADING": -1,
    "WAITING": 0,
    "DECODING" : 1,
    "ENCODING" : 2,
    "POSTPROCESSING" : 3,
    "READY" : 4,
});

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


// enable html for multiline tooltips
$('.multilinett').tooltip({html: true})

// enable bootstrap tooltips
$(document).ready(function() {
    $("body").tooltip({ selector: '[data-toggle=tooltip]' });
});



// ------------------------------- Helper functions -------------------------------

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

    for(let i = 0; i < string_length; ++i) {
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

function deActivate(name) {
    $("#div" + name).hide();
    $("#li" + name).removeClass("active");
}

function activateView(name) {
    $("#div" + name).show();
    $("#li" + name).addClass("active");
}

function enableSubmitButtonIfPossible() {
    if (fileID != null)
        $("#submitButton").prop("disabled", false);
}

function enableSaveButtonIfPossible(params) {
    $("#advancedButton").prop("disabled", false);

    // function static variable so we don't pollute the global space
    enableSaveButtonIfPossible.states = {
        options: true,
        fps: true,
        resolution: true,
        pixfmt: true
    };

    Object.keys(params).forEach(function(key) {
        if (params[key] === false)
            $("#advancedButton").prop("disabled", true);

        enableSaveButtonIfPossible.states[key] = params[key];
    });
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
    if (file.status === taskStatus.READY) {
        newHTML +=
            "<button id='btnDownload' class='btn btn-success' " +
            "onclick=\"sendDownloadRequest('" + file.token + "')\">Download</button>" +
            "<button style='margin-left: 2px' class='btn btn-danger' data-toggle='modal'" +
            "data-href='" + file.token + "' data-target='#confirm-delete'>Delete</button>";
        dotClass = "dot_ready";
    } else {
        if (file.status === taskStatus.CANCELLED || file.status === taskStatus.FAILURE) {
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

function getResolution(fname) {
    let res = fname.match(/[0-9]{1,4}\x[0-9]{1,4}/g);

    if (res)
        return res[0];
    return "";
}

function getFPS(fname) {
    let fps = fname.match(/[1-9]{1}[0-9]{0,2}[-_\s]?(FPS)/ig);

    if (fps)
        return fps[0].match(/[1-9]{1}[0-9]{0,2}/)[0]; // extract only the number
    return "";
}

function getBitDepth(fname) {
    let bitDepth = fname.match(/([89]|1[0-6])[_-\s]?(bit)/ig);

    if (bitDepth)
        return bitDepth[0].match(/([89]|1[0-6])/)[0]; // extract only the number
    return "";
}

function getPixelFormat(fname) {
    let ext = fname.match(/\.(raw|yuv.*|yuyv|rgb(32|a)?|bgra|h264)$/g);

    if (ext) {
        switch (ext[0]) {
            case ".rgba":
                return "rgba";

            case ".yuyv":
                return "yuyv422";

            case ".h264":
                return "h264";

            case ".rgb":  // fallthrough
            case ".rgb32":
            case ".bgra":
                return "bgra";

            case ".yuv":
                return "yuv420p";

            default:
                return "other";
        }
    }
}

function getRawFileInfo() {
    let fname = fileName;
    fpsOk = true;

    let resVal = getResolution(fileName),
        fpsVal = getFPS(fileName),
        bdVal  = getBitDepth(fileName),
        fmtVal = getPixelFormat(fileName);

    if (resVal === "")
        resVal = "1920x1080";

    if (bdVal === "")
        bdVal = "8";

    if (fpsVal === "")
        enableSaveButtonIfPossible({ fps: false });

    if (fmtVal === "other") {
        $("#pixFmtTxtId").show();
        $("#advancedButton").prop("disabled", true);
    }

    $("#bitDepthValue").val(bdVal);
    $("#inputFPSValue").val(fpsVal);
    $("#resValue").val(resVal);
    $("#inputFormatValue").val(fmtVal);

    // check the raw video box automatically if file extension matched
    if (!$("#rawVideoCheck").is(":checked")) {
        if ($("#advancedOptions").is(":hidden"))
            $("#advancedButton").click();
        $("#rawVideoCheck").click();
    }
}

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

// ------------------------------- /Helper functions -------------------------------




// ------------------------------- WebSocket requests -------------------------------

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

function sendPixelFormatValidation(pixelFormat) {
    console.log("sending pixelFormatValidationRequest");
    connection.send(JSON.stringify({
        type: "pixelFormatValidationRequest",
        pixelFormat: pixelFormat
    }));
};

// ------------------------------- /WebSocket requests -------------------------------




// ------------------------------- WebSocket responses -------------------------------

// server gave us response regarding file download
// the download request may have been rejected (file doesn't exist or
// download limit has been exceeded) in which case we remove this div
// from #files and inform user about it
//
// if the download request has been approved, download the file
function handleDownloadResponse(response) {
    if (response.data.status === "accepted") {
        $("#table" + response.token + " #tdDownloadCount").html(2 - response.data.count);
        var win = window.open("https://" + document.location.host + "/download/" + response.data.token, '_blank');
        win.focus();

        if (response.data.count === 2) {
            $("#table" + response.data.token + " #btnDownload").prop("disabled", true);
        }
    }
}

// we sent uploadRequest to server, parse the server's response
// The task is accepted if it's unique, upload is accepted only if the file doesn't exist on the server
function handleUploadResponse(response) {

    // file upload has been approved, the file doesn't exist on the server
    if (response.data.status === "upload") {
        $(".resumable-progress .progress-resume-link").hide();
        $(".resumable-progress .progress-pause-link").show();
        $("#submitButton").prop("disabled", true);

        uploadFileToken = response.data.token;
        r.upload();

    // file request was ok (unique set of options + file) but file already on the server
    } else if (response.data.status === "request_ok") {
        resetResumable();
        incRequestCount();
        $(".resumable-list").html("<br><div  class='alert alert-info' role='alert'>" +
            "File already in the server, request has been added to work queue<br>" + 
            "You can follow the progress <a href='#' class='linkRequestLinkClass'>here</a></div>");
        $(".resumable-drop").show();
        enableFileBrowse();

    // user has already submitted this request and it's still active (1 >= downloads left)
    } else {
        resetResumable();
        $(".resumable-list").html("<br><div class='alert alert-warning' role='alert'>" +
            "You have already made this request, check <a href='#' class='linkRequestLinkClass'>" +
            "My videos</a> tab</div>");
        $(".resumable-drop").show();
        enableFileBrowse();
    }
}

// we got a response for our task query. Draw task file tables if "My videos" view is active
function handleTaskResponse(response) {
    $("#divRequests").empty();

    if (response.data.numTasks === 0) {
        $("#divRequests").append("<p>You haven't made requests.</p>");
    } else {
        numRequests = response.data.tasks.length;
        updateRequestCount();

        // creating HTML dynamically like this is awful but whatevs
        response.data.tasks.forEach(function(file) {
            $("#divRequests").append(drawFileTable(file));
        });
    }
}

function handleDeleteResponse(response) {
    if (response.data.status === "ok") {
        decRequestCount();
        $("#div" + response.data.token).remove();

        if (numRequests === 0) {
            $("#divRequests").empty();
            $("#divRequests").append("<p>You haven't made requests.</p>");
        }
    } else {
        alert("Failed to delete request, reason: " + response.data.message);
    }
}

// this is called only if the user token is invalid (user has modefied it manually)
// create new token and reset the connection
function handleInitResponse() {
    userToken = generate_random_string(64);

    Cookies.set("cloudUserToken", userToken,
        { expires: 365, path: "" }
    );

    connection.send(JSON.stringify({
        type: "init",
        token: userToken,
    }));
}

function handleOptionsValidationResponse(response) {
    if (response.data.valid === true) {
        $("#invalidOptions").hide();

        // update the state of options boolean and enable "save settings" button
        // if all other options are also valid
        enableSaveButtonIfPossible({ options: true });
    } else {
        $("#invalidOptions").show();
        $("#invalidOptions").html("<strong>" + response.data.message + "</strong>");

        // disable save settings button
        // it's re-enabled when incorrect settings are fixed
        enableSaveButtonIfPossible({ options: false });
    }
}

function handlePixelFormatValidationResponse(response) {
    if (response.data.valid === true) {
        $("#pixFmtError").hide();

        enableSaveButtonIfPossible({ pixfmt: true });
    } else {
        enableSaveButtonIfPossible({ pixfmt: false });

        $("#pixFmtError").show();
        $("#pixFmtError").html(response.data.message);
    }
}

// ------------------------------- /WebSocket responses -------------------------------







// ------------------------------- WebSocket updates and actions -------------------------------

// worker, socket or server sent us task update regarding one of our files
// Update the task if My videos view is active
function handleTaskUpdate(response) {
    // ignore update, "My videos" tab is not active
    if ($("#table" + response.data.token).length == 0) {
        return;
    }

    let newDotClass = "";

    // request ready
    if (response.data.status === taskStatus.READY) {
        // enable Download button
        $("#div" + response.data.token + " #btnDownload").prop("disabled", false);
        $("#div" + response.data.token + " #btnDownload").removeAttr("onclick");
        $("#div" + response.data.token + " #btnDownload").attr("onClick", "sendDownloadRequest('" + response.data.token + "');");

        newDotClass = "dot dot_ready";
    }
    // request succeeded, failed or got cancelled -> show delete button
    else if (response.data.status < taskStatus.CANCELLED ||
             response.data.status < taskStatus.READY)
    {
        newDotClass = "dot dot_failure";
    }
    // task is still in progress
    else {
        newDotClass = "dot dot_inprogress";
    }

    // if the task succeeded or failed (but is not in progress),
    // cancel button must be changed to delete button
    if (response.data.status === taskStatus.READY ||
        response.data.status === taskStatus.CANCELLED ||
        response.data.status === taskStatus.READY)
    {
        $("#div" + response.data.token + " #btnDelete").text("Delete");
        $("#div" + response.data.token + " #btnDelete").attr("data-target", "#confirm-delete");
    }

    // display the latest status message and change the color of dot if necessary
    $("#div" + response.data.token + " #tdStatus").html(response.data.message)
    $("#div" + response.data.token + " #reqStatus").removeAttr("class");
    $("#div" + response.data.token + " #reqStatus").addClass(newDotClass);
}


function handleCancelAction(response) {
    r.cancel();
    resetResumable();

    let html = "<br><div class='alert alert-danger' role='alert'>";
    let parts = response.data.message.split("\n");
    parts.forEach(function(part) {
        html += part + "</div>";
    });

    $(".resumable-list").html(html);
}

function handlePauseAction() {
    incRequestCount();
    r.pause();
}

function handleContinueAction() {
    r.upload();
}

// ------------------------------- /WebSocket updates and actions -------------------------------




// ------------------------------- jQuery user interactions -------------------------------

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
        $("#inputResError").hide();
    }
});

$("#inputFormatValue").change(function() {
    if (this.value === "other") {
        $("#pixFmtTxtId").show();
    } else {
        $("#pixFmtTxt").val("");
        $("#pixFmtTxtId").hide();
        $("#pixFmtError").hide();
    }
});

$("#pixFmtTxt").focusout(function() {
    sendPixelFormatValidation(this.value);
});

$("#resValueTxt").focusout(function() {
    let res = getResolution(this.value);

    if (res !== "") {
        $("#resValueTxt").val(res);
        $("#inputResError").hide();
        enableSaveButtonIfPossible({ resolution: true });
        return;
    }

    $("#inputResError").html("Invalid resolution!");
    $("#inputResError").show();

    enableSaveButtonIfPossible({ resolution: false });
});

$("#inputFPSValue").focusout(function() {
    if (this.value === "") {
        $("#inputFPSError").html("FPS can't be empty!");
        $("#inputFPSError").show();
        return;
    }

    let fps = this.value.match(/[1-9]{1}[0-9]{0,2}/g);
    if (fps) {
        $("#inputFPSValue").val(fps);
        $("#inputFPSError").hide();

        enableSaveButtonIfPossible({ fps: true });
        return;
    }

    $("#inputFPSError").html("Invalid FPS!");
    $("#inputFPSError").show();
    enableSaveButtonIfPossible({ fps: false });
});


$('#confirm-delete').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendDeleteRequest('" +  $(e.relatedTarget).data('href') + "')");
});

$('#confirm-cancel').on('show.bs.modal', function(e) {
    $(this).find('.btn-ok').attr('onclick', "sendCancelRequest('" +  $(e.relatedTarget).data('href') + "')");
});

$("#rawVideoCheck").click(function() {
    $("#rawVideoInfo").toggle();

    if (!$("#rawVideoInfo").is(":hidden")) {
        inputFileRaw = true;

        // try to enable save button only if fps was found
        enableSaveButtonIfPossible({
            fps: $("#inputFPSValue").val() != ""
        });

        // if resolution was not matched from the video, custom resolution box is shown
        // which requires input. Disable save button
        if (!$("#resValueTxt").is(":hidden")) {
            enableSaveButtonIfPossible({
                fps: $("#resValueTxt").val() != ""
            });
        }

        // if pixel format was not matched, other pixel format text input is show
        // which requires input. Disable save button
        if (!$("#pixFmtTxt").is(":hidden")) {
            enableSaveButtonIfPossible({
                fps: $("#pixFmtTxt").val() != ""
            });
        }
    } else {
        // set values to default if the raw video div is hidden
        $("#bitDepthValue").val(8);
        $("#inputFPSValue").val("");
        $("#resValue").val("1920x1080");
        $("#inputFormatValue").val("yuv420p");

        enableSaveButtonIfPossible({
            options: true,
            fps: true,
            resolution: true,
            pixfmt: true
        });

        inputFileRaw = true;
    }
});

$("#advancedButton").click(function() {
    if ($("#advancedOptions").is(":hidden")) {
        $("#cancelButton").show();

        $("#advancedButton").text("Save");
        $("#advancedButton").removeClass("btn-primary");
        $("#advancedButton").addClass("btn-success");

        // disable submit button while user is changing settings
        // clicking save or cancel will enable the button if possible
        $("#submitButton").prop("disabled", true);
    } else {
        $("#advancedButton").text("Advanced settings");
        $("#advancedButton").removeClass("btn-success");
        $("#advancedButton").addClass("btn-primary");
        $("#cancelButton").hide();
        enableSubmitButtonIfPossible();
    }

    $("#advancedOptions").toggle();
});

$("#cancelButton").click(function() {
    $("#advancedOptions").hide();
    $("#cancelButton").hide();
    enableSubmitButtonIfPossible();

    $("#advancedButton").text("Advanced settings");
    $("#advancedButton").removeClass("btn-success");
    $("#advancedButton").addClass("btn-primary");

    // reset all options
    enableRateControl = false;
    inputFileRaw = false;
    enableSaveButtonIfPossible({
        options: true,
        fps: true,
        resolution: true,
        pixfmt: true
    });

    $("#kvazaarExtraOptions").val("");

    if ($("#rawVideoCheck").is(":checked"))
        $("#rawVideoCheck").click();

    if ($("#rateControlCheck").is(":checked"))
        $("#rateControlCheck").click();

    $("#bitrateSlider").val(100000);
    $("#idSelectedBitrate").text("Selected bitrate: 0.1 Mbits/s");

    $("#invalidOptions").hide();
});


$("#rateControlCheck").click(function() {
    enableRateControl = !enableRateControl;
    $("#rateControl").toggle();
});

$("#kvazaarExtraOptions").focusin(function() {
    $("#advancedButton").prop("disabled", true);
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
    let pairs  = this.value
                    .split(" --")            // discard "--" and extract only the parameter name
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
    if (fileID === null)
        return;

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
        console.log("input file is sraw");
        other_options.raw_video = "on";
    }

    // use resolution from input field instead
    if (other_options.resolution_txt !== "") {
        other_options.resolution = other_options.resolution_txt;
        delete other_options["resolution_txt"];
    }

    // use pixel format from input field instead
    if (other_options.pixfmt_txt !== "") {
        other_options.inputFormat = other_options.pixfmt_txt;
        delete other_options["pixfmt_txt"];
    }

    // remove the bitrate from options if user didn't enable rate control
    if (enableRateControl === false) {
        delete kvz_options['bitrate'];
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

    console.log(options);

    console.log("sent options...");
    connection.send(JSON.stringify(options));
});


$("#linkUpload").click(function() {
    if ($("#divUpload").is(":hidden") && !r.isUploading()) {
        resetResumable();
    }

    if (!r.isUploading()) {
        $(".resumable-drop").show();
    }

    $("#selectedFile").html("");

    deActivate("About");
    deActivate("Requests");
    activateView("Upload")
});

$("#linkAbout").click(function() {
    deActivate("Requests");
    deActivate("Upload");
    activateView("About")
});

$("#linkRequests").click(function() {
    showRequests();
});

$(document).on('click', ".linkRequestLinkClass", function() {
    showRequests();
});


$("#presetSlider").on("input change", function() {
    const presets = [
        "Veryslow (slowest, highest quality)", "Slower",
        "Slow", "Medium", "Fast", "Faster", "Veryfast",
        "Superfast", "Ultrafast (fastest, lowest quality)"
    ];

    $("#idSelectedPreset").text("Selected encoding level: " + presets[$("#presetSlider").val() - 1]);
});

$("#bitrateSlider").on("input change", function() {
    bitrateSelected = true;
    $("#idSelectedBitrate").text("Selected bitrate: " + $("#bitrateSlider").val() / 1000 / 1000 + " Mbits/s");
});


// reset all views and made changes when user presses f5
// (this doesn't for whateve reason happen automatically)
$(document.body).on("keydown", this, function (event) {
    if (event.keyCode == 116) {
        resetUploadFileInfo();
        resetResumable();

        $("#kvazaarExtraOptions").val("");
        $("#inputFPSValue").val("");
        $("#resValue").val("");

        $("#presetSlider").val(9);
        $("#containerSelect").val("none");

        $("#bitrateSlider").val(0);

        if ($("#rawVideoCheck").is(":checked"))
            $("#rawVideoCheck").click();

        if ($("#rateControlCheck").is(":checked"))
            $("#rateControlCheck").click();

        $("#advancedOptions").hide();
        $("#rawVideoInfo").hide();

        selectedOptions = { };
        bitrateSelected = false;
    }
});

// ------------------------------- /jQuery user interactions -------------------------------




// ------------------------------- Resumablejs stuff -------------------------------

// Resumable.js isn't supported, fall back on a different method
if (!r.support) {
    $('.resumable-error').show();
} else {
    r.assignDrop($('.resumable-drop')[0]);
    r.assignBrowse($('.resumable-browse')[0]);
}

r.on('fileAdded', function(file){
    // remove previously selected files
    $('.resumable-list').empty();
    r.files = r.files.slice(-1);

    // reset the width of progress-bar
    $('.progress-bar').css({width: '0%'});

    // hide raw video related warnings
    $(".rawVideoWarning").hide();

    // show link for raw video info input
    $("#rawInputLink").show();

    // Add the file to the list but don't show the list yet
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
    fpsOk = false;

    let fname = r.files[r.files.length - 1].fileName.toString();
    let ext   = fname.match(/\.(raw|yuv.*|yuyv|rgb(32|a)?|bgra|h264)$/g);

    // enable encode button only if advanced settings div is hidden
    if ($("#advancedOptions").is(":hidden"))
        $("#submitButton").prop("disabled", false);

    // try to match as match information from the file name as possible
    if (ext) {
        getRawFileInfo();
    } else {
        if ($("#rawVideoCheck").is(":checked"))
            $("#rawVideoCheck").click();
    }
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
    $('.progress-container').css("background", "red");

    resetUploadFileInfo();
    enableFileBrowse();
    uploading = false;
});

r.on('fileProgress', function(file){
    $('.progress-bar').css({width: Math.floor(r.progress() * 100) + '%'});
    $('.resumable-file-' + file.uniqueIdentifier + ' .resumable-file-progress').html(Math.floor(file.progress() * 100) + '%');
});

// either user or server cancelled the request. Do some cleanup work
r.on('cancel', function(){
    $('.progress-container').css("background-color", "red");
    $("#submitButton").prop("disabled", true);
    $(".resumable-drop").show();
    $(".progress-cancel-link").hide();

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

// ------------------------------- /Resumablejs stuff -------------------------------





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

    let responseHandlers = {
        "init": handleInitResponse,
        "task": handleTaskResponse,
        "upload": handleUploadResponse,
        "delete": handleDeleteResponse,
        "download": handleDownloadResponse,
        "optionsValidation": handleOptionsValidationResponse,
        "pixelFormatValidation" : handlePixelFormatValidationResponse,
    };

    let actionHandlers = {
        "pause": handlePauseAction,
        "cancel": handleCancelAction,
        "continue": handleContinueAction,
    }

    if (message_data.type === "reply") {
        if (responseHandlers.hasOwnProperty(message_data.reply)) {
            responseHandlers[message_data.reply](message_data);
        }
    } else if (message_data.type === "action") {
        if (actionHandlers.hasOwnProperty(message_data.reply)) {
            actionHandlers[message_data.reply](message_data);
        }
    } else if (message_data.type === "update") {
        handleTaskUpdate(message_data);
    }
};

connection.onclose = function(error) {
    console.log("connection closed...");
};

connection.onerror = function(error) {
    console.log(error);
};

// ------------------------------- /WebSocket stuff -------------------------------
