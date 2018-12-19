FROM ubuntu:18.04
FROM node:8

ENV CLOUD_UTILS ffmpeg redis-server sqlite3 psmisc
# ENV CLOUD_HOST "10.21.25.26"
ENV CLOUD_HOST "localhost"
ENV REQUIRED_PACKAGES automake autoconf libtool m4 build-essential git yasm pkgconf

RUN apt-get update \
    && apt-get install -y $REQUIRED_PACKAGES $CLOUD_UTILS \
    && git clone https://github.com/ultravideo/kvazaar \
    && cd kvazaar \
    && ./autogen.sh \
    && ./configure --disable-shared \
    && make \
    && make install \
    && make clean \
    && cd .. \
    && mkdir src src/public src/util src/app \
    && mkdir -p /tmp /tmp/cloud_uploads /tmp/cloud_uploads/misc /tmp/cloud_uploads/output \
    && export CLOUD_HOST=$CLOUD_HOST \
    && touch src/cloud.db \
    && sqlite3 src/cloud.db "CREATE TABLE 'kvz_options' (preset TEXT, container TEXT, hash TEXT, extra TEXT)" \
    && sqlite3 src/cloud.db "CREATE TABLE 'files' (name TEXT, hash TEXT, file_path TEXT, resolution TEXT, \
                             uniq_id TEXT, raw_video INTEGER, fps INTEGER, bit_depth INTEGER)" \
    && sqlite3 src/cloud.db "CREATE TABLE 'work_queue' (taskID INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT UNIQUE, file_id TEXT, \
                             ops_id TEXT, file_path TEXT, status INTEGER DEFAULT 0, download_count INTEGER DEFAULT 0, token TEXT, \
                             owner_id TEXT )"

WORKDIR /src
COPY package.json /src/package.json
RUN npm install --silent

COPY app/server.js app/worker.js app/parser.js app/socket.js app/db.js /src/app/
COPY util/resumable.js public/frontend.js util/resumable-node.js /src/util/
COPY util/logo.png /tmp/cloud_uploads/misc/
COPY public/ /src/public/

EXPOSE 8080
EXPOSE 8083

CMD redis-server --port 7776 --daemonize yes && node app/server.js
