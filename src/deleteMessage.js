"use strict";
const { management } = require("../lib/mqtt/ThreadManagement");
// Removes messages for the current account only; unsendMessage is a distinct API.
module.exports = (_defaults, _api, ctx) => function deleteMessage(messageIDs, threadID, callback) {
  if (typeof threadID === "function") { callback = threadID; threadID = undefined; }
  return management(ctx, "deleteMessage", [messageIDs, threadID], callback);
};
