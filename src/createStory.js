"use strict";
const { randomUUID } = require("node:crypto");
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { operationError } = require("../lib/facebook/OperationRegistry");

module.exports = (defaults, api, ctx) => (options, callback) => {
  const promise = Promise.resolve().then(async () => {
    if (!options || typeof options !== "object") throw new TypeError("Story options are required");
    const types = [options.photoID != null, options.videoID != null, options.text != null].filter(Boolean).length;
    if (types !== 1) throw new TypeError("Supply exactly one of photoID, videoID or text");
    for (const key of ["photoID", "videoID", "textPresetID", "fontID"]) {
      if (options[key] != null && (typeof options[key] !== "string" || !/^\d+$/.test(options[key]))) throw new TypeError(`${key} must be a decimal-string ID`);
    }
    if (options.text != null && (typeof options.text !== "string" || !options.text.trim() || !options.textPresetID || !options.fontID)) {
      throw new TypeError("Text stories require nonempty text, textPresetID and fontID from the current Story composer");
    }
    if (options.privacy !== "current") throw new TypeError('privacy must be "current": this uses the account\'s existing Story audience settings');
    const actor = String(ctx.globalOptions?.pageID || ctx.i_userID || ctx.userID);
    const session = randomUUID();
    const input = {
      actor_id: actor, client_mutation_id: session,
      audiences: [{ stories: { self: { target_id: actor, audience_info: {
        client_has_per_story_experience: true, disable_server_fallback_to_default_privacy: false,
      } } } }],
      audiences_is_complete: true, source: "WWW", logging: { composer_session_id: session },
    };
    if (options.photoID) input.attachments = [{ photo: { id: options.photoID, overlays: [] } }];
    if (options.videoID) input.attachments = [{ video: { id: options.videoID } }];
    if (options.text != null) Object.assign(input, { message: { ranges: [], text: options.text },
      text_format_metadata: { inspirations_custom_font_id: options.fontID }, text_format_preset_id: options.textPresetID });
    const data = await createGraphQLClient(defaults, ctx).request("StoriesCreateMutation", { input }, { mutation: true });
    const id = data.story_create?.story_id || data.story_create?.items?.[0]?.story?.id;
    if (!id) throw Object.assign(operationError("INVALID_RESPONSE", "Story creation returned no story ID"), { outcome: "unknown" });
    return { storyID: String(id), status: "accepted", published: null,
      verification: "Creation acknowledged; encoding/publication must be checked separately" };
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
