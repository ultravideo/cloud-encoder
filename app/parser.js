
module.exports = {

    validateResolution : function(str) {
        return new Promise((resolve, reject) => {
            let res = str.match(/[0-9]{1,4}\x[0-9]{1,4}/g);

            if (res && res.length > 0)
                resolve(res[0]);
            reject(new Error("Invalid resolution!"));
        });
    },

    validateFrameRate : function(str) {
        return new Promise((resolve, reject) => {
            let fps = str.match(/[0-9]{1,4}\/[0-9]{1,4}/g);
            if (fps && fps.length > 0)
                resolve(fps[0]);
            reject(new Error("Invalid FPS!"));
        });
    }
};
