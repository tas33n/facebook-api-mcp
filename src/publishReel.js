"use strict";

const { randomUUID } = require("node:crypto");
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { operationError } = require("../lib/facebook/OperationRegistry");
const { objectOptions, identifier, text, boolean, callbackPromise } = require("../lib/facebook/VideoUpload");

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  // Experimental: placements are deployment-specific; no unobserved enum is invented here.
  return function publishReel(options, callback) {
    return callbackPromise(Promise.resolve().then(async () => {
      objectOptions(options);
      const videoID = identifier(options.videoID, "videoID");
      if (!Array.isArray(options.placements) || !options.placements.length || options.placements.some(value => typeof value !== "string" || !value.trim())) throw new TypeError("placements must contain deployment-supported nonempty strings");
      const draft = boolean(options.draft, "draft");
      const input = { video_id: videoID, metadata: {
        caption: text(options.caption, "caption"), enable_remix: boolean(options.enableRemix, "enableRemix"),
        is_draft: draft, is_scheduled: false, scheduled_publish_time: null,
      }, client_mutation_id: randomUUID(), should_skip_encoding: false, should_enforce_video_editor_path: false,
      trim_timestamps: null, reframe_aspect_ratio: null, video_collaboration: { collaborators: [] },
      audio_enhancement: { processing: 0 }, placements: options.placements.slice(),
      embeddable: boolean(options.embeddable, "embeddable"), should_share_to_story: false };
      const data = await graphql.request("ReelComposerReelPublishMutation", { input }, { mutation: true });
      const result = data?.cpx_reel_publish;
      if (result?.success !== true) throw Object.assign(operationError("REEL_PUBLISH_FAILED", "Reel publish response did not confirm success"), { outcome: "unknown" });
      if (typeof result.published_video_id !== "string" || !/^\d+$/.test(result.published_video_id)) throw Object.assign(operationError("INVALID_RESPONSE", "Reel publish response missing published_video_id"), { outcome: "unknown" });
      return { videoID: result.published_video_id, published: !draft, draft };
    }), callback);
  };
};
