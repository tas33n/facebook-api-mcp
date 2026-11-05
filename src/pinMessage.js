"use strict";

const { completion } = require("../lib/mqtt/LightSpeedRequest");
const { task, identifier } = require("../lib/mqtt/Task");

module.exports = function (_defaultFuncs, _api, ctx) {
  return function pinMessage(pinMode, messageID, threadID, callback) {
    const operation = completion(callback);
    try {
      if (typeof pinMode !== "boolean") throw new TypeError("pinMode must be a boolean");
      messageID = identifier(messageID, "messageID");
      threadID = identifier(threadID, "threadID");
      task(ctx, {
        label: pinMode ? "430" : "431",
        payload: { thread_key: threadID, message_id: messageID, timestamp_ms: Date.now() },
        queue: `${pinMode ? "pin" : "unpin"}_msg_v2_${threadID}`,
        type: "pin_message", version: "25095469420099952",
      }, operation.done);
    } catch (error) { operation.done(error); }
    return operation.promise;
  };
};
