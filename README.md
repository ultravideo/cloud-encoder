# cloud

kvazaar in cloud

indent by 4 spaces. (no tabs)

# How everything works

1) User (re)initializes the connection to server using WebSocket
2) User sends options and file info to server
3.1) Server check if this file already exists
   * If it does -> file upload is rejected, otherwise approved
3.2) Server checks that given options are all valid
4) File upload is started
5) After the first chunk, file upload is paused and server checks the uploaded file is video and <30min
6) If file is valid, upload is continued.
7) When file upload is completed or the file already existed on the server, task is added to work queue
8) One of the workers takes the task under work and user is sent status update about the task
9) When the task is ready, user is able to download the output file or delete the task

At any point user is able to cancel the request and make another one. User is also able make multiple concurrent request (some of them may be queued).

Download limit for each requets is 2 and after that the task is deleted.

# Architecture

## server.js
Server is responsible for handling the file upload and validation.

File is considered valid if it's a video file and its duration is <= 30min. For raw videos the limit is 50GB.

Server.js communicates with the user through socket.js

It also spawns 5 worker threads and 1 message queue thread.

## worker.js
Cloud uses 5 worker threads for processing user requests. Workers listen to Kue's message queue for encoding requests.

How a worker thread works is very straightforward:

1) Check if given video file is raw
   * If it is -> no need to preprocess
   * If it isn't -> Extract raw video (yuv420p) and audio (if necessary) using FFMPEG
2) Encode the raw video using Kvazaar
3) Add Kvazaar logo at the end of encoded video
4) If user has so specified, add the encoded video to container
5) Remove intermediate files (extracted audio track and raw video file)
6) Inform user that the encoding process is ready and file can be downloaded

User is sent status messages about the encoding process through socket.js. It's up to the client side code to decided how to show the status messages.

## socket.js
Socket.js provides a way for server and workers to interact with the user. Workers and the server send messages through Redis to socket which then sends these messages to user.

## parser.js
Parser.js is responsible for parsing and validating most user input. It handles both file related info (f.ex. FPS and resolution) but also Kvazaar options.

## db.js
db.js provides a database API for all other files. It uses PostgreSQL

# Messages

TODO explain how messaging works and what is the format of a message once the spec freezes
Has the spec frozen?
