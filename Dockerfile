FROM ubuntu:18.04
FROM node:8

ENV CLOUD_UTILS ffmpeg redis-server postgresql psmisc sudo
ENV CLOUD_HOST "10.21.25.26"
ENV POSTGRES_USER "postgres"
ENV POSTGRES_PASS "postgres"
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
    && sed -i "s/define KVZ_BIT_DEPTH 8/define KVZ_BIT_DEPTH 10/" src/kvazaar.h \
    && ./configure --disable-shared --program-suffix="_10bit" \
    && make \
    && make install \
    && make clean \
    && cd .. \
    && mkdir src src/public src/util src/app \
    && mkdir -p /tmp /tmp/cloud_uploads /tmp/cloud_uploads/misc /tmp/cloud_uploads/output \
    && export CLOUD_HOST=$CLOUD_HOST \
    && sudo service postgresql start \
    && sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';" \
    && sudo -u postgres psql -c "CREATE DATABASE cloud_db;" \
    && sudo -u postgres psql -c "ALTER DATABASE cloud_db SET TIMEZONE TO 'UTC';" \
    && sudo -u postgres psql -d cloud_db -c "CREATE TABLE kvz_options(container VARCHAR(16), \
                                            hash VARCHAR(128), extra VARCHAR(1024));" \
    && sudo -u postgres psql -d cloud_db -c "CREATE TABLE files(name VARCHAR(1024), hash VARCHAR(128), \
                                             file_path VARCHAR(512), resolution VARCHAR(16), \
                                             uniq_id VARCHAR(128), raw_video INTEGER, fps INTEGER, bit_depth INTEGER, \
                                             video_format VARCHAR(16))" \
    && sudo -u postgres psql -d cloud_db -c "CREATE TABLE work_queue(taskid SERIAL PRIMARY KEY, \
                                             file_id VARCHAR(1024), ops_id VARCHAR(128), file_path VARCHAR(1024), status INTEGER, \
                                             download_count INTEGER, token VARCHAR(128), owner_id VARCHAR(128), \
                                             timestamp BIGINT);"

WORKDIR /src
COPY package.json /src/package.json
RUN npm install --silent

COPY app/server.js app/worker.js app/parser.js app/socket.js app/db.js app/constants.js /src/app/
COPY util/resumable.js public/frontend.js util/resumable-node.js /src/util/
COPY util/logo.png /tmp/cloud_uploads/misc/
COPY public/ /src/public/

EXPOSE 8080

CMD sudo service postgresql start \
    && redis-server --port 7776 --daemonize yes \
    && node app/socket.js
