FROM ubuntu:18.04
FROM node:8

ENV CLOUD_UTILS ffmpeg redis-server postgresql-client psmisc sudo
ENV CLOUD_HOST "10.21.25.26"
ENV POSTGRES_USER "postgres"
ENV POSTGRES_PASS "postgres"
ENV POSTGRES_DB "cloud_db"
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
    && export CLOUD_HOST=$CLOUD_HOST

WORKDIR /src
COPY package.json /src/package.json
RUN npm install --silent

COPY app/server.js app/worker.js app/parser.js app/socket.js app/db.js app/constants.js /src/app/
COPY cert cert.pem privkey.pem util/pixfmts.txt util/resumable.js public/frontend.js util/resumable-node.js util/logo.png /src/util/
COPY public/ /src/public/

EXPOSE 8080
EXPOSE 8443

CMD mkdir -p /tmp/cloud_uploads /tmp/cloud_uploads/misc /tmp/cloud_uploads/output \
    && cp util/logo.png /tmp/cloud_uploads/misc \
    && export PGPASSWORD=$POSTGRES_PASS \
    && export POSTGRES_HOST='pg' \
    && psql -h pg -U $POSTGRES_USER -tc "SELECT 1 FROM pg_database WHERE datname = 'cloud_db'" | grep -q 1 || psql -h pg -U $POSTGRES_USER -c "CREATE DATABASE cloud_db" \
    && psql -h pg -U $POSTGRES_USER -c "ALTER DATABASE cloud_db SET TIMEZONE TO 'UTC';" \
    && psql -h pg -U $POSTGRES_USER -d $POSTGRES_DB -c "CREATE TABLE IF NOT EXISTS kvz_options(container VARCHAR(16), \
                                            hash VARCHAR(128), extra VARCHAR(1024));" \
    && psql -h pg -U $POSTGRES_USER -d $POSTGRES_DB -c "CREATE TABLE IF NOT EXISTS files(name VARCHAR(1024), hash VARCHAR(128), \
                                             file_path VARCHAR(512), resolution VARCHAR(16), \
                                             uniq_id VARCHAR(128), raw_video INTEGER, fps INTEGER, bit_depth INTEGER, \
                                             video_format VARCHAR(16))" \
    && psql -h pg -U $POSTGRES_USER -d $POSTGRES_DB -c "CREATE TABLE IF NOT EXISTS work_queue(taskid SERIAL PRIMARY KEY, \
                                             file_id VARCHAR(1024), ops_id VARCHAR(128), file_path VARCHAR(1024), status INTEGER, \
                                             download_count INTEGER, token VARCHAR(128), owner_id VARCHAR(128), \
                                             timestamp BIGINT, file_duration VARCHAR(32), file_size VARCHAR(32));" \
    && redis-server --port 7776 --daemonize yes \
    && node app/socket.js
