// Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
// stopListenMqtt.js - Stop listening to MQTT events

const utils = require('../utils');

module.exports = function (defaultFuncs, api, ctx){
  return function stopListenMqtt() {
    if (typeof api.stopListeningAsync === 'function') return api.stopListeningAsync();
    if (!ctx.mqttClient) {
      return Promise.resolve();
    }
    utils.log("stopListenMqtt", "Stopping...");
    ctx.mqttClient.unsubscribe("/webrtc");
    ctx.mqttClient.unsubscribe("/rtc_multi");
    ctx.mqttClient.unsubscribe("/onevc");
    ctx.mqttClient.publish("/browser_close", "{}");
    return new Promise(resolve => ctx.mqttClient.end(false, () => {
      utils.log("stopListenMqtt", "Stopped");
      ctx.mqttClient = null;
      resolve();
    }));
  };
};
