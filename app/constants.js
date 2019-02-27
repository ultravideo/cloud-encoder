
module.exports = Object.freeze({
    "CANCELLED": -4,
    "FAILURE": -3,
    "PREPROCESSING": -2,
    "UPLOADING": -1,
    "WAITING": 0,
    "DECODING" : 1,
    "ENCODING" : 2,
    "POSTPROCESSING" : 3,
    "READY" : 4,
    "FILE_TIME_LIMIT_IN_SECONDS": 1800,
    "FILE_SIZE_LIMIT_IN_BYTES": 50 * 1000 * 1000 * 1000, //50GB
    "FILE_DOWNLOAD_LIMIT": 2, // Allow 2 downloads
    "NUMBER_OF_WORKER_THREADS": 5,
});
