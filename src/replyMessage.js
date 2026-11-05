"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * replyMessage.js - Dedicated helper to reply to a specific message in a chat
 */

const { completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  return function replyMessage(msg, threadID, replyToMessageID, callback) {
    const operation = completion(callback);
    const returnPromise = operation.promise;
    callback = operation.done;

    if (!replyToMessageID) {
      const err = new Error("replyToMessageID is required for replyMessage");
      callback(err);
      return returnPromise;
    }

    // Prefer MQTT if connected for fastest transmission
    if (ctx.mqttClient && ctx.mqttClient.connected && typeof api.sendMessageMqtt === "function") {
      api.sendMessageMqtt(msg, threadID, callback, String(replyToMessageID));
      return returnPromise;
    }

    if (typeof api.sendMessage === "function") {
      api.sendMessage(msg, threadID, callback, String(replyToMessageID));
      return returnPromise;
    }

    const err = new Error("Neither sendMessage nor sendMessageMqtt is available");
    callback(err);
    return returnPromise;
  };
};
