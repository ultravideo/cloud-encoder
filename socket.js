let WebSocketServer = require('websocket').server;

let server = http.createServer(function(request, response) {
}).listen(8081, function() { });

// create the server
wsServer = new WebSocketServer({
    httpServer: server
});

// WebSocket server
wsServer.on('request', function(request) {
    ws_conn = request.accept(null, request.origin);

    ws_conn.on('message', function(message) {
        if (message.type === 'utf8') {
            var data = JSON.parse(message.utf8Data);

            // ws_conns[data.other.file_id] = 
            // create temporary file for data chunks
            fs.writeFile('/tmp/cloud_uploads/' + data.other.file_id + '.tmp', '', function (err) {
                if (err) throw err;

                sendMessage(ws_conn, null, "status", "Checking database....");
                prepareDBForRequest(data, function(status) {
                    ws_conn.send(status);
                });
            }); 
        }
    });

    ws_conn.on('close', function(connection) {
        console.log("connection closed");
    });
});

