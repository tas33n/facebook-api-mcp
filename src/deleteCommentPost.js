"use strict";
const m = require("../lib/facebook/ContentManagement");
module.exports = (defaults, api, ctx) => (id, options = {}, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  return m.callback(Promise.resolve().then(async () => {
    const commentID = m.commentID(id, options.postID);
    const data = await m.client(defaults, ctx).request("CometUFIDeleteCommentMutation", {
      input: { comment_id: commentID, actor_id: m.actingID(ctx), client_mutation_id: m.randomUUID() },
      scale: 1, __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
    }, { mutation: true, allowIncremental: true });
    if (data.comment_delete?.deleted_comment_id !== commentID) throw Object.assign(m.operationError("INVALID_RESPONSE", "Deletion returned no matching comment identity"), { outcome: "unknown" });
    let verified = false;
    const numericPost = /^comment:(\d+)_/.exec(Buffer.from(commentID, "base64").toString())[1];
    try {
      const page = options.parentFeedbackID ? await api.getCommentReplies(options.parentFeedbackID, { limit: 100, expansionToken: options.expansionToken }) : await api.getPostComments(numericPost, { limit: 100 });
      verified = !options.parentFeedbackID && page.pageInfo.hasNextPage === false && !page.items.some(item => item.id === commentID);
    } catch (_) {}
    return { deletedCommentID: data.comment_delete.deleted_comment_id, verified };
  }), cb);
};
