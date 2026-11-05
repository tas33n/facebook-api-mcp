"use strict";
// Explicit bounded selection: discovery never causes engagement on its own.
module.exports = (defaults, api) => (posts, action, callback) => {
  const promise = Promise.resolve().then(async () => {
    if (!Array.isArray(posts) || posts.length < 1 || posts.length > 50) throw new TypeError("Supply 1..50 explicitly selected posts");
    if (!action || !["comment", "reaction", "share"].includes(action.action)) throw new TypeError("Batch action must be comment, reaction or share");
    const inputs = posts.map(post => {
      if (!post || typeof post.postID !== "string" || !/^\d+$/.test(post.postID)) throw new TypeError("Each selected post requires a numeric postID");
      return { ...action, postID: post.postID, actorID: post.authorID, storyID: post.storyID, url: post.url };
    });
    const results = [];
    for (const input of inputs) {
      try {
        const result = await api.engagePost(input);
        results.push({ postID: input.postID, ...result });
        if (result.status === "unknown") return { results, complete: false, remaining: inputs.length - results.length, stoppedReason: "unknown-outcome" };
      } catch (error) {
        results.push({ postID: input.postID, status: "error", error: { code: error.code || "ACTION_FAILED", outcome: error.outcome || null } });
        return { results, complete: false, remaining: inputs.length - results.length, stoppedReason: "action-error" };
      }
    }
    return { results, complete: true, remaining: 0, stoppedReason: null };
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
