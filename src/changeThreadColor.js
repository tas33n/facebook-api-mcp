"use strict";

const { completion } = require("../lib/mqtt/LightSpeedRequest");

// Compatibility name for themes. The former GraphQL mutation failed live
// alternate-theme changes; use the verified LightSpeed task 43 implementation.
module.exports = function (_defaultFuncs, api, ctx) {
  return function changeThreadColor(color, threadID, callback) {
    const operation = completion(callback);
    if (!threadID || !["string", "number"].includes(typeof color) || !/^\d+$/.test(String(color))) {
      operation.done(new TypeError("A numeric theme ID and threadID are required; use api.threadColors for theme IDs"));
    } else if (!ctx.mqttClient?.connected || typeof api.setTheme !== "function") {
      operation.done(Object.assign(new Error("Theme changes require MQTT; start listenMqtt first"), { code: "MQTT_NOT_CONNECTED" }));
    } else {
      api.setTheme(String(color), threadID, operation.done);
    }
    return operation.promise;
  };
};
