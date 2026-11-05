"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
 * unfollow.js - Unfollow a Facebook user
 */

module.exports = function (defaultFuncs, api, ctx) {
  return function unfollow(senderID, callback) {
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

    if (typeof api.follow === "function") {
      return api.follow(senderID, false, callback);
    }

    const form = {
      av: ctx.userID,
      fb_api_req_friendly_name: "CometUserUnfollowMutation",
      fb_api_caller_class: "RelayModern",
      doc_id: "25472099855769847",
      variables: JSON.stringify({
        action_render_location: "WWW_COMET_FRIEND_MENU",
        input: {
          attribution_id_v2:
            "ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,tap_search_bar,1717294006136,602597,250100865708545,,",
          is_tracking_encrypted: true,
          subscribe_location: "PROFILE",
          subscribee_id: String(senderID),
          tracking: null,
          actor_id: ctx.userID,
          client_mutation_id: "1",
        },
        scale: 1,
      }),
    };

    defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
      .then((res) => callback(null, res))
      .catch((err) => callback(err));

    return returnPromise;
  };
};
