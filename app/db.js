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

    getTasks : function(fieldName, fieldValue) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * FROM work_queue WHERE " + fieldName + " = ?";

            db.all(sql, [fieldValue], function(err, rows) {
                if (err)
                    reject(err);
                resolve(rows);
            });
        });
    },

    getTaskUsingTaskID : function(taskID) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE taskID = ?";

            db.get(sql, [taskID], function(err, row) {
                if (err)
                    reject(err);
                resolve(row);
            });
        });
    },

    getTaskUsingToken : function(token) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE token = ?";

            db.get(sql, [token], function(err, row) {
                if (err)
                    reject(err);
                resolve(row);
            });
        });
    },

    getTaskUsingOwnerFileOptions : function(owner, file_id, options_id) {
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
                resolve(this.getTaskUsingTaskID(arguments[0]));
            } else if (arguments.length == 1 && typeof(arguments[0]) === "string") {
                resolve(this.getTaskUsingToken(arguments[0]));
            } else if (arguments.length == 3 &&
                typeof(arguments[0]) === "string" &&
                typeof(arguments[1]) === "string" &&
                typeof(arguments[2]) === "string")
            {
                resolve(this.getTaskUsingOwnerFileOptions(arguments[0], arguments[1], arguments[2]));
            } else {
                reject(new Error("invalid parameters when calling getTask"));
            }
        });
    },

    removeTaskUsingID : function(taskID) {
        return new Promise((resolve, reject) => {
            const sql = "DELETE FROM work_queue WHERE taskID = ?";

            db.prepare(sql).run([taskID], function(err) {
                if (err) reject(err);
                resolve();
            }).finalize();
        });
    },

    removeTaskUsingToken : function(token) {
        return new Promise((resolve, reject) => {
            const sql = "DELETE FROM work_queue WHERE token = ?";

            db.prepare(sql).run([token], function(err) {
                if (err) reject(err);
                resolve();
            }).finalize();
        });
    },

    removeTask : function() {
        return new Promise((resolve, reject) => {
            if (arguments.length == 1 && typeof(arguments[0]) === "number")
            {
                resolve(this.removeTaskUsingID(arguments[0]));
            } else if (arguments.length == 1 && typeof(arguments[0]) === "string") {
                resolve(this.removeTaskUsingToken(arguments[0]));
            } else {
                reject(new Error("invalid parameters when calling removeTask"));
            }
        });
    },

    removeFile : function(fileID) {
        return new Promise((resolve, reject) => {
            const sql = "DELETE FROM files WHERE uniq_id = ?";

            db.prepare(sql).run([fileID], function(err) {
                if (err) reject(err);
                resolve();
            }).finalize();
        });
    }
};
