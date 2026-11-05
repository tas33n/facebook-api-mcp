"use strict";

const path = require("node:path");
const { ActionLedger } = require("../lib/facebook/ActionLedger");
const { storyIdentity, feedbackIdentity } = require("../lib/facebook/PostReader");

const REACTIONS = Object.freeze({ unlike: 0, like: 1, heart: 2, love: 16, care: 16, haha: 4, wow: 3, sad: 7, angry: 8 });

function failure(code, message, coverage) {
  return Object.assign(new Error(message), { code }, coverage ? { coverage } : {});
}

function id(value, name, required = false) {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw failure("INVALID_ACTION", `${name} must be a nonempty string`);
  return value.trim();
}

function commentIdentity(value) {
  if (/^\d+$/.test(value)) return value;
  const match = /^comment:(?:\d+|pfbid[A-Za-z0-9]+)_(\d+)$/.exec(Buffer.from(value, "base64").toString("utf8"));
  return match ? match[1] : value;
}

function validateTarget(postID, { actorID, storyID } = {}) {
  feedbackIdentity(postID); // Validate the canonical numeric target even for comment-only reads.
  if (!actorID && !storyID) return null;
  const identity = storyIdentity(storyID ? { storyID } : { postID, actorID });
  if (identity.postID !== postID || (actorID !== undefined && identity.actorID !== actorID)) {
    throw failure("TARGET_MISMATCH", "Story identity conflicts with the requested post or owner");
  }
  return identity;
}

async function readTargetPost(api, postID, options) {
  const identity = validateTarget(postID, options);
  if (!identity) throw failure("STATE_UNAVAILABLE", "Post owner or story identity is required");
  const post = await api.getPost(options.storyID ? { storyID: identity.storyID } : { postID, actorID: identity.actorID });
  if (post?.postID !== postID || (post.authorID != null && post.authorID !== identity.actorID)) {
    throw failure("TARGET_MISMATCH", "Returned post does not match the requested post and owner");
  }
  return post;
}

function validateParent(postID, parentID) {
  if (typeof parentID !== "string") throw failure("INVALID_ACTION", "A parent comment ID is required");
  if (/^\d+$/.test(parentID)) return;
  const decoded = Buffer.from(parentID, "base64").toString("utf8");
  const match = /^comment:(\d+|pfbid[A-Za-z0-9]+)_(\d+)$/.exec(decoded);
  if (!match || Buffer.from(decoded).toString("base64").replace(/=+$/, "") !== parentID.replace(/=+$/, "")) {
    throw failure("INVALID_ACTION", "Invalid parent comment identity");
  }
  // Opaque pfbid aliases are established through the target's comment connection.
  if (/^\d+$/.test(match[1]) && match[1] !== postID) throw failure("TARGET_MISMATCH", "Parent comment belongs to another post");
}

async function resolveParent(api, postID, parentID, options, maxScanPages) {
  validateTarget(postID);
  validateParent(postID, parentID);
  const parent = await scan(cursor => api.getPostComments(postID, { limit: 100, cursor }),
    item => commentIdentity(item.id || "") === commentIdentity(parentID), maxScanPages, "parent-comments");
  if (!parent.match) throw failure("PARENT_UNRESOLVED", "Parent comment was not found on the requested post", parent.coverage);
  validateParent(postID, parent.match.id);
  if (parent.match.postID != null && parent.match.postID !== postID) throw failure("TARGET_MISMATCH", "Resolved parent belongs to another post", parent.coverage);
  const { feedbackID, expansionToken } = parent.match;
  if (typeof feedbackID !== "string" || !feedbackID || typeof expansionToken !== "string" || !expansionToken) {
    throw failure("PARENT_UNRESOLVED", "Resolved parent feedback ID and expansion token are required", parent.coverage);
  }
  if ((options.parentFeedbackID !== undefined && options.parentFeedbackID !== feedbackID) ||
      (options.expansionToken !== undefined && options.expansionToken !== expansionToken)) {
    throw failure("PARENT_MISMATCH", "Supplied feedback ID or expansion token conflicts with the resolved parent", parent.coverage);
  }
  return { feedbackID, expansionToken, coverage: parent.coverage };
}

