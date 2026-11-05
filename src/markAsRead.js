"use strict";

const utils = require("../utils");
const { completion } = require("../lib/mqtt/LightSpeedRequest");
const { task, identifier } = require("../lib/mqtt/Task");

module.exports = function (defaultFuncs, _api, ctx) {
  return function markAsRead(threadID, read = true, callback) {
    if (typeof read === "function") { callback = read; read = true; }
    const operation = completion(callback);
    try {
      threadID = identifier(threadID, "threadID");
      if (typeof read !== "boolean") throw new TypeError("read must be a boolean");
      if (read && !ctx.globalOptions.pageID && ctx.mqttClient?.connected) {
        task(ctx, {
          label: "21", payload: { thread_id: threadID, last_read_watermark_ts: Date.now(), sync_group: 1 },
          queue: threadID, type: "mark_read", version: "6120284488008082",
        }, operation.done);
      } else {
        const form = { [`ids[${threadID}]`]: read, watermarkTimestamp: Date.now(), shouldSendReadReceipt: read };
        if (ctx.globalOptions.pageID) Object.assign(form, {
          source: "PagesManagerMessagesInterface", request_user_id: ctx.globalOptions.pageID, commerce_last_message_type: "",
        });
        defaultFuncs.post("https://www.facebook.com/ajax/mercury/change_read_status.php", ctx.jar, form)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then(data => { if (data.error) throw data; return null; })
          .then(value => operation.done(null, value), operation.done);
      }
    } catch (error) { operation.done(error); }
    return operation.promise;
  };
};
