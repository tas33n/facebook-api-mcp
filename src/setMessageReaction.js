"use strict";

const utils = require("../utils");
const { completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  return function setMessageReaction(reaction, messageID, threadID, callback) {
    // Preserve the historical (reaction, messageID, callback, forceCustom) form.
    if (typeof threadID === "function") {
      callback = threadID;
      threadID = null;
    }
    const operation = completion(callback);
    if (typeof reaction !== "string" || !messageID) {
      operation.done(new TypeError("reaction must be a string and messageID is required"));
      return operation.promise;
    }
    if (threadID && ctx.mqttClient?.connected && typeof api.setMessageReactionMqtt === "function") {
      api.setMessageReactionMqtt(reaction, messageID, threadID, operation.done);
      return operation.promise;
    }
    const variables = {
      data: {
        client_mutation_id: String(ctx.clientMutationId = (ctx.clientMutationId || 0) + 1),
        actor_id: ctx.i_userID || ctx.userID,
        action: reaction == "" ? "REMOVE_REACTION" : "ADD_REACTION",
        message_id: messageID,
        reaction: reaction,
      },
    };
    const qs = {
      doc_id: "1491398900900362",
      variables: JSON.stringify(variables),
      dpr: 1,
    };
    defaultFuncs
      .postFormData(
        "https://www.facebook.com/webgraphql/mutation/",
        ctx.jar,
        {},
        qs,
      )
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (!resData) {
          throw { error: "setReaction returned empty object." };
        }
        if (resData.error || resData.errors?.length) {
          throw resData;
        }
        operation.done(null, resData);
      })
      .catch(function (err) {
        operation.done(err);
      });

    return operation.promise;
  };
};
