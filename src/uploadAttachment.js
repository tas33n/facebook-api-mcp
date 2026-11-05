"use strict";

const utils = require("../utils");
const { completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, _api, ctx) {
  return function uploadAttachment(attachments, callback) {
    const operation = completion(callback);
    const items = Array.isArray(attachments) ? attachments : [attachments];
    if (!items.length || items.some(item => !utils.isReadableStream(item))) {
      operation.done(new TypeError("attachments must contain readable streams"));
      return operation.promise;
    }
    Promise.all(items.map(item => defaultFuncs.postFormData(
      "https://upload.facebook.com/ajax/mercury/upload.php", ctx.jar,
      { upload_1024: item, voice_clip: "true" }, {},
    ).then(utils.parseAndCheckLogin(ctx, defaultFuncs)).then(data => {
      if (data.error) throw data;
      const metadata = data.payload?.metadata?.[0];
      if (!metadata || !["fbid", "image_id", "gif_id", "video_id", "audio_id", "file_id"].some(key => metadata[key])) {
        throw Object.assign(new Error("Upload response did not contain an attachment ID"), { code: "INVALID_UPLOAD_RESPONSE", outcome: "unknown" });
      }
      return metadata;
    }))).then(value => operation.done(null, value), operation.done);
    return operation.promise;
  };
};
