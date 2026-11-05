"use strict";

const path = require("node:path");
const { ActionLedger } = require("../lib/facebook/ActionLedger");
const { scan, reactionState, priorShare, validateTarget, validateParent, readTargetPost, resolveParent } = require("./engagePost");
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Read-only: reconcileAction(canonicalActionOrKey, {actorID?, storyID?,
 * parentFeedbackID?, expansionToken?, maxScanPages?, inspectOnly?}, callback?).
 * actorID identifies the post OWNER; the recorded action.actor is the acting user.
 * Negative evidence never permits retry. An absent key is never reserved.
 */
module.exports = (defaults, api, ctx) => function reconcileAction(actionOrKey, options = {}, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw fail("INVALID_ACTION", "options must be an object");
    const maxScanPages = options.maxScanPages ?? 3;
    if (!Number.isInteger(maxScanPages) || maxScanPages < 1 || maxScanPages > 10) throw fail("INVALID_ACTION", "maxScanPages must be 1..10");
    const filename = ctx.globalOptions?.actionLedgerPath;
    if (typeof filename !== "string" || !filename.trim()) throw fail("ACTION_LEDGER_REQUIRED", "A durable actionLedgerPath is required");
    const ledger = ctx.facebookActionLedger ||= new ActionLedger({ path: filename, accountID: ctx.userID });
    if (ledger.accountID !== ctx.userID || ledger.path !== path.resolve(filename)) throw fail("ACTION_LEDGER_REQUIRED", "Ledger path/account mismatch");
    if (options.inspectOnly === true) return ledger.inspect(actionOrKey);
    return ledger.reconcile(actionOrKey, async action => {
      validateTarget(action.target, options);
      if (action.type === "reply") validateParent(action.target, action.parent);
      const inconclusive = coverage => ({ source: "server", matched: false, coverage });
      const found = (coverage, existingID) => ({ source: "server", matched: true, coverage,
        result: { skipped: true, reason: "reconciled", provenance: "server", coverage, ...(existingID ? { existingID } : {}) } });
      try {
        if (action.type === "comment" || action.type === "reply") {
          let feedbackID = options.parentFeedbackID, expansionToken = options.expansionToken;
          if (action.type === "reply") {
            const parent = await resolveParent(api, action.target, action.parent, options, maxScanPages);
            feedbackID = parent.feedbackID;
            expansionToken = parent.expansionToken;
          }
          const result = await scan(cursor => action.type === "comment" ? api.getPostComments(action.target, { limit: 100, cursor }) :
            api.getCommentReplies(feedbackID, { limit: 100, cursor, expansionToken }),
          item => item.authorID === action.actor && item.text === action.text && typeof item.id === "string" && !!item.id,
          maxScanPages, action.type === "reply" ? "depth-1-replies" : "comments");
          return result.match ? found(result.coverage, result.match.id) : inconclusive(result.coverage);
        }
        if (action.type === "reaction") {
          const actingID = ctx.globalOptions?.pageID || ctx.i_userID || ctx.userID;
          if (action.actor !== actingID) return inconclusive({ reason: "acting-account-mismatch" });
          if (!options.actorID && !options.storyID) return inconclusive({ reason: "post-owner-or-story-required" });
          const post = await readTargetPost(api, action.target, options);
          const coverage = reactionState(post, Number(action.reaction));
          return coverage.known && coverage.matches ? found(coverage) : inconclusive(coverage);
        }
        if (action.type === "share") {
          if (action.destination !== `wall:${action.actor}`) return inconclusive({ historical: "unknown", reason: "destination-not-supported" });
          const result = await priorShare(api, action.actor, action.target, undefined, maxScanPages);
          return result.match ? found(result.coverage, result.match.postID || result.match.id) : inconclusive(result.coverage);
        }
        return inconclusive({ reason: "no-read-only-resolver-for-action" });
      } catch (error) {
        if (["TARGET_MISMATCH", "PARENT_MISMATCH", "INVALID_ARGUMENT", "INVALID_ACTION"].includes(error.code)) throw error;
        return inconclusive({ ...error.coverage, readError: error.code || "READ_FAILED" });
      }
    });
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
};
