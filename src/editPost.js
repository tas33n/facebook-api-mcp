"use strict";
const m = require("../lib/facebook/ContentManagement");
module.exports = (defaults, api, ctx) => (target, text, options = {}, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  return m.callback(Promise.resolve().then(async () => {
    if (typeof text !== "string") throw new TypeError("text must be a string");
    const identity = m.storyIdentity(target, options);
    const graphql = m.client(defaults, ctx);
    const variables = { ...m.storyVariables(identity),
      input: { story_id: identity.storyID, message: { text, ranges: [] }, actor_id: m.actingID(ctx),
        client_mutation_id: m.randomUUID(), editable_post_feature_capabilities: ["CONTAINED_LINK", "CONTAINED_MEDIA", "POLL"] },
      isGroupViewerContent: false, isSocialLearning: false, isStarsEdited: false, isWorkDraftFor: false,
      ppeEnabled: false, shouldFetchProDashContentLibraryStory: false,
      __relay_internal__pv__CometComposerPPEAddCollaboratorsEnabledrelayprovider: false,
      __relay_internal__pv__ContentLibraryHighQualityPillGKrelayprovider: false,
      __relay_internal__pv__ContentLibraryStatusColumnGKrelayprovider: false,
      __relay_internal__pv__ContentLibraryUnifiedContentStatusGKrelayprovider: true,
      __relay_internal__pv__ProdashWebIGContentGKrelayprovider: false,
    };
    const data = await graphql.request("ComposerStoryEditMutation", variables, { mutation: true, allowIncremental: true });
    if (!data.story_edit) throw Object.assign(m.operationError("INVALID_RESPONSE", "Edit returned no story result"), { outcome: "unknown" });
    let verified = false;
    try { verified = (await api.getPost({ storyID: identity.storyID })).text === text; } catch (_) {}
    return { storyID: identity.storyID, text, verified };
  }), cb);
};
