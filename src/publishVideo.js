"use strict";

const { randomUUID } = require("node:crypto");
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { operationError } = require("../lib/facebook/OperationRegistry");
const { objectOptions, identifier, actor, text, callbackPromise } = require("../lib/facebook/VideoUpload");

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  // Experimental: actor capabilities and audience are determined by the web backend.
  return function publishVideo(options, callback) {
    return callbackPromise(Promise.resolve().then(async () => {
      objectOptions(options);
      const videoID = identifier(options.videoID, "videoID");
      const target = actor(ctx, options.targetID);
      const input = { actor_id: target, client_mutation_id: randomUUID(), basic_data: {
        source: "composer", target_id: target, video_id: videoID,
        video_title: text(options.title, "title"), waterfall_id: randomUUID(),
        xhpc_message: text(options.description, "description"), creator_product: "2", supports_chunking: true,
        composer_entry_point_ref: "timeline",
      }, post_status_data: { draft: false, scheduled: false, expire_type: null },
      thumbnail_data: {}, ad_break_data: {}, vu_editor_data: { auto_reframe_mobile_only: false },
      main_composer_tab_data: { branded_content_data: null, cta_type: null, direct_share_status: null,
        funded_content_program: null, sponsor_relationship: null },
      distribution_data: { commentating_permission: null, mature_content_rating: null },
      stars_data: {}, questions_data: {}, polls_data: {}, tracking_data: {}, captions_data: {},
      spherical_data: { projection: null, stereoMode: null }, live_premiere_data: {},
      location_preset_data: {}, video_abtesting_data: {}, auto_dub_data: {}, non_uuc_reel_data: {},
      translated_audio_data: {}, share_story_settings: null };
      const data = await graphql.request("VideoComposerVideoPublishingMutation", { input }, { mutation: true });
      const publishedID = data?.video_publish?.video_asset_id;
      if (typeof publishedID !== "string" || !/^\d+$/.test(publishedID)) throw Object.assign(operationError("INVALID_RESPONSE", "Video publish response missing video_asset_id"), { outcome: "unknown" });
      return { videoID: publishedID, published: true };
    }), callback);
  };
};
