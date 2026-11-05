"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { filterPosts, searchOptions, searchVariables, normalizeSearch } = require("../lib/facebook/PostDiscovery");
const searchFactory = require("../src/searchPosts");
const ComposerVariables = require("../lib/facebook/ComposerVariables");

const story = (postID, extra = {}) => ({ __typename: "Story", id: Buffer.from(`S:_I10:${postID}`).toString("base64"),
  post_id: postID, message: { text: "Hello #Test" }, actors: [{ id: "10" }], ...extra });
const page = (edges, hasNextPage = false, endCursor = null) => ({ serpResponse: { results: {
  edges, page_info: { has_next_page: hasNextPage, end_cursor: endCursor },
} } });
const options = extra => searchOptions({ query: "hello", ...extra });

test("search distinguishes missing, malformed and genuinely empty connections", () => {
  for (const data of [{}, { serpResponse: { results: null } }, { serpResponse: { results: { edges: [] } } }]) {
    assert.throws(() => normalizeSearch(data, options()), { code: "SEARCH_UNAVAILABLE" });
  }
  const empty = normalizeSearch(page([]), options());
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.pageInfo, { hasNextPage: false, endCursor: null });
  assert.equal(empty.filterScope, "returned-page-only");
  assert.throws(() => normalizeSearch(page([{ node: { __typename: "UnsupportedResult", id: "123" } }]), options()), { code: "SEARCH_UNAVAILABLE" });
  assert.throws(() => normalizeSearch(page([], true, null), options()), { code: "SEARCH_UNAVAILABLE" });
});

test("outer story extraction handles rendering wrappers, deduplicates and excludes shared originals", () => {
  const outer = story("20", { attached_story: story("21"),
    attachments: [{ target: story("22"), media: { __typename: "Video", id: "501" } },
      { media: { __typename: "Photo", id: "500" } }] });
  const result = normalizeSearch(page([
    { node: { rendering_strategy: { story: outer } } },
    { rendering_strategy: { story: structuredClone(outer) } },
    { node: { ...outer, post_id: undefined } },
    { node: story("23") },
  ]), options());
  assert.deepEqual(result.items.map(item => item.postID), ["20", "23"]);
  assert.equal(result.scannedCount, 2);
  assert.equal(result.items[0].kind, "share");
  assert.equal(result.items[0].sharedPostID, "21");
  const unidentifiable = { __typename: "Story", attached_story: story("24") };
  assert.throws(() => normalizeSearch(page([{ node: unidentifiable }]), options()), { code: "SEARCH_UNAVAILABLE" });
});

test("group IDs use actual group metadata and never the author or a shared original", () => {
  const result = normalizeSearch(page([
    { node: story("20", { target_group: { id: "99" } }) },
    { node: story("21", { comet_sections: { feedback: { story: { feedback: { associated_group: { id: "99" } } } } } }) },
    { node: story("22", { attached_story: story("23", { target_group: { id: "99" } }) }) },
    { node: story("24", { actors: [{ id: "99" }] }) },
  ]), options({ groupID: "99" }));
  assert.deepEqual(result.items.map(item => item.postID), ["20", "21"]);
  assert.equal(result.scannedCount, 4);
});

test("local filters keep genuine cursors even when every returned post is excluded", () => {
  const result = normalizeSearch(page([{ node: story("20") }], true, "opaque+/cursor=="), options({ authorID: "999" }));
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "opaque+/cursor==" });
  assert.equal(result.scannedCount, 1);
  const oversized = normalizeSearch(page([{ node: story("20") }, { node: story("21") }], true, "next"), options({ limit: 1 }));
  assert.equal(oversized.items.length, 2);
  assert.equal(oversized.requestedLimit, 1);
  assert.equal(oversized.sourceEdgeCount, 2);
  assert.equal(oversized.pageInfo.endCursor, "next");
  assert.throws(() => normalizeSearch(page(Array.from({ length: 101 }, (_, index) => ({ node: story(String(index)) }))), options()), { code: "SEARCH_UNAVAILABLE" });
});

