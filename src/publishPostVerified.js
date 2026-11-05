"use strict";
const { callback } = require("../lib/facebook/ContentManagement");
const { verificationOptions, boundedRead } = require("../lib/facebook/PublicationVerifier");
function permalinkIdentity(value) {
  const url = new URL(value);
  const identity = [url.origin, url.pathname.replace(/\/$/, "")];
  for (const key of ["story_fbid", "id", "fbid", "v"]) if (url.searchParams.has(key)) identity.push(`${key}=${url.searchParams.get(key)}`);
  return identity.join("|");
}
module.exports = (defaults, api, ctx) => (content, options = {}, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  return callback(Promise.resolve().then(async () => {
    const verification = verificationOptions(options);
    if (verification.signal?.aborted) throw Object.assign(new Error("Publishing cancelled before request"), { code: "ABORTED" });
    const value = typeof content === "string" ? { body: content } : content;
    if (!value || typeof value !== "object") throw new TypeError("Post content required");
    const url = await api.createPost(value);
    const deadline = Date.now() + verification.timeoutMs;
    try {
    let target;
    if (value.videoID) target = { videoID: value.videoID };
    else {
      // Resolve only the exact newly returned URL, not similar text or timestamps.
      const actorID = String(ctx.globalOptions?.pageID || ctx.i_userID || ctx.userID);
      let cursor;
      for (let page = 0; page < 3; page++) {
        const result = await boundedRead(() => api.getProfilePosts(actorID, { limit: 10, cursor }), deadline, verification.signal);
        const post = result.items.find(item => item.url && permalinkIdentity(item.url) === permalinkIdentity(url));
        if (post) { target = { storyID: post.storyID }; break; }
        if (!result.pageInfo.hasNextPage) break;
        cursor = result.pageInfo.endCursor;
      }
    }
    if (!target) return { url, verification: { verified: false, status: "unavailable", reason: "Published URL was not resolved in three visible profile pages; do not republish" } };
    return { url, verification: await api.verifyPublication(target, {
      ...options, timeoutMs: Math.max(1, deadline - Date.now()), ...(typeof value.body === "string" && !value.videoID ? { expectedText: value.body } : {}),
    }) };
    } catch (error) {
      return { url, verification: { verified: false, status: "unavailable", reason: "Publication was acknowledged but readback failed; do not republish", code: error.code || "READBACK_FAILED" } };
    }
  }), cb);
};
