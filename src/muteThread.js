"use strict";
const { management } = require("../lib/mqtt/ThreadManagement");
module.exports = (_defaults, _api, ctx) => function muteThread(threadID, muteSeconds, callback) {
  return management(ctx, "muteThread", [threadID, muteSeconds], callback);
};
