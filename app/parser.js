let htmlspecialchars = require('htmlspecialchars');

function getLongParameterName(name) {
    const longParameterNames = {
            "r" : "ref", "p" : "period",
            "q" : "qp",  "n" : "frames",
    };

    if (longParameterNames.hasOwnProperty(name))
        return longParameterNames[name];
    return name;
}

// check if validValues contain the input value and if it does,
// return command name and its value or just the command name.
// Substitute short command names (e.g. "-r" or "q" with full command name)
// For example: "--no-cpuid" and "--ref 3"
function matchValueWithExpected(key, inputValue, validValues) {
    return new Promise((resolve, reject) => {
        for (let i = 0; i < validValues.length; ++i) {

            if (typeof(validValues[i]) === "string") {
                if (validValues[i] === "" + inputValue)
                    resolve(getLongParameterName(key) + " " + validValues[i]);

            } else if (validValues[i] instanceof RegExp) {
                let match = inputValue.toString().match(validValues[i]);
                if (match && match.length > 0) {
                    resolve(getLongParameterName(key) + " " + match[0]);
                }

            } else if (typeof(validValues[i]) === "boolean") {
                if (inputValue === validValues[i]) {
                    let start = validValues[i] ? "" : "no-";
                    resolve(start + getLongParameterName(key));
                }
            }

            if (i == validValues.length - 1) {
                reject(new Error("Invalid value for parameter " + key));
            }
        }
    });
}

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
    },

    validateInputFPS : function(str) {
        return new Promise((resolve, reject) => {
            let fps = str.match(/[1-9]{1}[0-9]{0,2}/);
            if (fps && fps.length > 0) {
                resolve(fps[0]);
            }
            reject(new Error("Invalid FPS!"));
        });
    },

    validateBithDepth : function(str) {
        return new Promise((resolve, reject) => {
            let bitDepth = str.match(/([89]|1[0-6])/);
            if (bitDepth && bitDepth.length > 0) {
                resolve(bitDepth[0]);
            }
            reject(new Error("Invalid bit depth!"));
        });
    },

    validateUserToken : function(str) {
        return new Promise((resolve, reject) => {
            if (typeof(str) === "string") {
                let token = str.match(/[A-Z]{64}/);
                if (token && token.length > 0) {
                    resolve(token[0]);
                }
                reject(new Error("Invalid user token"));
            }
            reject(new Error("Invalid user token"));
        });
    },

    validatePixelFormat : function(str) {
        return new Promise((resolve, reject) => {

            // use hashmap for faster searching
            const validFormats = {
                "h264"             : 1,   "yuv420p"        : 1,   "yuyv422"        : 1,   "rgb24"          : 1,
                "yuv422p"          : 1,   "yuv444p"        : 1,   "yuv410p"        : 1,   "uyyvyy411"      : 1,
                "yuv411p"          : 1,   "gray"           : 1,   "monow"          : 1,   "monob"          : 1,
                "yuvj420p"         : 1,   "yuvj422p"       : 1,   "vdpau_h264"     : 1,   "vdpau_mpeg1"    : 1,
                "yuvj444p"         : 1,   "xvmcmc"         : 1,   "xvmcidct"       : 1,   "uyvy422"        : 1,
                "bgr4"             : 1,   "bgr4_byte"      : 1,   "rgb8"           : 1,   "rgb4"           : 1,
                "nv21"             : 1,   "argb"           : 1,   "rgba"           : 1,   "abgr"           : 1,
                "gray16le"         : 1,   "yuv440p"        : 1,   "yuvj440p"       : 1,   "yuva420p"       : 1,
                "vdpau_mpeg2"      : 1,   "vdpau_wmv3"     : 1,   "vdpau_vc1"      : 1,   "rgb48be"        : 1,
                "rgb565le"         : 1,   "rgb555be"       : 1,   "rgb555le"       : 1,   "bgr565be"       : 1,
                "bgr555le"         : 1,   "vaapi_moco"     : 1,   "vaapi_idct"     : 1,   "vaapi_vld"      : 1,
                "yuv420p16le"      : 1,   "yuv420p16be"    : 1,   "rgb48le"        : 1,   "rgb565be"       : 1,
                "yuv422p16le"      : 1,   "yuv422p16be"    : 1,   "yuv444p16le"    : 1,   "yuv444p16be"    : 1,
                "vdpau_mpeg4"      : 1,   "dxva2_vld"      : 1,   "bgr565le"       : 1,   "bgr555be"       : 1,
                "rgb444le"         : 1,   "rgb444be"       : 1,   "bgr444le"       : 1,   "bgr444be"       : 1,
                "bgr48le"          : 1,   "yuv420p9be"     : 1,   "yuv420p9le"     : 1,   "yuv420p10be"    : 1,
                "yuv420p10le"      : 1,   "yuv422p10be"    : 1,   "bgr48be"        : 1,   "ya8"            : 1,
                "yuv422p10le"      : 1,   "yuv444p9be"     : 1,   "yuv444p9le"     : 1,   "yuv444p10be"    : 1,
                "yuv444p10le"      : 1,   "yuv422p9be"     : 1,   "yuva444p"       : 1,   "nv20be"         : 1,
                "yuv422p9le"       : 1,   "vda_vld"        : 1,   "gbrp"           : 1,   "gbrp9be"        : 1,
                "gbrp10le"         : 1,   "gbrp16be"       : 1,   "gbrp16le"       : 1,   "yuva422p"       : 1,
                "yuva420p9le"      : 1,   "yuva422p9be"    : 1,   "yuva422p9le"    : 1,   "yuva444p9be"    : 1,
                "yuva444p9le"      : 1,   "yuva420p10be"   : 1,   "gbrp10be"       : 1,   "yuva420p9be"    : 1,
                "yuva420p10le"     : 1,   "yuva422p10be"   : 1,   "yuva422p10le"   : 1,   "yuva444p10be"   : 1,
                "yuva444p10le"     : 1,   "yuva420p16be"   : 1,   "gbrp9le"        : 1,   "rgba64be"       : 1,
                "yuva420p16le"     : 1,   "yuva422p16be"   : 1,   "yuva422p16le"   : 1,   "yuva444p16be"   : 1,
                "xyz12le"          : 1,   "xyz12be"        : 1,   "nv16"           : 1,   "nv20le"         : 1,
                "rgba64le"         : 1,   "bgra64be"       : 1,   "bgra64le"       : 1,   "yvyu422"        : 1,
                "ya16le"           : 1,   "gbrap"          : 1,   "gbrap16be"      : 1,   "gbrap16le"      : 1,
                "d3d11va_vld"      : 1,   "cuda"           : 1,   "0rgb"           : 1,   "rgb0"           : 1,
                "yuv420p12be"      : 1,   "yuv420p12le"    : 1,   "yuv420p14be"    : 1,   "yuv420p14le"    : 1,
                "yuv422p12be"      : 1,   "yuv422p12le"    : 1,   "yuva444p16le"   : 1,   "vdpau"          : 1,
                "yuv422p14be"      : 1,   "yuv422p14le"    : 1,   "yuv444p12be"    : 1,   "yuv444p12le"    : 1,
                "yuv444p14be"      : 1,   "yuv444p14le"    : 1,   "bgr8"           : 1,   "bayer_bggr8"    : 1,
                "gbrp12be"         : 1,   "gbrp12le"       : 1,   "gbrp14be"       : 1,   "gbrp14le"       : 1,
                "bayer_rggb8"      : 1,   "bayer_gbrg8"    : 1,   "bayer_grbg8"    : 1,   "bayer_bggr16le" : 1,
                "bayer_rggb16le"   : 1,   "bayer_rggb16be" : 1,   "bayer_gbrg16le" : 1,   "bayer_gbrg16be" : 1,
                "bayer_grbg16be"   : 1,   "yuv440p10le"    : 1,   "bayer_grbg16le" : 1,   "bayer_bggr16be" : 1,
                "yuv440p10be"      : 1,   "yuv440p12le"    : 1,   "yuv440p12be"    : 1,   "ayuv64le"       : 1,
                "videotoolbox_vld" : 1,   "yuvj411p"       : 1,   "gbrap10le"      : 1,   "ayuv64be"       : 1,
                "p010le"           : 1,   "p010be"         : 1,   "gbrap12be"      : 1,   "gbrap12le"      : 1,
                "mediacodec"       : 1,   "gray12be"       : 1,   "gray12le"       : 1,   "gray10be"       : 1,
                "p016be"           : 1,   "d3d11"          : 1,   "gray9be"        : 1,   "gray9le"        : 1,
                "gbrapf32be"       : 1,   "gbrapf32le"     : 1,   "drm_prime"      : 1,   "gbrpf32le"      : 1,
                "gbrpf32be"        : 1,   "p016le"         : 1,   "gbrap10be"      : 1,   "gray10le"       : 1,
                "vda"              : 1,   "ya16be"         : 1,   "qsv"            : 1,   "mmal"           : 1,
                "0bgr"             : 1,   "bgr0"           : 1,   "rgb4_byte"      : 1,   "nv12"           : 1,
                "bgra"             : 1,   "gray16be"       : 1,   "pal8"           : 1,   "bgr24"          : 1,
            };

            if (validFormats.hasOwnProperty(str.toLowerCase()))
                resolve(str.toLowerCase());

            reject(new Error("Invalid format: " + htmlspecialchars(str)));
        });
    },

    // kvazaar options can be validated using 3 different ways:
    //  - true/false values
    //  - matching strings
    //  - using regex
    validateKvazaarOptions : function(options) {
        return new Promise((resolve, reject) => {
            options = options.trim();

            let argv = require("minimist")(options.split(" "));
            delete argv['_'];

            // user may have entered extra white spaces between parameters
            // minimist interpets these as values for parameter so they need
            // to be deleted manually
            Object.keys(argv).forEach(function(key) {
                if (argv[key] === "") {
                    argv[key] = true;
                }
            });

            let validatedOptions = [ ];

            const kvazaarOptions = {
                // first all ignored values
                "input":          { ignored: true, expected_value: null },
                "output":         { ignored: true, expected_value: null },
                "debug":          { ignored: true, expected_value: null },
                "width":          { ignored: true, expected_value: null },
                "help":           { ignored: true, expected_value: null },
                "version":        { ignored: true, expected_value: null },
                "input-res":      { ignored: true, expected_value: null },
                "i":              { ignored: true, expected_value: null },
                "output":         { ignored: true, expected_value: null },
                "o":              { ignored: true, expected_value: null },
                "preset":         { ignored: true, expected_value: null },
                "loop-input":     { ignored: true, expected_value: null },
                "threads":        { ignored: true, expected_value: null },
                "roi":            { ignored: true, expected_value: null },
                "width":          { ignored: true, expected_value: null },
                "w":              { ignored: true, expected_value: null },
                "height":         { ignored: true, expected_value: null },
                "h":              { ignored: true, expected_value: null },
                "input-fps":      { ignored: true, expected_value: null },
                "input-bitdepth": { ignored: true, expected_value: null },
                "cqmfile":        { ignored: true, expected_value: null },
                "videoformat":    { ignored: true, expected_value: null },
                "input-format":   { ignored: true, expected_value: null },

                // then values that don't take any parameters
                "aud":               { ignored: false, expected_value: [ true, false ] },
                "cpuid":             { ignored: false, expected_value: [ true, false ] },
                "psnr":              { ignored: false, expected_value: [ true, false ] },
                "info":              { ignored: false, expected_value: [ true, false ] },
                "open-gop":          { ignored: false, expected_value: [ true, false ] },
                "lossless":          { ignored: false, expected_value: [ true, false ] },
                "erp-aqp":           { ignored: false, expected_value: [ true, false ] },
                "rdoq":              { ignored: false, expected_value: [ true, false ] },
                "rdoq-skip":         { ignored: false, expected_value: [ true, false ] },
                "signhide":          { ignored: false, expected_value: [ true, false ] },
                "smp":               { ignored: false, expected_value: [ true, false ] },
                "amp":               { ignored: false, expected_value: [ true, false ] },
                "mv-rdo":            { ignored: false, expected_value: [ true, false ] },
                "full-intra-search": { ignored: false, expected_value: [ true, false ] },
                "transform-skip":    { ignored: false, expected_value: [ true, false ] },
                "bipred":            { ignored: false, expected_value: [ true, false ] },
                "intra-rdo-et":      { ignored: false, expected_value: [ true, false ] },
                "implicit-rdpcm":    { ignored: false, expected_value: [ true, false ] },
                "tmvp":              { ignored: false, expected_value: [ true, false ] },
                "wpp":               { ignored: false, expected_value: [ true, false ] },
                "set-qp-in-cu":      { ignored: false, expected_value: [ true ] },
                "high-tier":         { ignored: false, expected_value: [ true ] }, // TODO DEPENDS ON --level!!! 

                // and then all values that require parameters
                "deblock":              { ignored: false, expected_value: [ false, /(-)?[0-6]{1}\:(-)?[0-6]{1}/ ]},
                "n":                    { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "frames":               { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "seek":                 { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "q":                    { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "qp":                   { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "p":                    { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "period":               { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "vps-period":           { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "r":                    { ignored: false, expected_value: [ /([1-9]|1[0-5])/ ] },
                "ref":                  { ignored: false, expected_value: [ /([1-9]|1[0-5])/ ] },
                "bitrate":              { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "rd":                   { ignored: false, expected_value: [ /[0-3]{1}/ ] },
                "me-steps":             { ignored: false, expected_value: [ /(-)?[0-9]{1,}/ ] },
                "subme":                { ignored: false, expected_value: [ /[0-4]{1}/ ] },
                "pu-depth-inter":       { ignored: false, expected_value: [ /[0-3]{1}(-)[0-3]{1}/ ] },
                "pu-depth-intra":       { ignored: false, expected_value: [ /[0-4]{1}(-)[0-4]{1}/ ] },
                "tr-depth-intra":       { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "fast-residual-cost":   { ignored: false, expected_value: [ /[0-9]{1,}/ ] },
                "owf":                  { ignored: false, expected_value: [ /[0-9]{1,}/, "auto" ] },
                "tiles":                { ignored: false, expected_value: [ /[0-9]{1,}\x[0-9]{1,}/ ] },
                "chromaloc":            { ignored: false, expected_value: [ /[0-5]{1,}/ ] },
                "sar":                  { ignored: false, expected_value: [ /[0-9]{1,}\:[0-9]{1,}/ ] },

                "range":                { ignored: false, expected_value: ["tv", "pc"]  },
                "colorprim":            { ignored: false, expected_value: ["undef", "bt709", "bt470m", "bt470bg",
                                                                           "smpte170m", "smpte240m", "film", "bt2020"] },
                "transfer":             { ignored: false, expected_value: ["undef", "bt709", "bt470m", "bt470bg",
                                                                           "smpte170m", "smpte240m", "linear", "log100",
                                                                           "log316", "iec61966-2-4", "bt1361e",
                                                                           "iec61966-2-1", "bt2020-10", "bt2020-12"] },
                "colormatrix":          { ignored: false, expected_value: ["undef", "bt709", "fcc", "bt470bg", "smpte170m",
                                                                           "smpte240m", "GBR", "YCgCo", "bt2020nc", "bt2020c"] },
                "overscan":             { ignored: false, expected_value: ["undef" , "show", "crop"] },
                "slices":               { ignored: false, expected_value: ["tiles", "wpp", "tiles+wpp"] },
                "me-early-termination": { ignored: false, expected_value: ["on", "off", "sensitive"] },
                "cu-split-termination": { ignored: false, expected_value: ["off", "zero"] },
                "me":                   { ignored: false, expected_value: ["hexbs", "tz", "full", "full8", "dia"] },
                "sao":                  { ignored: false, expected_value: ["off", "band", "edge", "full"] },
                "mv-constraint":        { ignored: false, expected_value: ["none", "frametile", "frametilemargin"] },
                "source-scan-type":     { ignored: false, expected_value: ["progressive", "tff", "bff"] },
                "hash":                 { ignored: false, expected_value: ["none", "checksum", "md5"] },
                "key":                  { ignored: false, expected_value: ["16","213","27","56","255","127","242","112",
                                                                           "97","126","197","204","25","59","38","30"]},
                "gop":                  { ignored: false, expected_value: [ "0", "8", /lp-g[0-9]+d[0-9]+t[0-9]+$/ ]}
            };


            let errors = "";
            let promises = [ ];

            Object.keys(argv).forEach(function(key) {
                if (!kvazaarOptions.hasOwnProperty(key)) {
                    errors += "Unknown parameter: " + htmlspecialchars(key) + "\n";
                    return;
                }

                // jump to next parameter
                if (kvazaarOptions[key].ignored == true) {
                    errors += "Parameter " + key + " is ignored!\n"
                    return;
                }

                promises.push(matchValueWithExpected(key, argv[key], kvazaarOptions[key].expected_value));
            });

            Promise.all(promises).then((values) => {
                if (errors === "")
                    resolve(values);
                else
                    reject(errors);
            })
            .catch(function(err) {
                reject(errors + err.toString() + "\n");
            });
        });
    }
};
