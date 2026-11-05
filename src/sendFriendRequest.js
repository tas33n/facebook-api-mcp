"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * sendFriendRequest.js - Send a friend request to a Facebook user
 */

const utils = require("../utils");
const log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
  return function sendFriendRequest(userID, callback) {
    let resolveFunc = () => {};
    let rejectFunc = () => {};
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof callback !== "function") {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    if (!userID) {
      const err = new Error("User ID is required to send a friend request.");
      callback(err);
      return returnPromise;
    }

    const targetID = String(userID);

    // Primary: GraphQL Comet Friending Mutation
    const graphqlForm = {
      av: ctx.userID,
      fb_api_req_friendly_name: "FriendingCometFriendRequestSendMutation",
      fb_api_caller_class: "RelayModern",
      doc_id: "24047008371656912",
      variables: JSON.stringify({
        input: {
          friend_requestee_id: targetID,
          actor_id: ctx.userID,
          client_mutation_id: String(Math.floor(Math.random() * 1000000)),
        },
      }),
    };

    defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, graphqlForm)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then((resData) => {
        if (resData && resData.errors) {
          throw resData;
        }
        return callback(null, { success: true, targetID });
      })
      .catch((err) => {
        log.warn("sendFriendRequest", "GraphQL friend request failed, trying AJAX fallback...");
        const ajaxForm = {
          to_friend: targetID,
          action: "add_friend",
          how_found: "profile_button",
          ref_param: "none",
          link_data: "unknown",
        };

        defaultFuncs
          .post("https://www.facebook.com/ajax/add_friend/action.php", ctx.jar, ajaxForm)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then((resData) => {
            if (resData && resData.error) throw resData;
            return callback(null, { success: true, targetID, res: resData });
          })
          .catch((ajaxErr) => {
            log.error("sendFriendRequest", ajaxErr);
            return callback(ajaxErr);
          });
      });

    return returnPromise;
  };
};
