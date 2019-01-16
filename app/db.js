let htmlspecialchars = require('htmlspecialchars');
let process = require("process");
let pg = require("pg");

const pool = new pg.Pool({
    user: process.env.POSTGRES_USER,
    host: "127.0.0.1",
    database: "cloud_db",
    password: process.env.POSTGRES_PASS,
    port: "5432"
});

function buildInsertSQL(table_name, data, callback) {
    let sql = "INSERT INTO " + table_name + "(";
    let val = " VALUES (";
    let params = [];
    let i = 1;

    for (let key in data) {
        sql += key + ", ";
        val += "$" + (i++) + ", ";
        params.push(htmlspecialchars(data[key]));
    }

    sql = 
        sql.substring(0, sql.length - 2) + ")" + 
        val.substring(0, val.length - 2) + ")";

    callback(sql, params);
}

function buildUpdateSQL(table_name, uniq_id_name, uniq_id, data, callback) {
    let sql = "UPDATE " + table_name + " SET ";
    let params = [];
    let i = 1;

    for (let key in data) {
        sql += key + " = $" + (i++) + ", ";
        params.push(htmlspecialchars(data[key]));
    }

    sql = sql.substring(0, sql.length - 2) + 
          " WHERE " + uniq_id_name + " = $" + i;
    params.push(uniq_id);

    callback(sql, params);
}

module.exports = {

    updateFile : function(file_id, data) {
        return new Promise((resolve, reject) => {
            buildUpdateSQL("files", "uniq_id", file_id,  data, function(sql, params) {
                pool.query(sql, params, (err, res) => {
                    if (err) {
                        console.log(sql);
                        console.log(params);
                        reject(err);
                    }
                    resolve();
                });
            });
        });
    },

    updateTask : function(task_id, data) {
        return new Promise((resolve, reject) => {
            buildUpdateSQL("work_queue", "taskID", task_id,  data, function(sql, params) {
                pool.query(sql, params, (err, res) => {
                    if (err) {
                        console.log(sql);
                        console.log(params);
                        reject(err);
                    }
                    resolve();
                });
            });
        });
    },

    insertFile : function(data) {
        return new Promise((resolve, reject) => {
            buildInsertSQL("files", data, function(sql , params) {
                pool.query(sql, params, (err, res) => {
                    if (err) {
                        console.log(sql);
                        console.log(params);
                        reject(err);
                    }
                    resolve();
                });
            });
        });
    },

    insertTask : function(data) {
        return new Promise((resolve, reject) => {
            buildInsertSQL("work_queue", data, function(sql, params) {
                pool.query(sql, params, (err, res) => {
                    if (err) {
                        console.log(sql);
                        console.log(params);
                        reject(err);
                    }
                    resolve();
                });
            });
        });
    },

    insertOptions : function(data) {
        return new Promise((resolve, reject) => {
            buildInsertSQL("kvz_options", data, function(sql, params) {
                pool.query(sql, params, (err, res) => {
                    if (err) {
                        console.log(sql);
                        console.log(params);
                        reject(err);
                    }
                    resolve();
                });
            });
        });
    },

    getFile : function(file_id) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from files WHERE uniq_id = $1";

            pool.query(sql, [file_id], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve(res.rowCount > 0 ? res.rows[0] : null);
            });
        });
    },

    getOptions : function(options_id) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from kvz_options WHERE hash = $1";

            pool.query(sql, [options_id], (err, res) => {
                if (err) {
                    reject(err);
                    console.log(sql);
                    console.log(params);
                }
                resolve(res.rowCount > 0 ? res.rows[0] : null);
            });
        });
    },

    getTasks : function(fieldName, fieldValue) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * FROM work_queue WHERE " + fieldName + " = $1 ORDER BY timestamp ASC";

            pool.query(sql, [fieldValue], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve(res.rowCount > 0 ? res.rows : null);
            });
        });
    },

    getTaskUsingTaskID : function(taskID) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE taskID = $1";

            pool.query(sql, [taskID], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve(res.rowCount > 0 ? res.rows[0] : null);
            });
        });
    },

    getTaskUsingToken : function(token) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE token = $1";

            pool.query(sql, [token], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve(res.rowCount > 0 ? res.rows[0] : null);
            });
        });
    },

    getTaskUsingOwnerFileOptions : function(owner, file_id, options_id) {
        return new Promise((resolve, reject) => {
            const sql = "SELECT * from work_queue WHERE file_id = $1 AND ops_id = $2 AND owner_id = $3";

            pool.query(sql, [file_id, options_id, owner], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve(res.rowCount > 0 ? res.rows[0] : null);
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
            const sql = "DELETE FROM work_queue WHERE taskID = $1";

            pool.query(sql, [taskID], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve();
            });
        });
    },

    removeTaskUsingToken : function(token) {
        return new Promise((resolve, reject) => {
            const sql = "DELETE FROM work_queue WHERE token = $1";

            pool.query(sql, [token], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve();
            });
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
            const sql = "DELETE FROM files WHERE uniq_id = $1";

            pool.query(sql, [fileID], (err, res) => {
                if (err) {
                    console.log(sql);
                    reject(err);
                }
                resolve();
            });
        });
    }
};
