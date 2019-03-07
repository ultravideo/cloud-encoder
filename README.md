# Kvazaar Cloud Encoder

Kvazaar in cloud with 2-clause BSD license

Indent by 4 spaces. (no tabs)

# Building and Running

`
docker build -t cloud .
`

```
docker run --rm --name cloud-postgres -v ~/kvazaar-cloud-db:/var/lib/postgresql/data -d --env POSTGRES_PASSWORD=postgres postgres:latest
docker run --rm --name cloud-encoder -d --link cloud-postgres:pg -p 80:8080 -p 443:8443 -v /tmp:/tmp cloud
```

If you want to use the Kvazaar Cloud Encoder in localhost, you need to change the variable *httpsEnabled* in socket.js to false and run:

```
docker run --rm --name cloud-postgres -v ~/kvazaar-cloud-db:/var/lib/postgresql/data -d --env POSTGRES_PASSWORD=postgres postgres:latest
docker run --rm --name cloud-encoder -d --link cloud-postgres:pg -p 80:8081 -v /tmp:/tmp cloud
```

# How everything works

1) User (re)initializes the connection to server using WebSocket
2) User sends options and file info to server
3) Server checks that given options are all valid
   * If theyare -> file upload is rejected
4) Server check if this file already exists
   * If it does -> file upload is rejected
5) File upload is started
6) When file upload is completed, server checks the uploaded file is video and < FILE_TIME_LIMIT_IN_SECONDS (30min)
7) Task is added to work queue
8) One of the workers takes the task under work and user is sent status update about the task
9) When the task is ready, user is able to download the output file or delete the task

At any point user is able to cancel the request and make another one. User is also able make multiple concurrent request (some of them may be queued).

Download limit for each requets is FILE_DOWNLOAD_LIMIT (2) and after that the task is deleted.

# Architecture

## server.js
Server is responsible for handling the file upload and validation.

File is considered valid if it's a video file and its duration is < FILE_TIME_LIMIT_IN_SECONDS (30min). For raw videos the limit is FILE_SIZE_LIMIT_IN_BYTES (50GB)

Server.js communicates with the user through socket.js. See the message specification below for more details

It also spawns NUMBER_OF_WORKER_THREADS (5) worker threads and 1 message queue thread.

## worker.js
Cloud uses NUMBER_OF_WORKER_THREADS worker threads for processing user requests. Workers listen to Kue's message queue for encoding requests.

How a worker thread works is very straightforward:

1) Check if given video file is raw in yuv420p format
   * If it is, no need to preprocess
   * If it isn't:
      * If input is raw -> convert the given format to yuv420p
	  * If the input is not raw -> extract raw video (yuv420p) and audio (if necessary) using FFMPEG
2) Add Kvazaar logo at the end of video
3) Encode the raw video using Kvazaar
4) If user has so specified, add the encoded video to container
5) Remove intermediate files (extracted audio track and raw video file)
6) Inform user that the encoding process is ready and file can be downloaded

User is sent status messages about the encoding process through socket.js.

## socket.js
Socket.js provides a way for server and workers to interact with the user. Workers and the server send messages through Redis to socket.js which then sends these messages to user.

## parser.js
Parser.js is responsible for parsing and validating most user input. It handles both file related info (f.ex. FPS and resolution) but also Kvazaar options.

## db.js
db.js provides a database API for all other files.

# Messages

Client and server communicate with each other using request/reply pairs. For example, when user clicks the "Encode" button the front-end code sends an *uploadRequest* to socket.js. Socket then validates the request (section "How everything works") and either rejects or approves the upload in *uploadReply* message.

Some other message types used by the system are:
* *taskQuery* sent by the front-end to fetch all tasks made by the user
* *cancelInfo* sent by the front-end code when user cancels an ongoing upload
* Internal *cancelRequest* sent from socket.js to worker.js to cancel an ongoing task
