# cloud

kvazaar in cloud

indent by 4 spaces. (no tabs)

# How everything works

1) User sends unique token to backend to initialize WebSocket connection with the server
2) User sends kvazaar options and unique identifier of the file to backend
3) Backend checks if the file already exist in the database
4) Backend sends a response to client regarding the encoding request
   * File was approved, client can start the file upload
   * File was rejected, the file exists already on the server
      - User hasn't made this request yet (new options), request added to work queue
	  - User has already made this request, inform user that encoding request has been rejected
5) File upload is started and it's done using Resumable.js
6) When all chunks have been uploaded, server concatenates all chunks and adds the request to work queue
7) Some worker will take this request under work and first checks if the file is raw
   * If it is, no preprocessing must be done
   * If it isn't, it will first extract raw video (and audio) from input file
8) After preprocessing is done, worker starts to encode the file using Kvazaar
9) After encoding file may be put into user-specified container after which all intermediate files are removed (.wav, .yuv etc.)
10) Request has been processed

# Architecture

## server.js
Server.js is responsible for providing the server side interface for user.
It is also responsible for downloading files from user and making sure that files meet certain requirements (mainly that they've been approved [users can't just send any files they want to server] and that the file sizes are within limits (50GB for raw video, 30 minutes otherwise)

Server.js also spawns 5 worker threads and 1 message queue thread.

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

User is sent status messages about the encoding process. It's up to the client side code to decided how to show the status messages.

## socket.js
Socket.js provides a way for server and workers to interact with the user. Workers and the server send messages through Redis to socket which then sends these messages to user.


## db.js
All other components of cloud access the SQLite database through db.js.

# Messages

TODO explain how messaging works and what is the format of a message once the spec freezes
