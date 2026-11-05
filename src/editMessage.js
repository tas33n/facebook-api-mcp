"use strict";

const { completion } = require("../lib/mqtt/LightSpeedRequest");
const { task, identifier } = require("../lib/mqtt/Task");

module.exports = function (_defaultFuncs, _api, ctx) {
  return function editMessage(text, messageID, callback) {
    const operation = completion(callback);
    let record;
    try {
      messageID = identifier(messageID, "messageID");
      if (typeof text !== "string" || !text.trim()) throw new TypeError("text must be a non-empty string");
      if (!ctx.pendingEdits) ctx.pendingEdits = new Map();
      if (ctx.pendingEdits.has(messageID)) throw Object.assign(new Error("An edit of this message is already pending"), { code: "EDIT_PENDING" });
      const cap = ctx.globalOptions?.editSettings?.maxPendingEdits ?? 200;
      if (ctx.pendingEdits.size >= cap) throw Object.assign(new Error("Pending edit capacity reached"), { code: "EDIT_QUEUE_FULL" });
      record = { text, ts: Date.now(), attempts: 1 };
      ctx.pendingEdits.set(messageID, record);
      ctx.health?.addPendingEdit(messageID, text);
      task(ctx, {
        label: "742", payload: { message_id: messageID, text },
        queue: "edit_message", type: "edit_message", version: "6903494529735864",
      }, (error, data) => {
        if (ctx.pendingEdits.get(messageID) === record) ctx.pendingEdits.delete(messageID);
        ctx.health?.removePendingEdit(messageID);
        operation.done(error, data);
      }, data => ({ ...data, messageID, acknowledged: true, verified: false }));
    } catch (error) {
      if (record && ctx.pendingEdits?.get(messageID) === record) ctx.pendingEdits.delete(messageID);
      operation.done(error);
    }
    return operation.promise;
  };
};