async function scan(read, matches, maxScanPages, scope) {
  const coverage = { source: "server", scope, pagesScanned: 0, maxScanPages, exhausted: false,
    note: "Only the visible server connection is scanned; server ordering and visibility apply." };
  const cursors = new Set();
  let cursor;
  while (coverage.pagesScanned < maxScanPages) {
    let page;
    try { page = await read(cursor); }
    catch (error) { error.coverage = coverage; throw error; }
    coverage.pagesScanned++;
    if (!page || !Array.isArray(page.items) || page.items.length > 100) {
      throw failure("STATE_UNAVAILABLE", "Server returned an unusable comment page", coverage);
    }
    const match = page.items.find(item => item && matches(item));
    if (match) return { match, coverage };
    if (page.items.some(item => !item || typeof item.id !== "string" ||
        typeof item.authorID !== "string" || typeof item.text !== "string")) {
      throw failure("STATE_UNAVAILABLE", "Comment identity, author or text is unavailable", coverage);
    }
    if (page.pageInfo?.hasNextPage === false) {
      coverage.exhausted = true;
      return { match: null, coverage };
    }
    const next = page.pageInfo?.endCursor;
    if (page.pageInfo?.hasNextPage !== true || typeof next !== "string" || !next || cursors.has(next)) {
      throw failure("STATE_UNAVAILABLE", "Comment pagination is unavailable or repeated", coverage);
    }
    cursors.add(next);
    cursor = next;
  }
  throw failure("STATE_UNAVAILABLE", "Comment scan reached maxScanPages; absence is not established", coverage);
}

function reactionState(post, reaction) {
  const current = post?.viewerReaction;
  const name = typeof current?.name === "string" ? current.name.toLowerCase() : undefined;
  const known = post?.viewerReactionKnown === true && (current === null ||
    String(current?.id) === "1635855486666999" || Object.prototype.hasOwnProperty.call(REACTIONS, name));
  return { source: "server", scope: "viewer-reaction", known,
    matches: (reaction === 0 && current === null) ||
      (reaction === 1 && String(current?.id) === "1635855486666999") ||
      (name !== undefined && REACTIONS[name] === reaction) };
}

