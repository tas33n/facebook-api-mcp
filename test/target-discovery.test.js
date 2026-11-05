"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ComposerVariables = require("../lib/facebook/ComposerVariables");
const groupFactory = require("../src/getGroupPosts");
const pageFactory = require("../src/getPagePosts");

const story = (postID, extra = {}) => ({ __typename: "Story", id: Buffer.from(`S:_I10:${postID}`).toString("base64"),
  post_id: postID, actors: [{ id: "10" }], created_time: 100, message: { text: "Root" }, ...extra });
const connection = (nodes = [], cursor = null) => ({ edges: nodes.map(node => ({ node })),
  page_info: { has_next_page: cursor !== null, end_cursor: cursor } });
function client(factory, initial) {
  const calls = [], state = { data: initial };
  const read = factory({ async post(url, jar, form) {
    calls.push({ form, variables: JSON.parse(form.variables) });
    return { statusCode: 200, body: { data: state.data } };
  } }, {}, { globalOptions: {} });
  return { read, calls, state };
}

test("group reader uses exact regular-discussion protocol with local date/author filters", async () => {
  const { read, calls } = client(groupFactory, { node: { __typename: "Group", id: "99",
    group_feed: connection([story("20"), story("21", { created_time: null })], "next") } });
  let callbackValue;
  const result = await read("99", { since: 100, until: 100, authorID: "10", limit: 1 }, (error, value) => {
    assert.ifError(error); callbackValue = value;
  });
  assert.equal(callbackValue, result);
  assert.equal(calls[0].form.doc_id, "39571813942465299");
  assert.equal(calls[0].form.fb_api_req_friendly_name, "GroupsCometFeedRegularStoriesPaginationQuery");
  assert.deepEqual(calls[0].variables, { ...ComposerVariables, id: "99", feedLocation: "GROUP", feedType: "DISCUSSION",
    feedbackSource: 0, filterTopicId: null, focusCommentID: null, privacySelectorRenderLocation: "COMET_STREAM",
    referringStoryRenderLocation: null, renderLocation: "group", scale: 1, sortingSetting: "CHRONOLOGICAL",
    stream_initial_count: 0, useDefaultActor: false, youthIntegrityHostID: null, count: 1, cursor: null });
  assert.deepEqual(result.items.map(item => [item.postID, item.groupID]), [["20", "99"]]);
  assert.equal(result.scannedCount, 2);
  assert.equal(result.dateFilter.excludedUnknownDateCount, 1);
  assert.equal(result.pageInfo.endCursor, "next");
  assert.match(result.coverage, /announcements excluded/);
  const next = await read("99", { cursor: "next", authorID: "11" });
  assert.equal(calls[1].variables.cursor, "next");
  assert.deepEqual(next.items, []);
  assert.equal(next.pageInfo.hasNextPage, true);
});

test("group reader distinguishes empty, malformed, wrong-target and excessive connections", async () => {
  const { read, state } = client(groupFactory, { node: { group_feed: connection() } });
  assert.deepEqual((await read("99")).items, []);
  for (const node of [null, {}, { __typename: "User", group_feed: connection() }, { id: "98", group_feed: connection() },
    { group_feed: { edges: [] } }, { group_feed: connection(Array.from({ length: 101 }, (_, i) => story(String(i)))) }]) {
    state.data = { node };
    await assert.rejects(read("99"), { code: "GROUP_POSTS_UNAVAILABLE" });
  }
});

test("Page reader validates Page typename and supported timeline before returning posts", async () => {
  const { read, calls, state } = client(pageFactory, { node: { __typename: "Page", id: "99",
    timeline_list_feed_units: connection([story("20")], "page-next") } });
  const result = await read("99", { until: 100, types: ["text"] });
  assert.equal(result.items.length, 1);
  assert.equal(calls[0].form.fb_api_req_friendly_name, "ProfileCometTimelineFeedRefetchQuery");
  assert.equal(calls[0].form.doc_id, "28819547154404280");
  assert.equal(calls[0].variables.id, "99");
  assert.equal(calls[0].variables.feedLocation, "TIMELINE");
  state.data = { node: { __typename: "Page", timeline_feed_units: connection() } };
  let callbackValue;
  const empty = await read("99", (error, value) => { assert.ifError(error); callbackValue = value; });
  assert.equal(callbackValue, empty);
  assert.deepEqual(empty.items, []);
  for (const node of [null, { timeline_feed_units: connection() }, { __typename: "User", timeline_feed_units: connection() },
    { __typename: "Page", id: "98", timeline_feed_units: connection() }, { __typename: "Page" }]) {
    state.data = { node };
    await assert.rejects(read("99"), { code: "PAGE_POSTS_UNSUPPORTED" });
  }
  state.data = { node: { __typename: "Page", timeline_feed_units: { edges: [] } } };
  await assert.rejects(read("99"), { code: "PAGE_POSTS_UNAVAILABLE" });
});

test("target readers reject invalid identities and bounded options before network and notify callbacks", async () => {
  for (const factory of [groupFactory, pageFactory]) {
    const { read, calls } = client(factory, {});
    for (const id of [99, "", "page", null, "https://www.facebook.com/99"]) {
      await assert.rejects(read(id), { code: "INVALID_ARGUMENT" });
    }
    for (const options of [null, [], { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: "" },
      { cursor: "x".repeat(4097) }, { since: "yesterday" }, { since: 2, until: 1 }, { authorID: 10 }]) {
      await assert.rejects(read("99", options), { code: "INVALID_ARGUMENT" });
    }
    let callbackError;
    await assert.rejects(read("", error => { callbackError = error; }), { code: "INVALID_ARGUMENT" });
    assert.equal(callbackError.code, "INVALID_ARGUMENT");
    assert.equal(calls.length, 0);
  }
  const { read, calls } = client(groupFactory, {});
  await assert.rejects(read("99", { groupID: "98" }), { code: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
});
