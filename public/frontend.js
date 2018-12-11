// if user is running mozilla then use it's built-in WebSocket
window.WebSocket = window.WebSocket || window.MozWebSocket;

var numFiles = 0;
var fileIds = [];
var fileID = null;
var response = null;
var connection = new WebSocket('ws://127.0.0.1:8083'); // TODO ???
var userToken  = generate_random_string(64);

var r = new Resumable({
    target: '/upload',
    chunkSize: 1 * 1024 * 1024,
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

// Resumable.js isn't supported, fall back on a different method
if(!r.support) {
    $('.resumable-error').show();
} else {
    r.assignBrowse($('#browseButton'));

    $('#submitButton').click(function(){
        if (numFiles == 0) {
            console.log("no files");
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
            $('.resumable-list').append("<br>" + message_data.message);
        }

        // server send us message regarding resumable upload process
        if (message_data.type === "action") {
            if (message_data.reply == "upload") {
                $('.resumable-progress .progress-resume-link').hide();
                $('.resumable-progress .progress-pause-link').show();
                r.upload();
            } else if (message_data.reply == "cancel") {
                r.cancel();
            } else if (message_data.reply == "pause") {
                r.pause();
            } else if (message_data.reply == "continue") {
                console.log("continue upload");
                r.upload();
            }
        }
    };

    connection.onerror = function(error) {
        console.log(error);
    };
}
