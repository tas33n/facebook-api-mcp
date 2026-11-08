"use strict";

const { randomUUID } = require("node:crypto");
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { operationError } = require("../lib/facebook/OperationRegistry");
const { objectOptions, identifier, actor, text, boolean, callbackPromise } = require("../lib/facebook/VideoUpload");

// The web Reel composer's default placement (ReelComposerReelPublishMutation).
const DEFAULT_PLACEMENTS = ["FACEBOOK_REEL"];

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  return function publishReel(options, callback) {
    return callbackPromise(Promise.resolve().then(async () => {
      objectOptions(options);
      const videoID = identifier(options.videoID, "videoID");
      const placements = options.placements === undefined ? DEFAULT_PLACEMENTS : options.placements;
      if (!Array.isArray(placements) || !placements.length || placements.some(value => typeof value !== "string" || !value.trim())) throw new TypeError("placements must contain nonempty strings (default FACEBOOK_REEL)");
      const draft = boolean(options.draft, "draft");
      // The web client's Relay layer adds actor_id to every mutation input;
      // without it Facebook rejects the input as noncoercible_variable_value.
      const duration = options.durationSeconds;
      if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)) throw new TypeError("durationSeconds must be a positive number");
      // Mirrors the web composer's full input (ReelComposerReelPublishMutation
      // input builder, live-verified 2026-11-08). With only a subset of these
      // fields Facebook answers field_exception.
      const input = { actor_id: actor(ctx, options.targetID), video_id: videoID, metadata: {
        caption: text(options.caption, "caption"), enable_remix: boolean(options.enableRemix, "enableRemix"),
        is_draft: draft, is_scheduled: false, scheduled_publish_time: null,
      }, client_mutation_id: randomUUID(), should_skip_encoding: false, should_enforce_video_editor_path: false,
      trim_timestamps: null, reframe_aspect_ratio: null, reframe_aggressiveness: 1,
      video_collaboration: { collaborators: [] }, post_collaborators: null, ig_collaborators: null,
      video_thumbnail_file_id: null, thumbnail_type: "generated_default", audio_enhancement: { processing: 0 },
      is_boost_toggle_on: false, music_overlay: null, placements: placements.slice(), ig_business_id: null,
      manual_reframe: null, audio_mixing: {}, targeted_privacy_data: null, overlay: null, main_track: null,
      photo_track: null, original_resolution: null, is_receiving_stars_enabled: false, linked_vod_data: null,
      videolist: null, hashtags_logging_data: { added_hashtags: [] }, fb_monetization_data: null,
      embeddable: boolean(options.embeddable, "embeddable"), should_share_to_story: false,
      ...(duration === undefined ? {} : { total_video_duration: duration }),
      should_use_consolidated_reel_edit_publish_path: false, ig_targeted_privacy_data: null,
      vod_in_stream_ads_settings: null, location_tag: null, groups_schedule_resharing: {}, reels_poll: null,
      auto_gen_captions_settings: null, closed_captions: null, has_overridden_video_format: false };
      const data = await graphql.request("ReelComposerReelPublishMutation", { input }, { mutation: true });
      const result = data?.cpx_reel_publish;
      if (result?.success !== true) throw Object.assign(operationError("REEL_PUBLISH_FAILED", "Reel publish response did not confirm success"), { outcome: "unknown" });
      if (typeof result.published_video_id !== "string" || !/^\d+$/.test(result.published_video_id)) throw Object.assign(operationError("INVALID_RESPONSE", "Reel publish response missing published_video_id"), { outcome: "unknown" });
      return { videoID: result.published_video_id, published: !draft, draft };
    }), callback);
  };
};
