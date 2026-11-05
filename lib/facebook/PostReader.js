"use strict";

const ComposerVariables = require("./ComposerVariables");
const { operationError } = require("./OperationRegistry");
const COMMENT_PROVIDERS = Object.freeze(Object.fromEntries([
  "CometUFICommentActionLinksRewriteEnabled", "CometUFICommentAutoTranslationType",
  "CometUFICommentAvatarStickerAnimatedImage", "IsWorkUser",
].map(name => {
  const key = `__relay_internal__pv__${name}relayprovider`;
  return [key, ComposerVariables[key]];
})));
const string = value => typeof value === "string" ? value : null;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = message => operationError("INVALID_ARGUMENT", message);

// Numeric values are always Unix seconds, never guessed as milliseconds. ISO
// strings require an explicit timezone (or a date-only UTC calendar date).
function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 253402300799 ? value : null;
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days ||
      (hour != null && (+hour > 23 || +minute > 59 || +second > 59)) ||
      (zone && zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return null;
  const seconds = Date.parse(value) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 253402300799 ? seconds : null;
}

function optionsObject(value) {
  if (!object(value)) throw invalid("options must be an object");
  return value;
}
function decimal(value, label) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw invalid(`${label} must be a decimal-string ID`);
  return value;
}
function opaque(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw invalid(`${label} must be a nonempty bounded string`);
  return value;
}
function decodeStoryID(value) {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const match = /^S:_I(\d+):(\d+)(?::\2)?$/.exec(decoded);
  return match && Buffer.from(decoded).toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
    ? { actorID: match[1], postID: match[2] } : null;
}
function storyIdentity(input, options = {}) {
  optionsObject(options);
  const target = object(input) ? input : { [typeof input === "string" && /^\d+$/.test(input) ? "postID" : "storyID"]: input };
  if (target.storyID != null) {
    const storyID = opaque(target.storyID, "storyID");
    const decoded = decodeStoryID(storyID);
    if (!decoded) throw invalid("storyID must be a base64-encoded S:_I<actorID>:<postID> identity; pfbid decoding is unsupported");
    for (const key of ["postID", "actorID"]) for (const supplied of [target[key], options[key]]) {
      if (supplied != null && supplied !== decoded[key]) throw invalid(`Conflicting ${key} and storyID`);
    }
    return { storyID, ...decoded };
  }
  const postID = decimal(target.postID, "postID");
  if (target.actorID != null && options.actorID != null && target.actorID !== options.actorID) throw invalid("Conflicting actorID values");
  const actorID = decimal(target.actorID ?? options.actorID, "actorID (required for numeric postID)");
  return { storyID: Buffer.from(`S:_I${actorID}:${postID}`).toString("base64"), actorID, postID };
}
function feedbackIdentity(input) {
  if (object(input) && input.feedbackID != null) return opaque(input.feedbackID, "feedbackID");
  return Buffer.from(`feedback:${decimal(object(input) ? input.postID : input, "postID")}`).toString("base64");
}
function replyIdentity(input) {
  return opaque(object(input) ? input.commentFeedbackID : input, "commentFeedbackID");
}
function pagination(options = {}) {
  optionsObject(options);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("limit must be 1..100");
  if (options.cursor != null && (typeof options.cursor !== "string" || options.cursor.length > 4096)) throw invalid("cursor must be a bounded string");
  return { limit, cursor: options.cursor || null };
}
function storyVariables(identity) {
  return { ...ComposerVariables, id: identity.storyID, feedLocation: "TIMELINE", feedbackSource: 0,
    focusCommentID: null, scale: 1, privacySelectorRenderLocation: "COMET_STREAM",
    referringStoryRenderLocation: null, renderLocation: "timeline", useDefaultActor: false };
}
function commentsVariables(id, { limit, cursor }) {
  return { id, commentsAfterCount: limit, commentsAfterCursor: cursor, commentsBeforeCount: null,
    commentsBeforeCursor: null, commentsIntentToken: null, feedLocation: "PERMALINK", focusCommentID: null,
    scale: 1, targetDialect: null, useDefaultActor: false, ...COMMENT_PROVIDERS };
}
function repliesVariables(id, { limit, cursor }, options = {}) {
  return { id, clientKey: options.clientKey || null, expansionToken: options.expansionToken || null, feedLocation: "PERMALINK", focusCommentID: null,
    repliesAfterCount: limit, repliesAfterCursor: cursor, repliesBeforeCount: null,
    repliesBeforeCursor: null, scale: 1, useDefaultActor: false, ...COMMENT_PROVIDERS };
}

