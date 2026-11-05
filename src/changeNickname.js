"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * changeNickname.js - Prefer connected MQTT, otherwise use HTTP
 */

const utils = require("../utils");
const log = require("npmlog");
const { completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  return function changeNickname(nickname, threadID, participantID, callback) {
    const operation = completion(callback);
    callback = operation.done;
    const returnPromise = operation.promise;
    if (typeof nickname !== "string" || !threadID || !participantID) {
      callback(new TypeError("nickname must be a string; threadID and participantID are required"));
      return returnPromise;
    }

    // Prefer MQTT if connected for fast, native app execution
    if (ctx.mqttClient && ctx.mqttClient.connected && typeof api.changeNicknameMqtt === "function") {
      api.changeNicknameMqtt(nickname, threadID, participantID, callback);
      return returnPromise;
    }

    function performHttpChange() {
      const form = {
        nickname: nickname || "",
        participant_id: participantID,
        thread_or_other_fbid: threadID,
      };

      defaultFuncs
        .post(
          "https://www.facebook.com/messaging/save_thread_nickname/?source=thread_settings&dpr=1",
          ctx.jar,
          form
        )
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
        .then((resData) => {
          if (resData.error === 1545014) {
            throw { error: "Trying to change nickname of user who is not in thread" };
          }
          if (resData.error === 1357031) {
            throw {
              error:
                "Trying to change user nickname of a thread that doesn't exist. Have at least one message in the thread before trying to change the user nickname.",
            };
          }
          if (resData.error) {
            throw resData;
          }
          return callback(null, resData);
        })
        .catch((err) => {
          log.error("changeNickname", err);
          return callback(err);
        });
    }

    performHttpChange();
    return returnPromise;
  };
};
