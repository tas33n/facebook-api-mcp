"use strict";
const { management } = require("../lib/mqtt/ThreadManagement");
module.exports = (_defaults, _api, ctx) => function removeUserFromGroup(userID, threadID, callback) {
  return management(ctx, "removeUserFromGroup", [userID, threadID], callback);
};
