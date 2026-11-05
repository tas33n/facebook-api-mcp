"use strict";
const m = require("../lib/facebook/ContentManagement");
module.exports = (defaults, api, ctx) => (id, text, options = {}, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  return m.callback(Promise.resolve().then(async () => {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("Nonempty comment text required");
    const commentID = m.commentID(id, options.postID);
    const data = await m.client(defaults, ctx).request("useCometUFIEditCommentMutation", {
      input: { attachments: null, comment_id: commentID, formatting_style: "PLAIN_TEXT", message: { text, ranges: [] }, tracking: [] },
      feedLocation: "PERMALINK", scale: 1, useDefaultActor: false, translationType: "ORIGINAL",
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__IsWorkUserrelayprovider: false,
    }, { mutation: true, allowIncremental: true });
    if (data.comment_edit?.comment?.id !== commentID) throw Object.assign(m.operationError("INVALID_RESPONSE", "Comment edit returned no matching identity"), { outcome: "unknown" });
    const postID = /^comment:(\d+)_/.exec(Buffer.from(commentID, "base64").toString())[1];
    let verified = false;
    try {
      const page = options.parentFeedbackID ? await api.getCommentReplies(options.parentFeedbackID, { limit: 100, expansionToken: options.expansionToken }) : await api.getPostComments(postID, { limit: 100 });
      verified = page.items.some(item => item.id === commentID && item.text === text);
    } catch (_) {}
    return { commentID, text, verified };
  }), cb);
};