test("pure filtering supports Unicode normalization, case, any/all keywords and mixed media", () => {
  const items = Object.freeze([
    Object.freeze({ id: "1", text: "CAFE\u0301 #বাংলা ПрИвЕт", kind: "text", authorID: "10", groupID: null }),
    Object.freeze({ id: "2", text: "hello", kind: "mixed", media: [{ type: "photo" }, { type: "video" }], authorID: "11", groupID: "99" }),
    Object.freeze({ id: "3", text: null, kind: "reel", media: [{ type: "reel" }], authorID: "10", groupID: "99" }),
  ]);
  assert.deepEqual(filterPosts(items, { keywords: ["café", "привет", "#বাংলা"], keywordMode: "all" }), [items[0]]);
  assert.deepEqual(filterPosts(items, { keywords: ["absent", "HELLO"] }), [items[1]]);
  assert.deepEqual(filterPosts(items, { keywords: ["absent", "HELLO"], keywordMode: "all" }), []);
  assert.deepEqual(filterPosts(items, { types: ["video"] }), [items[1]]);
  assert.deepEqual(filterPosts(items, { types: ["photo"] }), [items[1]]);
  assert.deepEqual(filterPosts(items, { types: ["reel"], authorID: "10", groupID: "99" }), [items[2]]);
  assert.deepEqual(filterPosts(items, { types: ["text"] }), [items[0]]);
  assert.deepEqual(filterPosts(items, { types: ["all"] }), items);
  assert.notEqual(filterPosts(items), items);
  assert.equal(require("../src/filterPosts")()(items)[0], items[0]);
});

test("date options normalize explicit ISO values and reject ambiguous or invalid timestamps", () => {
  assert.equal(options({ since: "2026-01-01" }).since, 1767225600);
  assert.equal(options({ until: "2026-01-01T01:00:00+01:00" }).until, 1767225600);
  assert.equal(options({ since: 0, until: 0 }).since, 0);
  for (const value of [NaN, Infinity, -1, 1767225600000, "1767225600", "01/01/2026", "2026-02-30", "2026-01-01T00:00:00", "2026-01-01T24:00:00Z", {}, true]) {
    assert.throws(() => options({ since: value }), { code: "INVALID_ARGUMENT" });
    assert.throws(() => options({ until: value }), { code: "INVALID_ARGUMENT" });
  }
  assert.throws(() => options({ since: 20, until: 10 }), { code: "INVALID_ARGUMENT" });
});

test("local date filters are inclusive, report unknown dates and preserve the source cursor", () => {
  const data = page([10, 20, 30, null].map((created_time, index) => ({ node: story(String(20 + index), { created_time }) })), true, "next-date-page");
  const result = normalizeSearch(data, options({ since: 10, until: 20 }));
  assert.deepEqual(result.items.map(item => item.createdTime), [10, 20]);
  assert.equal(result.scannedCount, 4);
  assert.equal(result.unknownDateCount, 1);
  assert.deepEqual(result.dateFilter, { since: 10, until: 20, unknownDatePolicy: "exclude", excludedUnknownDateCount: 1 });
  assert.equal(result.pageInfo.endCursor, "next-date-page");
  const empty = normalizeSearch(data, options({ since: 31 }));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pageInfo.hasNextPage, true);
  assert.equal(normalizeSearch(data, options()).dateFilter.excludedUnknownDateCount, 0);
  assert.equal(normalizeSearch(data, options()).items.length, 4);
});

test("share filters match attached media without treating shares as text or replacing roots", () => {
  const shared = story("21", { message: { text: "Original text" }, attachments: [
    { media: { __typename: "Photo", id: "p" } }, { media: { __typename: "Video", id: "v" } },
  ] });
  const data = page([{ node: story("20", { attached_story: shared }) }]);
  for (const type of ["share", "mixed", "photo", "video", "all"]) {
    assert.deepEqual(normalizeSearch(data, options({ types: [type] })).items.map(item => item.postID), ["20"]);
  }
  assert.deepEqual(normalizeSearch(data, options({ types: ["text"] })).items, []);
  assert.deepEqual(normalizeSearch(data, options({ keywords: ["original"] })).items, []);
  assert.deepEqual(normalizeSearch(data, options()).items[0].sharedMediaTypes, ["photo", "video"]);
});

