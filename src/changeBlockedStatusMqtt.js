"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * changeBlockedStatusMqtt.js - Block or unblock users via LightSpeed MQTT (/ls_req)
 */

const { generateOfflineThreadingID } = require("../utils.js");
const { randomUUID } = require("node:crypto");
const { request, completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  return function changeBlockedStatusMqtt(userID, status, type, callback) {
    if (typeof type === "function") { callback = type; type = "messenger"; }
    if (type === undefined) type = "messenger";
    if (!userID || typeof status !== "boolean" || !["messenger", "facebook"].includes(type)) {
      const operation = completion(callback);
      operation.done(new TypeError('userID, boolean status, and type "messenger" or "facebook" are required'));
      return operation.promise;
    }

    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
    const reqID = ctx.wsReqNumber;
    const taskID = ctx.wsTaskNumber;

    const label = "334";
    let userBlockAction = 0;

    switch (type) {
      case "messenger":
        userBlockAction = status ? 1 : 0;
        break;
      case "facebook":
        userBlockAction = status ? 3 : 2;
        break;
    }

    const taskPayload = {
      blockee_id: String(userID),
      request_id: randomUUID(),
      user_block_action: userBlockAction,
    };
    const payload = JSON.stringify(taskPayload);
    const version = "25393437286970779";

    const task = {
      failure_count: null,
      label: label,
      payload: payload,
      queue_name: "native_sync_block",
      task_id: taskID,
    };

    const content = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        tasks: [task],
        epoch_id: parseInt(generateOfflineThreadingID(), 10),
        version_id: version,
      }),
      request_id: reqID,
      type: 3,
    };

    return request(ctx, content, "change_blocked_status_mqtt", callback);
  };
};
