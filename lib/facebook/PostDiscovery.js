"use strict";

const { randomUUID } = require("node:crypto");
const ComposerVariables = require("./ComposerVariables");
const PostReader = require("./PostReader");
const { operationError } = require("./OperationRegistry");

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = message => operationError("INVALID_ARGUMENT", message);
const unavailable = message => operationError("SEARCH_UNAVAILABLE", message);
const text = value => typeof value === "string" && value.length ? value : null;
const fold = value => value.normalize("NFC").toLowerCase();
const TYPES = new Set(["all", "text", "photo", "video", "reel", "mixed", "share"]);

function filterOptions(options = {}) {
  if (!object(options)) throw invalid("options must be an object");
  const types = options.types ?? ["all"];
  if (!Array.isArray(types) || types.some(type => !TYPES.has(type))) throw invalid("types must contain all, text, photo, video, reel, mixed, or share");
  const keywords = options.keywords ?? [];
  if (!Array.isArray(keywords) || keywords.length > 100 || keywords.some(word => typeof word !== "string" || !word.trim() || word.length > 4096)) {
    throw invalid("keywords must be an array of up to 100 nonempty bounded strings");
  }
  const keywordMode = options.keywordMode ?? "any";
  if (!["any", "all"].includes(keywordMode)) throw invalid("keywordMode must be any or all");
  for (const key of ["authorID", "groupID"]) {
    if (options[key] != null && (typeof options[key] !== "string" || !/^\d+$/.test(options[key]))) throw invalid(`${key} must be a decimal-string ID`);
  }
  const dates = {};
  for (const key of ["since", "until"]) {
    dates[key] = options[key] == null ? null : PostReader.timestamp(options[key]);
    if (options[key] != null && dates[key] === null) throw invalid(`${key} must be nonnegative Unix seconds or an ISO date/date-time with explicit timezone`);
  }
  if (dates.since !== null && dates.until !== null && dates.since > dates.until) throw invalid("since must not be after until");
  return { types, keywords: keywords.map(word => fold(word.trim())), keywordMode, ...dates,
    authorID: options.authorID ?? null, groupID: options.groupID ?? null };
}

// Pure filtering of normalized posts; identifiers always refer to the root post.
function filterPosts(items, options = {}) {
  if (!Array.isArray(items) || items.some(item => !object(item))) throw invalid("items must be an array of normalized posts");
  const filters = filterOptions(options);
  return items.filter(item => {
    if (filters.authorID !== null && item.authorID !== filters.authorID) return false;
    if (filters.groupID !== null && item.groupID !== filters.groupID) return false;
    if (filters.since !== null || filters.until !== null) {
      const created = PostReader.timestamp(item.createdTime);
      if (created === null || (filters.since !== null && created < filters.since) || (filters.until !== null && created > filters.until)) return false;
    }
    if (filters.types.length && !filters.types.includes("all")) {
      const mediaTypes = [...(Array.isArray(item.media) ? item.media.map(media => media?.type) : []),
        ...(Array.isArray(item.sharedMediaTypes) ? item.sharedMediaTypes : [])];
      const kinds = new Set([item.kind, ...mediaTypes]);
      if (new Set(mediaTypes).size > 1) kinds.add("mixed");
      if (!filters.types.some(type => kinds.has(type))) return false;
    }
    if (!filters.keywords.length) return true;
    const content = fold(typeof item.text === "string" ? item.text : "");
    return filters.keywordMode === "all" ? filters.keywords.every(word => content.includes(word)) : filters.keywords.some(word => content.includes(word));
  });
}

function pageOptions(options = {}) {
  const filters = filterOptions(options);
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid("limit must be 1..50");
  if (options.cursor != null && (typeof options.cursor !== "string" || !options.cursor.trim() || options.cursor.length > 4096)) throw invalid("cursor must be a nonempty bounded string");
  return { ...filters, limit, cursor: options.cursor ?? null };
}

