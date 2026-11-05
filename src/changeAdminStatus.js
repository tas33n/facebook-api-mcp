"use strict";
const { management } = require("../lib/mqtt/ThreadManagement");
module.exports = (_defaults, _api, ctx) => function changeAdminStatus(threadID, adminIDs, adminStatus, callback) {
  return management(ctx, "changeAdminStatus", [threadID, adminIDs, adminStatus], callback);
};