// Traverse only explicit sections of the selected story. Other stories inside
// attachments (shared originals), recommendations and comments are boundaries.
function sameStoryID(left, right) {
  if (left === right) return true;
  const a = decodeStoryID(left), b = decodeStoryID(right);
  return Boolean(a && b && a.actorID === b.actorID && a.postID === b.postID);
}
function sectionStories(root) {
  const result = [], seen = new Set();
  function visit(node) {
    if (!object(node) || seen.has(node)) return;
    if (node !== root && node.id && !sameStoryID(node.id, root.id)) return;
    seen.add(node);
    result.push(node);
    visit(node.story_ufi_container?.story);
    for (const [name, section] of Object.entries(node.comet_sections || {})) {
      if (["attached_story", "aggregated_stories", "recommendations"].includes(name)) continue;
      if (!object(section)) continue;
      result.push(section);
      if (object(section.story)) visit(section.story);
      if (object(section.comet_sections)) visit(section);
    }
  }
  visit(root);
  return result;
}
function findStory(data, identity) {
  const candidates = [data?.node, data?.story, data?.node?.story];
  const story = candidates.find(node => object(node) &&
    (node.__typename === "Story" || object(node.comet_sections)) &&
    (!node.id || sameStoryID(node.id, identity.storyID) || node.post_id === identity.postID));
  if (!story) throw operationError("POST_UNAVAILABLE", "Response contains no matching root story");
  return story;
}
function booleanField(nodes, keys) {
  for (const node of nodes) for (const key of keys) if (typeof node?.[key] === "boolean") return node[key];
  return null;
}
function reactionState(feedbacks) {
  for (const feedback of feedbacks) {
    const key = ["viewer_feedback_reaction_info", "viewer_reaction"].find(name => own(feedback, name));
    if (!key) continue;
    const reaction = feedback[key];
    if (reaction === null) return { viewerReaction: null, viewerReactionKnown: true };
    if (object(reaction)) {
      const id = reaction.id ?? reaction.reaction_type ?? reaction.key;
      const name = string(reaction.name) ?? string(reaction.localized_name);
      if (typeof id === "string" || typeof id === "number" || name !== null) {
        return { viewerReaction: { id: id == null ? null : String(id), name }, viewerReactionKnown: true };
      }
    }
  }
  return { viewerReaction: null, viewerReactionKnown: false };
}
function storyFeedbacks(sections) {
  const result = [], seen = new Set();
  function visit(node) {
    if (!object(node) || seen.has(node)) return;
    seen.add(node);
    result.push(node);
    for (const key of ["feedback", "feedback_context", "feedback_target_with_context", "comet_ufi_summary_and_actions_renderer"]) visit(node[key]);
    if (Array.isArray(node.adaptive_ufi_action_renderers)) {
      for (const renderer of node.adaptive_ufi_action_renderers) visit(renderer?.feedback);
    }
  }
  for (const section of sections) {
    visit(section.feedback);
    visit(section.feedback_context);
  }
  return result;
}
function reelURL(url) {
  if (typeof url !== "string") return false;
  try { return /^\/(?:reel|reels)\//.test(new URL(url, "https://www.facebook.com").pathname); }
  catch (_) { return false; }
}
function mediaFromSections(nodes, storyURL) {
  const items = [], seenNodes = new Set(), seenIDs = new Set();
  function visit(node) {
    if (!object(node) || seenNodes.has(node) || node.__typename === "Story") return;
    if (node.target?.__typename === "Story" || node.story?.__typename === "Story") return;
    seenNodes.add(node);
    if (["Photo", "Video"].includes(node.__typename)) {
      const id = string(node.id);
      const key = id && `${node.__typename}:${id}`;
      if (key && seenIDs.has(key)) return;
      if (key) seenIDs.add(key);
      const url = string(node.url) ?? string(node.permalink_url);
      const type = node.__typename === "Photo" ? "photo" :
        node.is_fb_short === true || reelURL(url) || reelURL(storyURL) ? "reel" : "video";
      items.push({ id, type, url, previewURL: string(node.image?.uri) ?? string(node.preferred_thumbnail?.image?.uri),
        playableURL: string(node.playable_url_quality_hd) ?? string(node.playable_url) ?? string(node.browser_native_hd_url) ?? string(node.browser_native_sd_url) });
      return;
    }
    // Explicit attachment edges avoid unrelated video recommendations and
    // nested shared-story attachments, which do not describe the root post.
    for (const key of ["attachments", "all_subattachments", "subattachments", "nodes", "edges", "node", "media", "style_type_renderer", "attachment", "styles"]) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  for (const node of nodes) {
    const attachments = node.attachments;
    if (Array.isArray(attachments)) attachments.forEach(visit);
    else visit(attachments);
    visit(node.attachment);
  }
  return items;
}
function normalizePost(data, identity) {
  const root = findStory(data, identity);
  return normalizeStory(root, identity);
}
function attachedStory(sections) {
  for (const section of sections) {
    // Only this explicit relation proves a share. Attachment targets and
    // recommendation stories are intentionally not searched.
    const attached = section.attached_story ?? section.comet_sections?.attached_story;
    if (!object(attached)) continue;
    const candidate = object(attached.story) ? attached.story : attached;
    if (candidate.__typename === "Story" || candidate.id || candidate.post_id || object(candidate.comet_sections)) return candidate;
  }
  return null;
}
function normalizeStory(root, identity = {}) {
  const sections = sectionStories(root);
  const text = sections.map(node => string(node.message?.text) ?? string(node.message)).find(value => value !== null) ?? null;
  const url = sections.map(node => string(node.url) ?? string(node.permalink_url)).find(value => value !== null) ?? null;
  const feedbacks = storyFeedbacks(sections);
  const media = mediaFromSections(sections, url);
  const types = new Set(media.map(item => item.type));
  const shared = attachedStory(sections);
  const sharedSections = shared ? sectionStories(shared) : [];
  const sharedURL = sharedSections.map(node => string(node.url) ?? string(node.permalink_url)).find(value => value !== null) ?? null;
  const sharedMediaTypes = [...new Set(mediaFromSections(sharedSections, sharedURL).map(item => item.type))];
  const createdTime = sections.flatMap(node => [timestamp(node.creation_time), timestamp(node.created_time)])
    .find(value => value !== null) ?? null;
  const audienceValues = new Set();
  const seenAudience = new Set();
  function readAudience(node, depth = 0) {
    if (!node || typeof node !== "object" || seenAudience.has(node) || depth > 24) return;
    seenAudience.add(node);
    if (Array.isArray(node)) { for (const item of node) readAudience(item, depth + 1); return; }
    if (node !== root && (node.__typename === "Story" || node.comet_sections || node.post_id) && node.id) {
      const decoded = decodeStoryID(node.id);
      if (node.id !== root.id && (!decoded || decoded.postID !== (root.post_id || identity.postID))) return;
    }
    const state = node.privacy_row_input?.base_state;
    if (["EVERYONE", "FRIENDS", "SELF"].includes(state)) audienceValues.add(state === "EVERYONE" ? "PUBLIC" : state);
    for (const [key, value] of Object.entries(node)) {
      if (["attached_story", "shared_story", "attachments", "attachment", "comments", "recommendations"].includes(key)) continue;
      if (value && typeof value === "object") readAudience(value, depth + 1);
    }
  }
  for (const section of sections) readAudience(section);
  return { id: string(root.id) ?? identity.storyID ?? null, storyID: string(root.id) ?? identity.storyID ?? null,
    postID: string(root.post_id) ?? identity.postID ?? null, url, text, createdTime,
    audience: audienceValues.size === 1 ? [...audienceValues][0] : null,
    sharedPostID: string(shared?.post_id) ?? decodeStoryID(shared?.id)?.postID ?? null,
    sharedStoryID: string(shared?.id), sharedURL, sharedMediaTypes,
    authorID: sections.map(node => string(node.actors?.[0]?.id) ?? string(node.author?.id)).find(value => value !== null) ?? null,
    feedbackID: feedbacks.map(node => string(node.id)).find(value => value !== null) ?? null,
    kind: shared ? "share" : types.size > 1 ? "mixed" : types.size === 1 ? [...types][0] : text !== null && text.length > 0 ? "text" : "unknown",
    media, ...reactionState(feedbacks),
    viewerHasCommented: booleanField([...feedbacks, ...sections], ["viewer_has_commented"]),
    viewerHasShared: booleanField([...feedbacks, ...sections], ["viewer_has_shared"]),
    coverage: "bounded root-story fields; explicit attached_story identity/URL/media types reported separately; recommendations excluded; unavailable timestamps and viewer state are null" };
}

function pageInfo(connection) {
  const info = connection.page_info;
  if (!object(info) || typeof info.has_next_page !== "boolean" ||
      !(info.end_cursor === null || typeof info.end_cursor === "string") ||
      (info.has_next_page && !info.end_cursor)) {
    throw operationError("COMMENTS_UNAVAILABLE", "Comment connection has no usable pagination metadata");
  }
  return { hasNextPage: info.has_next_page, endCursor: info.end_cursor };
}
function normalizeComment(node) {
  if (!object(node) || typeof node.id !== "string" || !node.id) throw operationError("COMMENTS_UNAVAILABLE", "Comment connection contains a malformed comment");
  const replies = node.replies_connection;
  const replyCount = [node.feedback?.replies_fields?.count, node.feedback?.replies_fields?.total_count,
    replies?.count].find(value => Number.isSafeInteger(value) && value >= 0) ?? null;
  return { id: node.id, text: string(node.body?.text), authorID: string(node.author?.id),
    feedbackID: string(node.feedback?.id), url: string(node.url),
    expansionToken: string(node.feedback?.expansion_info?.expansion_token),
    replyCount,
    repliesPageInfo: object(replies?.page_info) ? pageInfo(replies) : null };
}
function normalizeComments(data, limit, replies = false) {
  const connection = replies ? data?.node?.replies_connection : data?.node?.comment_rendering_instance_for_feed_location?.comments;
  if (!object(connection) || !Array.isArray(connection.edges)) throw operationError("COMMENTS_UNAVAILABLE", `Response contains no supported ${replies ? "replies" : "comments"} connection`);
  // Never truncate a server page while returning a cursor past omitted items.
  if (connection.edges.length > limit) throw operationError("COMMENTS_UNAVAILABLE", "Comment connection exceeded the requested page limit");
  return { items: connection.edges.map(edge => normalizeComment(edge?.node)), pageInfo: pageInfo(connection),
    coverage: `bounded ${replies ? "depth-1 reply" : "comment"} connection page; server ordering and visibility apply; not all comments` };
}
function withCallback(promise, callback) {
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
}

module.exports = { storyIdentity, feedbackIdentity, replyIdentity, pagination, storyVariables, commentsVariables,
  repliesVariables, normalizePost, normalizeStory, normalizeComments, withCallback, timestamp };