async function priorShare(api, actingID, postID, groupID, maxScanPages) {
  const coverage = { source: "local-only", scope: "share-deduplication", historical: "unknown",
    pagesScanned: 0, maxScanPages, exhausted: false };
  if (groupID || typeof api.getProfilePosts !== "function") return { coverage, match: null };
  coverage.source = "server";
  const cursors = new Set();
  let cursor;
  while (coverage.pagesScanned < maxScanPages) {
    let page;
    try { page = await api.getProfilePosts(actingID, { limit: 50, cursor }); }
    catch (error) { coverage.readError = error.code || "READ_FAILED"; break; }
    coverage.pagesScanned++;
    if (!Array.isArray(page?.items) || page.items.length > 100) break;
    const match = page.items.find(item => item?.authorID === actingID && item.sharedPostID === postID && !item.groupID);
    if (match) { coverage.historical = "matched"; return { coverage, match }; }
    if (page.pageInfo?.hasNextPage === false) { coverage.exhausted = true; break; }
    const next = page.pageInfo?.endCursor;
    if (page.pageInfo?.hasNextPage !== true || typeof next !== "string" || !next || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  coverage.note = "No matching share observed; bounded profile visibility and missing original-target metadata cannot establish historical absence.";
  return { coverage, match: null };
}

/**
 * engagePost({ action: 'comment'|'reply'|'reaction'|'share', postID,
 *   actorID?, storyID?, text?, parentCommentID?, parentFeedbackID?,
 *   expansionToken?, reaction?, url?, groupID?, baseState?, maxScanPages? }, cb?)
 * returns Promise<{duplicate, status, key, provenance, result}>. cb is (error, value).
 * actorID is the POST OWNER for getPost, not the acting account/page.
 * Requires globalOptions.actionLedgerPath (an existing parent directory).
 * result contains skipped, reason/existingID when found, provenance, coverage,
 * and mutation for a newly performed effect. Duplicate results retain original
 * result; top-level provenance is 'ledger'. Unknown/safe_retry records never replay.
 * Comments/replies require exact own text and scan 100 items/page, default 3,
 * maximum 10 pages. Incomplete scans fail STATE_UNAVAILABLE with coverage.
 * Replies always resolve parentCommentID through the target post's comments and
 * validate supplied feedback/token. Reactions require verified target identity.
 * Repeated completed reactions refresh server state and may reserve a new revision;
 * uncertain reactions block every desired reaction for the same actor and target.
 * Shares inspect bounded owned-profile pages when available; historical absence
 * remains unknown. baseState defaults to 1; group destinations have distinct keys.
 */
module.exports = (defaults, api, ctx) => function engagePost(options, callback) {
  const promise = Promise.resolve().then(async () => {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("INVALID_ACTION", "An engagement object is required");
    const input = { ...options };
    const action = input.action;
    if (!["comment", "reply", "reaction", "share"].includes(action)) throw failure("INVALID_ACTION", "Unsupported engagement action");
    const postID = id(input.postID, "postID", true);
    const actorID = id(input.actorID, "actorID");
    const storyID = id(input.storyID, "storyID");
    validateTarget(postID, { actorID, storyID });
    const accountID = id(ctx.userID, "Authenticated accountID", true);
    const actingID = id(ctx.globalOptions?.pageID || ctx.i_userID || accountID, "Acting accountID", true);
    const filename = ctx.globalOptions?.actionLedgerPath;
    if (typeof filename !== "string" || !filename.trim()) throw failure("ACTION_LEDGER_REQUIRED", "engagePost requires globalOptions.actionLedgerPath for durable deduplication");
    const maxScanPages = input.maxScanPages === undefined ? 3 : input.maxScanPages;
    if (!Number.isInteger(maxScanPages) || maxScanPages < 1 || maxScanPages > 10) throw failure("INVALID_ACTION", "maxScanPages must be an integer from 1 to 10");
    const text = input.text === undefined ? "" : input.text;
    if (typeof text !== "string" || (["comment", "reply"].includes(action) && !text.trim())) throw failure("INVALID_ACTION", "A nonempty text string is required for comments and replies");
    const parentCommentID = action === "reply" ? id(input.parentCommentID, "parentCommentID", true) : undefined;
    if (parentCommentID) validateParent(postID, parentCommentID);
    let parentFeedbackID = action === "reply" ? id(input.parentFeedbackID, "parentFeedbackID") : undefined;
    let expansionToken = action === "reply" ? id(input.expansionToken, "expansionToken") : undefined;
    if (expansionToken && expansionToken.length > 16384) throw failure("INVALID_ACTION", "expansionToken is too long");
    let reaction;
    if (action === "reaction") {
      reaction = typeof input.reaction === "string" ? REACTIONS[input.reaction.toLowerCase()] : input.reaction;
      if (!Object.values(REACTIONS).includes(reaction)) throw failure("INVALID_ACTION", "Invalid reaction type");
      if (!actorID && !storyID) throw failure("STATE_UNAVAILABLE", "Reaction checks require the post owner's actorID or storyID");
    }
    let url;
    const groupID = action === "share" ? id(input.groupID, "groupID") : undefined;
    const baseState = input.baseState === undefined ? 1 : input.baseState;
    if (action === "share") {
      try { url = new URL(input.url); } catch (_) { throw failure("INVALID_ACTION", "Sharing requires a Facebook post URL"); }
      if (url.protocol !== "https:" || !["www.facebook.com", "facebook.com"].includes(url.hostname) || url.username || url.password) throw failure("INVALID_ACTION", "Sharing requires a Facebook post URL");
      if (![1, 2, 3].includes(baseState)) throw failure("INVALID_ACTION", "baseState must be 1, 2 or 3");
    }
    const required = action === "comment" ? ["getPostComments", "createCommentPost"] :
      action === "reply" ? ["getCommentReplies", "createCommentPost", "getPostComments"] :
      action === "reaction" ? ["getPost", "setPostReaction"] : ["sharePost", ...(actorID || storyID ? ["getPost"] : [])];
    for (const method of required) if (typeof api[method] !== "function") throw failure("UNSUPPORTED_ACTION", `${method} is unavailable`);
    if (!ctx.facebookActionLedger) ctx.facebookActionLedger = new ActionLedger({ accountID, path: filename });
    const ledger = ctx.facebookActionLedger;
    if (!ledger.durable || ledger.path !== path.resolve(filename) || ledger.accountID !== accountID) {
      throw failure("ACTION_LEDGER_REQUIRED", "The active action ledger must match the configured durable path and account");
    }
    const key = { type: action, targetID: postID, actorID: actingID,
      text: action === "reaction" ? "" : text,
      ...(parentCommentID ? { parentID: commentIdentity(parentCommentID) } : {}),
      ...(action === "reaction" ? { reaction: String(reaction) } : {}),
      ...(action === "share" ? { destinationID: groupID ? `group:${groupID}` : `wall:${actingID}` } : {}) };
    const observed = action === "reaction" ? await ledger.inspect(key) : null;
    let refreshedPost;
    const outcome = await ledger.run(key, async () => {
      const skipped = (reason, coverage, existingID) => ({ skipped: true, reason, provenance: "server", coverage,
        ...(existingID ? { existingID } : {}) });
      if (action === "comment" || action === "reply") {
        let parentCoverage;
        if (action === "reply") {
          let parent;
          try {
            parent = await resolveParent(api, postID, parentCommentID, { parentFeedbackID, expansionToken }, maxScanPages);
          } catch (error) {
            if (error.code === "STATE_UNAVAILABLE") throw failure("PARENT_UNRESOLVED", error.message, error.coverage);
            throw error;
          }
          parentCoverage = parent.coverage;
          parentFeedbackID = parent.feedbackID;
          expansionToken = parent.expansionToken;
        }
        const scanned = await scan(cursor => action === "comment" ? api.getPostComments(postID, { limit: 100, cursor }) :
          api.getCommentReplies(parentFeedbackID, { limit: 100, cursor, expansionToken }),
        item => item.authorID === actingID && item.text === text && typeof item.id === "string" && !!item.id,
        maxScanPages, action === "reply" ? "depth-1-replies" : "comments");
        if (parentCoverage) scanned.coverage.parent = parentCoverage;
        if (scanned.match) return skipped(action === "reply" ? "already-replied" : "already-commented", scanned.coverage, scanned.match.id);
        const mutation = action === "reply" ? await api.createCommentPost(text, postID, parentCommentID) : await api.createCommentPost(text, postID);
        return { skipped: false, provenance: "mutation", coverage: scanned.coverage, mutation };
      }
      let post;
      if (actorID || storyID) post = refreshedPost || await readTargetPost(api, postID, { actorID, storyID });
      if (action === "reaction") {
        const coverage = reactionState(post, reaction);
        if (!coverage.known) throw failure("STATE_UNAVAILABLE", "Viewer reaction state is unavailable", coverage);
        if (coverage.matches) return skipped("already-reacted", coverage);
        return { skipped: false, provenance: "mutation", coverage, mutation: await api.setPostReaction(postID, reaction) };
      }
      const historical = await priorShare(api, actingID, postID, groupID, maxScanPages);
      const coverage = { ...historical.coverage, source: post?.viewerHasShared === true ? "server" : historical.coverage.source,
        viewerHasShared: typeof post?.viewerHasShared === "boolean" ? post.viewerHasShared : null,
        note: "Ledger deduplication is destination-specific; server share state may not enumerate destinations or all prior shares." };
      if (post?.viewerHasShared === true) return skipped("already-shared", coverage);
      if (historical.match) return skipped("already-shared", coverage, historical.match.postID || historical.match.id);
      return { skipped: false, provenance: "mutation", coverage,
        mutation: await api.sharePost(url.href, { text, groupID, baseState }) };
    }, action === "reaction" ? { expectedRevision: observed.status === "completed" ? observed.revision : undefined,
      refreshCompleted: async () => {
        refreshedPost = await readTargetPost(api, postID, { actorID, storyID });
        const state = reactionState(refreshedPost, reaction);
        if (!state.known) throw failure("STATE_UNAVAILABLE", "Viewer reaction state is unavailable", state);
        return state;
      } } : {});
    return { ...outcome, provenance: outcome.duplicate ? "ledger" : outcome.result.provenance };
  }).catch(error => {
    if (!error.coverage && error.cause?.coverage) error.coverage = error.cause.coverage;
    throw error;
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
};

module.exports.scan = scan;
module.exports.commentIdentity = commentIdentity;
module.exports.reactionState = reactionState;
module.exports.priorShare = priorShare;
module.exports.validateTarget = validateTarget;
module.exports.validateParent = validateParent;
module.exports.readTargetPost = readTargetPost;
module.exports.resolveParent = resolveParent;
