FROM ubuntu:18.04
FROM node:8
# FROM ultravideo/kvazaar # ???

ENV CLOUD_UTILS ffmpeg redis-server sqlite3 psmisc
ENV REQUIRED_PACKAGES automake autoconf libtool m4 build-essential git yasm pkgconf

RUN apt-get update \
    && apt-get install -y $REQUIRED_PACKAGES $CLOUD_UTILS \
	&& git clone https://github.com/ultravideo/kvazaar \
	&& cd kvazaar \
	&& ./autogen.sh \
	&& ./configure --disable-shared \
	&& make\
	&& make install

# initialize cloud
RUN mkdir src src/public /tmp/cloud_uploads /tmp/cloud_uploads/misc /tmp/cloud_uploads/output
WORKDIR /src
COPY package.json /src/package.json
RUN npm install --silent

COPY server.js worker.js socket.js db.js /src/
COPY resumable.js frontend.js resumable-node.js testi.sh /src/
COPY public/ /src/public/
COPY logo.png /tmp/cloud_uploads/misc/

# create sqlite database and necessary tables
RUN touch cloud.db
RUN sqlite3 cloud.db "CREATE TABLE 'files' (hash TEXT, file_path TEXT, resolution TEXT, uniq_id TEXT, raw_video INTEGER)"
RUN sqlite3 cloud.db "CREATE TABLE 'kvz_options' (preset TEXT, container TEXT, hash TEXT)"
RUN sqlite3 cloud.db "CREATE TABLE 'work_queue' (taskID INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT UNIQUE, file_id TEXT, \
					 ops_id TEXT, file_path TEXT, status INTEGER DEFAULT 0, download_count INTEGER DEFAULT 0, token TEXT, \
					 owner_id TEXT )"

EXPOSE 8080
EXPOSE 8083

CMD redis-server --port 7776 --daemonize yes && node server.js
