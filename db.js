let sqlite3 = require('sqlite3').verbose();

let db = new sqlite3.Database('./cloud.db', (err) => {
    if (err)
        return console.error(err.message);
    console.log('Connected to SQlite database.');
});

function buildInsertSQL(table_name, data, callback) {
    let sql = "INSERT INTO " + table_name + "(";
    let val = " VALUES (";
    let params = [];

    for (let key in data) {
        sql += key + ", ";
        val += "?, ";
        params.push(data[key]);
    }

    sql = 
        sql.substring(0, sql.length - 2) + ")" + 
        val.substring(0, val.length - 2) + ")";

    callback(sql, params);
}

function buildUpdateSQL(table_name, uniq_id_name, uniq_id, data, callback) {
    let sql = "UPDATE " + table_name + " SET ";
    let params = [];

    for (let key in data) {
        sql += key + " = ?, ";
        params.push(data[key]);
    }

    sql = sql.substring(0, sql.length - 2) + 
          " WHERE " + uniq_id_name + " = ?";
    params.push(uniq_id);

    callback(sql, params);
}

module.exports = {

    updateFile : function(file_id, data) {
        return new Promise((resolve, reject) => {
            buildUpdateSQL("files", "uniq_id", file_id,  data, function(sql, params) {
                db.prepare(sql).run(params, function(err) {
                    if (err)
                        reject(err);
                    resolve();
                }).finalize();
            });
        });
    },

    updateTask : function(task_id, data) {
        return new Promise((resolve, reject) => {
            buildUpdateSQL("work_queue", "taskID", task_id,  data, function(sql, params) {
                db.prepare(sql).run(params, function(err) {
                    if (err)
                        reject(err);
                    resolve();
                }).finalize();
            });
        });
    },

    insertFile : function(data) {
        return new Promise((resolve, reject) => {
           buildInsertSQL("files", data, function(sql , params) {
                db.prepare(sql).run(params, function(err) {
                    if (err)
                        reject(err);
                    resolve();
                }).finalize();
           });
        });
    },

    insertTask : function(data) {
        return new Promise((resolve, reject) => {
            buildInsertSQL("work_queue", data, function(sql, params) {
                db.prepare(sql).run(params, function(err) {
                    if (err)
                        reject(err);
                    resolve();
                }).finalize();
            });
        });
    },

    insertOptions : function(data) {
        return new Promise((resolve, reject) => {
            buildInsertSQL("kvz_options", data, function(sql, params) {
                db.prepare(sql).run(params, function(err) {
                    if (err)
                        reject(err);
                    resolve();
                }).finalize();
            });
        });
    },

    getFile : function(file_id) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from files WHERE uniq_id = ?";

            db.get(sql, [file_id], function(err, row) {
                if (err)
                    reject(err)
                resolve(row);
            });
        });
    },

    getOptions : function(options_id) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from kvz_options WHERE hash = ?";

            db.get(sql, [options_id], function(err, row) {
                if (err)
                    reject(err)
                resolve(row);
            });
        });
    },

    getLastInsertedId : function() {
        return new Promise((resolve, reject) => {
            const sql = "SELECT last_insert_rowid() as id";

            db.get(sql, [], function(err, row) {
                if (err)
                    reject(err);
                resolve(row.id);
            });
        });
    },

    getTaskUsingTaskID : function(taskID, callback) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE taskID = ?";

            db.get(sql, [taskID], function(err, row) {
                if (err)
                    reject(err);
                resolve(row);
            });
        });
    },

    getTaskUsingOwnerFileOptions : function(owner, file_id, options_id, callback) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE file_id = ? AND ops_id = ? AND owner_id = ?";

            db.get(sql, [file_id, options_id, owner], function(err, row) {
                if (err)
                    reject(err);
                resolve(row);
            });
        });
    },

    // function overloading in javascript is quite exotic...
    getTask : function() {
        return new Promise((resolve, reject) => {
            if (arguments.length == 1 && typeof(arguments[0]) === "number")
            {
                resolve(this.getTaskUsingTaskID(arguments[0], arguments[1]));
            } else if (arguments.length == 3 &&
                typeof(arguments[0]) === "string" &&
                typeof(arguments[1]) === "string" &&
                typeof(arguments[2]) === "string")
            {
                resolve(this.getTaskUsingOwnerFileOptions(arguments[0], arguments[1], arguments[2], arguments[3]));
            } else {
                reject(new Error("invalid parameters when calling getTask"));
            }
        });
    },

    //  ------------------------------ OLD API ------------------------------ 
    // getFileData : function(file_id, callback) {
        
    // },

    getFileOptions : function(file_id, options_id, callback) {
        const sql = "SELECT * FROM file_options WHERE file_uniq_id = ? AND options_uniq_id = ?";

        db.get(sql, [file_id, options_id], function(err, row) {
            if (err)
                throw err;
            callback(row);
        });
    },

    getAllFileOptions : function(file_id, callback) {
        const sql = "SELECT * FROM file_options WHERE file_uniq_id = ?";

        db.all(sql, [file_id], function(err, rows) {
            if (err)
                throw err;
            callback(rows);
        });
    },

    getFileDataAndOptions : function(file_ops_id, callback) {
        const sql = "SELECT * FROM file_options fops " +
                    "INNER JOIN files f ON fops.file_uniq_id = f.uniq_id " +
                    "INNER JOIN kvz_options k ON fops.options_uniq_id = k.hash " +
                    "WHERE fops.file_ops_id = ?";

        db.get(sql, [file_ops_id], function(err, row) {
            if (err)
                throw err;

            if (!row) {
                console.log("no data");
                callback(null, null);
                return;
            }

            const file_ops = {
                resolution:  row.resolution,
                raw_video:   row.raw_video,
                file_path:   row.filepath,
                // file_status: row.status, // TODO
                container:   row.container,
                uniq_id:     row.file_uniq_id
            };

            // TODO is kvz unique id needed??
            const kvz_ops = {
                preset: row.preset,
            };

            callback(file_ops, kvz_ops);
        });
    },

    
    getTaskFromQueue : function(fileOptionsID, callback) {
        const sql = "SELECT * FROM work_queue WHERE file_ops_id = ?";

        db.get(sql, [fileOptionsID], function(err, row) {
            if (err)
                throw err;
            callback(row);
        });
    },

    getKvzOptions : function(kvazaarHash, callback) {
        const sql = "SELECT * from kvz_options WHERE hash = ?";

        db.get(sql, [kvazaarHash], function(err, row) {
            if (err)
                throw err;
            callback(row);
        });
    },

    // TODO parse and validate options (lookup table)
    setKvzOptions : function(kvazaarHash, kvzOptions, callback) {
        const sql = "INSERT INTO kvz_options (preset, container, hash) VALUES (?, ?, ?)";

        db.prepare(sql).run([kvzOptions.preset, kvzOptions.container, kvazaarHash], function(err) {
            if (err)
                throw err;
            callback();
        });
    },

    // add new entry to file_options table (link file with given options)
    linkOptions : function(file_id, options_id, callback) {
        const sql = "INSERT INTO file_options (file_uniq_id, options_uniq_id) VALUES (?, ?)"

        db.prepare(sql).run([file_id, options_id], function(err) {
            if (err) {
                throw err;
            }
            callback(err);
        });
    },

    execQuery : function(sql, params, callback) {
        db.prepare(sql).run(params, function(err) {
            callback(err);
        });
    },

    // TODO make this more flexible
    // updateFile : function(fileID, hash, filepath, callback) {
    //     const sql = "UPDATE files SET hash = ?, filepath = ?  WHERE uniq_id = ?";

    //     db.prepare(sql).run([hash, filepath, fileID], function(err) {
    //         callback();
    //     });
    // },

    // enqueueTask : function(fileOptionsID, token, callback) {
    //     const sql = "INSERT INTO work_queue (file_ops_id, token) VALUES (?, ?)";

    //     db.prepare(sql).run([fileOptionsID, token], function(err) {
    //         if (err)
    //             throw err;
    //         callback();
    //     });
    // },

    // TODO use prepared statement
    getWorkerData : function(token, callback) {
        const sql = "SELECT * FROM work_queue WHERE token = ?";

        db.get(sql, [token], function(err, row) {
            if (err)
                throw err;
            callback(row);
        });
    },

    updateWorkerStatus : function(token, status, callback) {
        const sql = "UPDATE work_queue SET status = ? WHERE token = ?";

        db.prepare(sql).run([status, token], function(err) {
            if (err)
                throw err;
            callback();
        });
    },

    addOutputPath : function(token, file_path, callback) {
        const sql = "UPDATE work_queue SET status = ?, file_path = ? WHERE token = ?";

        db.prepare(sql).run([1337, file_path, token], function(err) {
            if (err)
                throw err;
            callback();
        });
    },

    registerUpload : function(token, count, callback) {
        const sql = "UPDATE work_queue SET download_count = ? WHERE token = ?";

        console.log("new download count: " + count);

        db.prepare(sql).run([count, token]).finalize();
        // db.prepare(sql).run([count, token], function(err) {
        //     if (err)
        //         throw err;
        //     callback();
        // });
    }
};