test("search variables preserve observed web search shape with no backend scoped filters", () => {
  const parsed = options({ query: "cats", hashtag: "#বাংলা", authorID: "10", groupID: "99", types: ["photo"], keywords: ["cute"], sessionID: "session-1" });
  assert.deepEqual(searchVariables(parsed), { ...ComposerVariables, allow_streaming: false,
    args: { callsite: "COMET_GLOBAL_SEARCH", config: { exact_match: false, high_confidence_config: null,
      intercept_config: null, sts_disambiguation: null, watch_config: null }, context: { bsid: "session-1", tsid: null },
    experience: { client_defined_experiences: ["ADS_PARALLEL_FETCH"], encoded_server_defined_params: null, fbid: null, type: "POSTS_TAB" }, filters: [], text: "cats #বাংলা" },
    count: 5, cursor: null, feedbackSource: 23, fetch_filters: true, renderLocation: "search_results_page", scale: 1,
    stream_initial_count: 0, useDefaultActor: false, feedLocation: "SEARCH", privacySelectorRenderLocation: "COMET_STREAM" });
  assert.equal(searchOptions({ hashtag: "cats" }).query, "#cats");
  assert.match(searchOptions({ query: "cats" }).sessionID, /^[\da-f-]{36}$/);
});

test("invalid search/filter options fail before network requests", async () => {
  let calls = 0;
  const search = searchFactory({ post: async () => { calls++; } }, {}, {});
  for (const input of [null, {}, { keywords: ["cats"] }, { query: "" }, { hashtag: "#" }, { hashtag: "two tags" },
    { query: "cats", limit: 51 }, { query: "cats", limit: 0 }, { query: "cats", cursor: "" },
    { query: "cats", types: ["unknown"] }, { query: "cats", groupID: 99 }, { query: "cats", authorID: "page" },
    { query: "cats", keywordMode: "some" }, { query: "cats", keywords: [""] }, { query: "cats", sessionID: "" }]) {
    await assert.rejects(search(input), { code: "INVALID_ARGUMENT" });
  }
  assert.equal(calls, 0);
  assert.throws(() => filterPosts([null]), { code: "INVALID_ARGUMENT" });
});

test("search API uses registered initial/paginated operations, incremental decoding and callbacks", async () => {
  const calls = [];
  const defaults = { post: async (url, jar, form) => {
    calls.push({ url, form, variables: JSON.parse(form.variables) });
    const initial = { data: page([{ node: story("20") }], true, "server-cursor") };
    const patch = { path: ["serpResponse", "results", "edges", 0, "node"], data: { message: { text: "patched" } } };
    return { statusCode: 200, body: `${JSON.stringify(initial)}\n${JSON.stringify(patch)}` };
  } };
  const search = searchFactory(defaults, {}, { globalOptions: {} });
  let callbackValue;
  const first = await search({ query: "cats" }, (error, value) => { assert.ifError(error); callbackValue = value; });
  assert.equal(callbackValue, first);
  assert.equal(first.items[0].text, "patched");
  assert.equal(calls[0].form.fb_api_req_friendly_name, "SearchCometResultsInitialResultsQuery");
  assert.equal(calls[0].form.doc_id, "27907150285627308");
  const next = await search({ query: "cats", cursor: first.pageInfo.endCursor, sessionID: first.sessionID, types: ["reel"] });
  assert.equal(calls[1].form.fb_api_req_friendly_name, "SearchCometResultsPaginatedResultsQuery");
  assert.equal(calls[1].form.doc_id, "28493607813672479");
  assert.equal(calls[1].variables.cursor, "server-cursor");
  assert.equal(calls[1].variables.args.context.bsid, first.sessionID);
  assert.deepEqual(next.items, []);
  assert.equal(next.pageInfo.hasNextPage, true);
  let callbackError;
  await assert.rejects(search({}, error => { callbackError = error; }), { code: "INVALID_ARGUMENT" });
  assert.equal(callbackError.code, "INVALID_ARGUMENT");
});

test("search decoder bounds wrapper depth instead of silently returning an incomplete page", () => {
  let node = story("20");
  for (let i = 0; i < 30; i++) node = { wrapper: node };
  assert.throws(() => normalizeSearch(page([{ node }]), options()), { code: "SEARCH_UNAVAILABLE" });
});

