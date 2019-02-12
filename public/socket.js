






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

