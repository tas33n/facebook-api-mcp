"use strict";
const m = require("../lib/facebook/ContentManagement");
module.exports = (defaults, api, ctx) => (target, audience, options = {}, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  return m.callback(Promise.resolve().then(async () => {
    const states = { PUBLIC: "EVERYONE", FRIENDS: "FRIENDS", SELF: "SELF" };
    if (!Object.prototype.hasOwnProperty.call(states, audience)) throw new TypeError("audience must be PUBLIC, FRIENDS or SELF");
    const identity = m.storyIdentity(target, options);
    const graphql = m.client(defaults, ctx);
    const before = await m.readStory(graphql, identity);
    let scope;
    m.walkRootStory(before.node, node => { if (!scope && node.privacy_write_id && node.can_viewer_edit === true) scope = node; });
    if (!scope) throw m.operationError("AUDIENCE_UNAVAILABLE", "No editable privacy scope returned");
    await graphql.request("CometPrivacySelectorSavePrivacyMutation", {
      input: { privacy_mutation_token: null, privacy_write_id: scope.privacy_write_id, render_location: "COMET_STREAM",
        privacy_row_input: { allow: [], deny: [], base_state: states[audience], tag_expansion_state: "UNSPECIFIED" } },
      privacySelectorRenderLocation: "COMET_STREAM", storyRenderLocation: "timeline", scale: 1, tags: [],
      __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true, __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
    }, { mutation: true, allowIncremental: true });
    let verified = false;
    try { verified = m.audienceRows(await m.readStory(graphql, identity)).some(row => row.base_state === states[audience]); } catch (_) {}
    return { storyID: identity.storyID, audience, verified };
  }), cb);
};