test("feed API reads only the observed connection and preserves locally empty pagination", async () => {
  const calls = [];
  let data = { viewer: { news_feed: page([{ node: story("20") }], true, "feed-next").serpResponse.results } };
  const feed = require("../src/getFeedPosts")({ post: async (url, jar, form) => {
    calls.push({ form, variables: JSON.parse(form.variables) });
    return { statusCode: 200, body: { data } };
  } }, {}, { globalOptions: {} });
  const result = await feed({ types: ["video"], limit: 3 });
  assert.deepEqual(result.items, []);
  assert.equal(result.filterScope, "returned-page-only");
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "feed-next" });
  assert.equal(calls[0].form.doc_id, "29015379188155409");
  assert.equal(calls[0].form.fb_api_req_friendly_name, "CometNewsFeedPaginationQuery");
  assert.equal(calls[0].variables.feedLocation, "NEWSFEED");
  assert.equal(calls[0].variables.count, 3);
  assert.equal(calls[0].variables.RELAY_INCREMENTAL_DELIVERY, false);
  assert.deepEqual(calls[0].variables.orderby, ["TOP_STORIES"]);
  await feed({ cursor: result.pageInfo.endCursor });
  assert.equal(calls[1].variables.cursor, "feed-next");
  data = {};
  await assert.rejects(feed(), { code: "FEED_UNAVAILABLE" });
  data = { viewer: { news_feed: page([]).serpResponse.results } };
  let callbackValue;
  const empty = await feed((error, value) => { assert.ifError(error); callbackValue = value; });
  assert.equal(callbackValue, empty);
  assert.deepEqual(empty.items, []);
});

test("feed recommendation units are skipped with explicit partial coverage, not traversed as posts", () => {
  const { normalizeConnection } = require("../lib/facebook/PostDiscovery");
  const unit = { __typename: "ShowcaseFeedUnit", __isFeedUnit: "ShowcaseFeedUnit", showcase_item: [{ attachment: { story: story("99") } }] };
  const result = normalizeConnection(page([{ node: story("20") }, { node: unit }], true, "next").serpResponse.results, options());
  assert.deepEqual(result.items.map(item => item.postID), ["20"]);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.sourceEdgeCount, 2);
  assert.equal(result.partial, true);
  const onlyUnits = normalizeConnection(page([{ node: unit }], true, "next").serpResponse.results, options());
  assert.deepEqual(onlyUnits.items, []);
  assert.equal(onlyUnits.pageInfo.hasNextPage, true);
  assert.equal(onlyUnits.skippedCount, 1);
  assert.throws(() => normalizeConnection(page([{ node: null }]).serpResponse.results, options()), { code: "SEARCH_UNAVAILABLE" });
});

test("profile timeline API validates identity and uses observed variables without assuming Page support", async () => {
  const calls = [];
  let data = { node: { timeline_feed_units: page([{ node: story("20") }], true, "profile-next").serpResponse.results } };
  const profile = require("../src/getProfilePosts")({ post: async (url, jar, form) => {
    calls.push({ form, variables: JSON.parse(form.variables) });
    return { statusCode: 200, body: { data } };
  } }, {}, { globalOptions: {} });
  const result = await profile("10", { authorID: "10", keywords: ["hello"] });
  assert.equal(result.items.length, 1);
  assert.equal(calls[0].form.doc_id, "28819547154404280");
  assert.equal(calls[0].form.fb_api_req_friendly_name, "ProfileCometTimelineFeedRefetchQuery");
  assert.deepEqual(calls[0].variables, { ...ComposerVariables, id: "10", count: 5, cursor: null, feedLocation: "TIMELINE",
    feedbackSource: 0, omitPinnedPost: true, privacySelectorRenderLocation: "COMET_STREAM", renderLocation: "timeline",
    run_with_continuation_key: true, scale: 1, trackingCode: null });
  await profile("10", { cursor: result.pageInfo.endCursor });
  assert.equal(calls[1].variables.cursor, "profile-next");
  await assert.rejects(profile(10), { code: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 2);
  data = { node: null };
  await assert.rejects(profile("10"), { code: "PROFILE_POSTS_UNAVAILABLE" });
  data = { node: { timeline_list_feed_units: page([]).serpResponse.results } };
  let callbackValue;
  const empty = await profile("10", (error, value) => { assert.ifError(error); callbackValue = value; });
  assert.equal(callbackValue, empty);
  assert.deepEqual(empty.items, []);
});
