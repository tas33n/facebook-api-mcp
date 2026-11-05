"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * setMessageReactionMqtt.js - React to messages using LightSpeed MQTT (/ls_req)
 */

const { generateOfflineThreadingID } = require("../utils");
const { request, completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  return function setMessageReactionMqtt(reaction, messageID, threadID, callback) {
    if (!threadID || !messageID || typeof reaction !== "string") {
      const operation = completion(callback);
      operation.done(new TypeError("reaction must be a string; messageID and threadID are required"));
      return operation.promise;
    }

    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
    const reqID = ctx.wsReqNumber;
    const taskID = ctx.wsTaskNumber;

    const taskPayload = {
      thread_key: String(threadID),
      timestamp_ms: Date.now(),
      message_id: String(messageID),
      reaction: reaction || "",
      actor_id: String(ctx.i_userID || ctx.userID),
      reaction_style: null,
      sync_group: 1,
      send_attribution: Math.random() < 0.5 ? 65537 : 524289,
    };

    const task = {
      failure_count: null,
      label: "29",
      payload: JSON.stringify(taskPayload),
      queue_name: JSON.stringify(["reaction", String(messageID)]),
      task_id: taskID,
    };

    const content = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: parseInt(generateOfflineThreadingID(), 10),
        tasks: [task],
        version_id: "7158486590867448",
      }),
      request_id: reqID,
      type: 3,
    };

    return request(ctx, content, "set_message_reaction", callback);
  };
};
