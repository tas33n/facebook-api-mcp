"use strict";

const { upload, callbackPromise } = require("../lib/facebook/VideoUpload");

module.exports = function (defaultFuncs, api, ctx) {
  // Experimental staging only. source/sourceType must match the account's web deployment.
  return function uploadVideo(filePath, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    return callbackPromise(Promise.resolve().then(() => upload(defaultFuncs, ctx, filePath, options || {})), callback);
  };
};