function searchOptions(options = {}) {
  const parsed = pageOptions(options);
  const bounded = (value, label) => {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) throw invalid(`${label} must be a nonempty bounded string`);
    return value.trim();
  };
  const query = options.query == null ? "" : bounded(options.query, "query");
  const hashtag = options.hashtag == null ? "" : bounded(options.hashtag, "hashtag").replace(/^#/, "");
  if (options.hashtag != null && (!hashtag || /[\s#]/u.test(hashtag))) throw invalid("hashtag must be a single tag, with an optional leading #");
  if (!query && !hashtag) throw invalid("query or hashtag is required");
  const sessionID = options.sessionID == null ? randomUUID() : (bounded(options.sessionID, "sessionID"), options.sessionID);
  return { ...parsed, query: [query, hashtag && `#${hashtag}`].filter(Boolean).join(" "), sessionID };
}

function searchVariables(options) {
  return { ...ComposerVariables, allow_streaming: false,
    args: { callsite: "COMET_GLOBAL_SEARCH",
      config: { exact_match: false, high_confidence_config: null, intercept_config: null, sts_disambiguation: null, watch_config: null },
      context: { bsid: options.sessionID, tsid: null },
      experience: { client_defined_experiences: ["ADS_PARALLEL_FETCH"], encoded_server_defined_params: null, fbid: null, type: "POSTS_TAB" },
      filters: [], text: options.query },
    count: options.limit, cursor: options.cursor, feedbackSource: 23, fetch_filters: true,
    renderLocation: "search_results_page", scale: 1, stream_initial_count: 0, useDefaultActor: false,
    feedLocation: "SEARCH", privacySelectorRenderLocation: "COMET_STREAM" };
}

function outerStories(edges, fail = unavailable) {
  const stories = [], seen = new Set();
  let visited = 0, skippedCount = 0;
  function visit(node, depth) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    if (++visited > 10000 || depth > 24) throw fail("Post result traversal exceeded its bounded decoder");
    seen.add(node);
    if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return; }
    // Feed recommendation units contain attachment stories, but are not posts.
    if (node.__typename !== "Story" && (node.__isFeedUnit || /FeedUnit$/.test(node.__typename || ""))) return;
    const isStory = node.__typename === "Story" || (!node.__typename && object(node.comet_sections));
    if (isStory) {
      if (!text(node.id) && !text(node.post_id)) throw fail("Returned story has no usable identity");
      stories.push(node);
      // A story is a boundary even when it has no usable identity. Never turn a
      // shared original, recommendation or comment inside it into a result.
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (["attachments", "attachment", "feedback", "comments", "recommendations", "shared_story", "attached_story", "showcase_item"].includes(key)) continue;
      visit(child, depth + 1);
    }
  }
  for (const edge of edges) {
    if (!object(edge) || (!object(edge.node) && !object(edge.rendering_strategy))) throw fail("Post connection contains a malformed edge");
    const before = stories.length;
    // Count duplicate edges as extracted rather than skipped non-post entries.
    seen.clear();
    visit(edge?.node, 0);
    visit(edge?.rendering_strategy, 0);
    if (stories.length === before) skippedCount++;
  }
  return { stories, skippedCount };
}

function groupID(root, fail = unavailable) {
  const seen = new Set();
  let visited = 0;
  function visit(node, depth) {
    if (!object(node) || seen.has(node)) return null;
    if (++visited > 1000 || depth > 24) throw fail("Post story sections exceeded their bounded decoder");
    if (node !== root && node.__typename === "Story" && node.id && node.id !== root.id) return null;
    seen.add(node);
    const id = text(node.target_group?.id) ?? text(node.feedback?.associated_group?.id);
    if (id) return id;
    for (const section of Object.values(node.comet_sections || {})) {
      const found = visit(section, depth + 1) ?? visit(section?.story, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return visit(root, 0);
}

function normalizeConnection(connection, options, source = "search", errorCode = "SEARCH_UNAVAILABLE", context = {}) {
  const filters = filterOptions(options);
  const fail = message => operationError(errorCode, message);
  if (!object(connection) || !Array.isArray(connection.edges)) throw fail(`Response contains no supported ${source} connection`);
  const info = connection.page_info;
  if (!object(info) || typeof info.has_next_page !== "boolean" ||
      !(info.end_cursor === null || typeof info.end_cursor === "string") || (info.has_next_page && !info.end_cursor)) {
    throw fail(`${source} connection has no usable pagination metadata`);
  }
  // Returning a cursor beyond silently omitted stories would lose results.
  if (connection.edges.length > 100) throw fail(`${source} connection exceeded the maximum source page size of 100`);
  const { stories: roots, skippedCount } = outerStories(connection.edges, fail);
  if (roots.length > 100) throw fail(`${source} connection exceeded the maximum story page size of 100`);
  if (connection.edges.length && !roots.length && !connection.edges.every(edge =>
    edge.node?.__isFeedUnit || /FeedUnit$/.test(edge.node?.__typename || ""))) {
    throw fail(`${source} results contain no supported identifiable outer stories`);
  }
  const seen = new Set(), items = [];
  for (const root of roots) {
    const identity = { storyID: text(root.id), postID: text(root.post_id) };
    const item = typeof PostReader.normalizeStory === "function" ? PostReader.normalizeStory(root, identity) : PostReader.normalizePost({ node: root }, identity);
    const keys = [item.postID && `post:${item.postID}`, item.storyID && `story:${item.storyID}`, item.id && `story:${item.id}`].filter(Boolean);
    if (!keys.length) throw fail(`${source} story has no usable identity`);
    if (keys.some(key => seen.has(key))) { keys.forEach(key => seen.add(key)); continue; }
    keys.forEach(key => seen.add(key));
    items.push({ ...item, groupID: text(item.groupID) ?? groupID(root, fail) ?? context.groupID ?? null });
  }
  const unknownDateCount = items.filter(item => item.createdTime === null).length;
  const dateFilter = { since: filters.since, until: filters.until, unknownDatePolicy: "exclude",
    excludedUnknownDateCount: filters.since !== null || filters.until !== null ? unknownDateCount : 0 };
  return { items: filterPosts(items, options), pageInfo: { hasNextPage: info.has_next_page, endCursor: info.end_cursor },
    filterScope: "returned-page-only", scannedCount: items.length, requestedLimit: options.limit,
    unknownDateCount, dateFilter,
    sourceEdgeCount: connection.edges.length, skippedCount, partial: skippedCount > 0,
    coverage: `One returned ${source} page (maximum 100 source edges/stories); requested count is not an exact server limit; ${skippedCount} non-post/unsupported edges skipped; local author/group/type/keyword/date filters; inclusive Unix-second date bounds exclude ${dateFilter.excludedUnknownDateCount} unknown dates; server ranking and visibility apply; not all results` };
}

function normalizeSearch(data, options) {
  return { ...normalizeConnection(data?.serpResponse?.results, options), sessionID: options.sessionID };
}

function feedVariables(options) {
  return { ...ComposerVariables, RELAY_INCREMENTAL_DELIVERY: false, connectionClass: "EXCELLENT",
    count: options.limit, cursor: options.cursor, feedLocation: "NEWSFEED", feedStyle: "DEFAULT", feedbackSource: 1,
    orderby: ["TOP_STORIES"], privacySelectorRenderLocation: "COMET_STREAM", recentVPVs: [], refreshMode: "COLD_START",
    renderLocation: "homepage_stream", scale: 1, shouldChangeBRSLabelFieldName: false,
    shouldObfuscateCategoryField: true, shouldUseBRSLabelFieldNameV1: false, shouldUseBRSLabelFieldNameV2: false,
    useDefaultActor: false, __relay_internal__pv__CometAdsSlotFillLoggingEnabledrelayprovider: false };
}

function profileVariables(profileID, options) {
  if (typeof profileID !== "string" || !/^\d+$/.test(profileID)) throw invalid("profileID must be a decimal-string ID");
  return { ...ComposerVariables, id: profileID, count: options.limit, cursor: options.cursor,
    feedLocation: "TIMELINE", feedbackSource: 0, omitPinnedPost: true, privacySelectorRenderLocation: "COMET_STREAM",
    renderLocation: "timeline", run_with_continuation_key: true, scale: 1, trackingCode: null };
}

function groupVariables(groupID, options) {
  if (typeof groupID !== "string" || !/^\d+$/.test(groupID)) throw invalid("groupID must be a decimal-string ID");
  if (options.groupID !== null && options.groupID !== undefined && options.groupID !== groupID) throw invalid("groupID filter must match the requested group");
  return { ...ComposerVariables, id: groupID, feedLocation: "GROUP", feedType: "DISCUSSION", feedbackSource: 0,
    filterTopicId: null, focusCommentID: null, privacySelectorRenderLocation: "COMET_STREAM",
    referringStoryRenderLocation: null, renderLocation: "group", scale: 1, sortingSetting: "CHRONOLOGICAL",
    stream_initial_count: 0, useDefaultActor: false, youthIntegrityHostID: null, count: options.limit, cursor: options.cursor };
}

module.exports = { filterPosts, searchOptions, searchVariables, normalizeSearch, pageOptions, normalizeConnection, feedVariables, profileVariables, groupVariables };
