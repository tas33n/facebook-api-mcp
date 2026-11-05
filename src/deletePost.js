"use strict";
const m = require("../lib/facebook/ContentManagement");
module.exports = (defaults, api, ctx) => (target, options = {}, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  return m.callback(Promise.resolve().then(async () => {
    const identity = m.storyIdentity(target, options);
    const graphql = m.client(defaults, ctx);
    const data = await graphql.request("useCometFeedStoryDeleteMutation", {
      input: { story_id: identity.storyID, story_location: "FEED", actor_id: m.actingID(ctx), client_mutation_id: m.randomUUID() },
      scale: 1, __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
    }, { mutation: true, allowIncremental: true });
    const deleted = data.story_delete?.deleted_story_id;
    if (!m.sameStory(deleted, identity.storyID)) throw Object.assign(m.operationError("INVALID_RESPONSE", "Deletion returned no matching story identity"), { outcome: "unknown" });
    let verified = false;
    try { const read = await m.readStory(graphql, identity); verified = Object.prototype.hasOwnProperty.call(read, "node") && read.node === null; } catch (_) { /* An error is not proof of deletion. */ }
    return { deletedStoryID: deleted, verified };
  }), cb);
};
