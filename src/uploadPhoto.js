"use strict";
const { randomUUID } = require("node:crypto");
const utils = require("../utils");
const { parseResponse } = require("../lib/facebook/GraphQLClient");
const { operationError } = require("../lib/facebook/OperationRegistry");
module.exports = (defaults, api, ctx) => (stream, callback) => {
  const promise = Promise.resolve().then(async () => {
    if (!utils.isReadableStream(stream)) throw new TypeError("Photo must be a readable stream");
    const response = await defaults.postFormData("https://upload.facebook.com/ajax/react_composer/attachments/photo/upload", ctx.jar, {
      source: 8, profile_id: ctx.globalOptions?.pageID || ctx.userID, waterfallxapp: "comet", farr: stream, upload_id: randomUUID(),
    });
    const records = parseResponse(response);
    for (const record of records) if (record.error || record.errors?.length) throw operationError("UPLOAD_FAILED", "Facebook rejected photo upload");
    const payload = records.find(record => record.payload?.photoID)?.payload;
    if (!payload) throw operationError("INVALID_RESPONSE", "Photo upload returned no photo ID");
    return { photoID: String(payload.photoID), published: false };
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
