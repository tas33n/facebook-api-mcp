"use strict";

const { completion } = require("../lib/mqtt/LightSpeedRequest");
const { task, identifier } = require("../lib/mqtt/Task");

module.exports = function (_defaultFuncs, _api, ctx) {
  return function shareContact(text, contactID, threadID, callback) {
    // Support both the historical runtime signature and the published shorthand.
    if (typeof threadID === "function" || threadID === undefined) {
      callback = threadID;
      threadID = contactID;
      contactID = text;
      text = "";
    }
    const operation = completion(callback);
    try {
      contactID = identifier(contactID, "contactID");
      threadID = identifier(threadID, "threadID");
      if (typeof text !== "string") throw new TypeError("text must be a string");
      task(ctx, {
        label: "359", payload: { contact_id: contactID, sync_group: 1, text, thread_id: threadID },
        queue: "messenger_contact_sharing", type: "share_contact", version: "7214102258676893",
      }, operation.done);
    } catch (error) { operation.done(error); }
    return operation.promise;
  };
};
