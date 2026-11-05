"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * sendTypingIndicator.js - Send typing indicator via MQTT (/thread_typing) with HTTP fallback
 */

const utils = require("../utils");
const log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
  function makeTypingIndicator(typ, threadID, callback, isGroup) {
    const operation = require("../lib/mqtt/LightSpeedRequest").completion(callback);
    const returnPromise = operation.promise;
    callback = operation.done;

    // Prefer ultra-fast MQTT publish if connected
    if (ctx.mqttClient && ctx.mqttClient.connected) {
      try {
        const payload = JSON.stringify({
          state: typ ? 1 : 0,
          sender_fbid: String(ctx.userID),
          thread: String(threadID),
        });
        ctx.mqttClient.publish("/thread_typing", payload, { qos: 0, retain: false }, (err) => {
          if (!err) return callback();
          // Fallback to HTTP on MQTT publish error
          performHttpTyping();
        });
        return returnPromise;
      } catch (_) {
        // Fallback to HTTP
      }
    }

    function performHttpTyping() {
      const form = {
        typ: +typ,
        to: "",
        source: "mercury-chat",
        thread: String(threadID),
      };

      if (utils.getType(isGroup) === "Boolean") {
        if (!isGroup) {
          form.to = String(threadID);
        }
        sendHttp(form);
      } else {
        api.getUserInfo(threadID, function (err, res) {
          if (!err && res && Object.keys(res).length > 0) {
            form.to = String(threadID);
          }
          sendHttp(form);
        });
      }
    }

    function sendHttp(form) {
      defaultFuncs
        .post("https://www.facebook.com/ajax/messaging/typ.php", ctx.jar, form)
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
        .then((resData) => {
          if (resData && resData.error) throw resData;
          return callback();
        })
        .catch((err) => {
          log.error("sendTypingIndicator", err);
          if (utils.getType(err) === "Object" && err.error === "Not logged in") {
            ctx.loggedIn = false;
          }
          return callback(err);
        });
    }

    performHttpTyping();
    return returnPromise;
  }

  return function sendTypingIndicator(threadID, callback, isGroup) {
    if (typeof callback === "boolean") {
      isGroup = callback;
      callback = null;
    }

    const started = makeTypingIndicator(true, threadID, callback, isGroup);
    // Legacy callers receive a stop function; expose start completion explicitly.
    started.catch(() => {});
    function end(endCallback) {
      return makeTypingIndicator(false, threadID, endCallback, isGroup);
    }
    end.started = started;
    return end;
  };
};
