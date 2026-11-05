"use strict";

const { completion } = require("../lib/mqtt/LightSpeedRequest");
const { identifier } = require("../lib/mqtt/Task");

module.exports = function (_defaultFuncs, api, _ctx) {
  return function shareLink(text, url, threadID, callback) {
    if (typeof threadID === "function" || threadID === undefined) {
      callback = threadID;
      threadID = url;
      url = text;
      text = "";
    }
    const operation = completion(callback);
    try {
      threadID = identifier(threadID, "threadID");
      if (typeof text !== "string") throw new TypeError("text must be a string");
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol)) throw new TypeError("url must use HTTP or HTTPS");
      // Reuse the existing URL-attachment implementation and its message-ID readback.
      const result = api.sendMessage({ body: text, url: parsed.href }, threadID, operation.done);
      if (result?.then) result.then(value => operation.done(null, value), operation.done);
    } catch (error) { operation.done(error); }
    return operation.promise;
  };
};
