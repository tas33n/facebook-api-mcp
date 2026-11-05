"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * changeNicknameMqtt.js - Change participant nickname via LightSpeed MQTT (/ls_req)
 */

const { generateOfflineThreadingID } = require("../utils");
const { request, completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  return function changeNicknameMqtt(nickname, threadID, participantID, callback) {
    if (!threadID || !participantID || typeof nickname !== "string") {
      const operation = completion(callback);
      operation.done(new TypeError("nickname must be a string; threadID and participantID are required"));
      return operation.promise;
    }

    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
    const reqID = ctx.wsReqNumber;
    const taskID = ctx.wsTaskNumber;

    const queryPayload = {
      thread_key: String(threadID),
      contact_id: String(participantID),
      nickname: String(nickname || ""),
      sync_group: 1,
    };

    const task = {
      failure_count: null,
      label: "44",
      payload: JSON.stringify(queryPayload),
      queue_name: "thread_participant_nickname",
      task_id: taskID,
    };

    const context = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        epoch_id: parseInt(generateOfflineThreadingID(), 10),
        tasks: [task],
        version_id: "8222381697807406",
      }),
      request_id: reqID,
      type: 3,
    };

    return request(ctx, context, "change_nickname_mqtt", callback);
  };
};
