"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistry, createMcpServer } = require("../lib/mcp");

const target = { postID: "100", actorID: "200" };
const key = "a".repeat(64);
const methods = ["getGroupPosts", "getPagePosts", "deletePost", "editPost", "deleteCommentPost", "editCommentPost", "setPostAudience", "getVideoStatus", "verifyPublication", "reconcileAction"];
const envelope = async (registry, name, input) => (await registry.call(name, input)).structuredContent;

test("management adapters position callbacks after explicit options and preserve verified results", async () => {
  const calls = [];
  const api = Object.fromEntries(methods.map(method => [method, (...args) => {
    const callback = args.pop();
    assert.equal(typeof callback, "function");
    calls.push([method, ...args]);
    callback(null, { verified: false, marker: method });
  }]));
  const registry = createRegistry(api);
  for (const [name, input, expected] of [
    ["facebook_delete_post", { target }, ["deletePost", target, {}]],
    ["facebook_edit_post", { target, text: "" }, ["editPost", target, "", {}]],
    ["facebook_delete_comment", { commentID: "300", postID: "100", parentFeedbackID: "parent", expansionToken: "expansion" },
      ["deleteCommentPost", "300", { postID: "100", parentFeedbackID: "parent", expansionToken: "expansion" }]],
    ["facebook_set_post_audience", { target, audience: "SELF" }, ["setPostAudience", target, "SELF", {}]],
    ["facebook_edit_comment", { commentID: "300", text: "Exact  text", postID: "100", parentFeedbackID: "parent", expansionToken: "expansion" },
      ["editCommentPost", "300", "Exact  text", { postID: "100", parentFeedbackID: "parent", expansionToken: "expansion" }]],
    ["facebook_get_video_status", { videoID: "400" }, ["getVideoStatus", "400", {}]],
    ["facebook_verify_publication", { target, maxAttempts: 2, expectedText: "Exact  text" },
      ["verifyPublication", target, { maxAttempts: 2, expectedText: "Exact  text", timeoutMs: 25000 }]],
    ["facebook_inspect_action", { key }, ["reconcileAction", key, { inspectOnly: true }]],
    ["facebook_reconcile_action", { key, actorID: "200", maxScanPages: 2 }, ["reconcileAction", key, { actorID: "200", maxScanPages: 2 }]]
  ]) {
    const result = await envelope(registry, name, input);
    assert.equal(result.ok, true, name);
    assert.equal(result.data.verified, false);
    assert.deepEqual(calls.pop(), expected);
  }
  for (const name of ["facebook_delete_post", "facebook_edit_post", "facebook_delete_comment", "facebook_edit_comment", "facebook_set_post_audience"]) {
    const tool = registry.tools.find(tool => tool.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
  }
  assert.equal(registry.tools.find(tool => tool.name === "facebook_inspect_action").annotations.readOnlyHint, true);
  assert.equal(registry.tools.find(tool => tool.name === "facebook_reconcile_action").annotations.readOnlyHint, false, "reconciliation persists local state");
  assert.equal(createRegistry({ scanPosts() {}, rawGraphQL() {} }).tools.length, 0);
});

test("group and Page discovery forwards inclusive dates and mixed/share filters without truncating", async () => {
  const calls = [];
  const returned = { items: Array.from({ length: 7 }, (_, i) => ({ postID: String(i) })), pageInfo: { hasNextPage: true, endCursor: "opaque" } };
  const registry = createRegistry(Object.fromEntries(["getGroupPosts", "getPagePosts"].map(method => [method, async (...args) => {
    calls.push([method, ...args.slice(0, -1)]);
    return returned;
  }])));
  const options = { limit: 2, cursor: "previous", since: "2026-01-01", until: 1798761599, types: ["mixed", "share"] };
  for (const [name, method, identity] of [["facebook_get_group_posts", "getGroupPosts", "groupID"], ["facebook_get_page_posts", "getPagePosts", "pageID"]]) {
    const result = await envelope(registry, name, { [identity]: "300", ...options });
    assert.equal(result.ok, true);
    assert.equal(result.data.items.length, 7);
    assert.equal(result.data.pageInfo.endCursor, "opaque");
    assert.deepEqual(calls.pop(), [method, "300", options]);
  }
});

test("verified publishing maps audience and staged content, preserves uncertainty and rejects file inputs", async () => {
  const calls = [];
  const result = { url: "https://www.facebook.com/200/posts/100/", verification: { verified: false, status: "unavailable", reason: "Not resolved" } };
  const registry = createRegistry({ publishPostVerified(content, options, callback) {
    calls.push([content, options]);
    callback(null, result);
  } });
  assert.equal(createRegistry({ createPost() {} }).tools.some(tool => tool.name === "facebook_publish_post_verified"), false);
  const tool = registry.tools.find(tool => tool.name === "facebook_publish_post_verified");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, false);
  assert.deepEqual(JSON.parse(JSON.stringify((await envelope(registry, tool.name, { text: "Exact  text" })).data)), result);
  assert.deepEqual(calls.pop(), [{ body: "Exact  text", baseState: 1 }, { timeoutMs: 25000, expectedAudience: "PUBLIC" }]);
  assert.deepEqual(JSON.parse(JSON.stringify((await envelope(registry, tool.name, { videoID: "400", audience: "SELF", maxAttempts: 2, intervalMs: 500, timeoutMs: 5000, expectedMediaType: "video" })).data)), result);
  assert.deepEqual(calls.pop(), [{ body: "", baseState: 3, videoID: "400" },
    { maxAttempts: 2, intervalMs: 500, timeoutMs: 5000, expectedMediaType: "video", expectedAudience: "SELF" }]);
  for (const input of [{}, { text: " " }, { videoID: 400 }, { text: "hi", audience: "EVERYONE" },
    { text: "hi", attachment: "C:\\photo.jpg" }, { text: "hi", photoID: "300" },
    { text: "hi", maxAttempts: 21 }, { text: "hi", timeoutMs: 30001 }, { text: "hi", intervalMs: 0 },
    { text: "hi", expectedAudience: "SELF" }, { text: "hi", options: { force: true } }]) {
    assert.equal((await envelope(registry, tool.name, input)).error.code, "INVALID_INPUT");
  }
  assert.equal(calls.length, 0);
});

test("management schemas reject ambiguous identities, arbitrary paths and unbounded checks before invocation", async () => {
  let calls = 0;
  const registry = createRegistry(Object.fromEntries([...methods, "getFeedPosts", "searchPosts"].map(method => [method, async () => { calls++; return {}; }])));
  for (const [name, input] of [
    ["facebook_delete_post", { target: "100" }],
    ["facebook_delete_post", { target: { postID: "100" } }],
    ["facebook_delete_post", { target: { ...target, storyID: "story" } }],
    ["facebook_delete_post", { target, force: true }],
    ["facebook_edit_post", { target, text: "x".repeat(20001) }],
    ["facebook_delete_comment", { commentID: "300" }],
    ["facebook_edit_comment", { commentID: "300", text: "hi" }],
    ["facebook_edit_comment", { commentID: "300", postID: "100", text: " " }],
    ["facebook_edit_comment", { commentID: "300", postID: "100", text: "hi", path: "C:\\anything" }],
    ["facebook_set_post_audience", { target, audience: "EVERYONE" }],
    ["facebook_get_video_status", { videoID: 400 }],
    ["facebook_verify_publication", { target: { videoID: "400", ...target } }],
    ["facebook_verify_publication", { target, maxAttempts: 21 }],
    ["facebook_verify_publication", { target, timeoutMs: 30001 }],
    ["facebook_verify_publication", { target, intervalMs: 0 }],
    ["facebook_inspect_action", { key, actionLedgerPath: "C:\\other.json" }],
    ["facebook_reconcile_action", { key, path: "C:\\other.json" }],
    ["facebook_reconcile_action", { key, inspectOnly: true }],
    ["facebook_reconcile_action", { key, force: true }],
    ["facebook_reconcile_action", { key, maxScanPages: 11 }],
    ["facebook_inspect_action", { key: "../actions.json" }],
    ["facebook_get_group_posts", { limit: 2 }],
    ["facebook_get_page_posts", { pageID: "300", checkpointPath: "C:\\scan.json" }],
    ["facebook_get_feed_posts", { since: "2026-02-30" }],
    ["facebook_get_feed_posts", { until: "2026-01-01T01:00:00" }],
    ["facebook_get_feed_posts", { since: 200, until: 100 }],
    ["facebook_search_posts", { query: "cats", since: "2026-02-01", until: "2026-01-01" }]
  ]) assert.equal((await envelope(registry, name, input)).error.code, "INVALID_INPUT", name + JSON.stringify(input));
  assert.equal(calls, 0);
});

test("SDK Zod 4 discovery preserves all refined fields and strict runtime validation", async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const host = createMcpServer({ api: Object.fromEntries([...methods, "engagePost", "getPost", "searchPosts", "createStory", "publishPostVerified"].map(method => [method, async () => ({ verified: false })])) });
  const client = new Client({ name: "management-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await host.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    for (const [name, field] of [["facebook_engage_post", "action"], ["facebook_get_post", "target"], ["facebook_search_posts", "query"], ["facebook_create_story", "privacy"], ["facebook_delete_comment", "commentID"]]) {
      const schema = tools.find(tool => tool.name === name).inputSchema;
      assert.ok(schema.properties[field]);
      assert.equal(schema.additionalProperties, false);
    }
    const filters = tools.find(tool => tool.name === "facebook_get_group_posts").inputSchema;
    assert.ok(filters.required.includes("groupID"));
    assert.ok(filters.properties.types.items.enum.includes("share"));
    assert.ok(filters.properties.since);
    assert.equal(tools.find(tool => tool.name === "facebook_inspect_action").inputSchema.properties.path, undefined);
    const publishing = tools.find(tool => tool.name === "facebook_publish_post_verified").inputSchema;
    assert.equal(publishing.properties.audience.default, "PUBLIC");
    assert.equal(publishing.properties.maxAttempts.maximum, 20);
    assert.equal(publishing.additionalProperties, false);
    for (const [name, input] of [["facebook_engage_post", { action: "reply", postID: "100", text: "hi" }],
      ["facebook_get_post", { target: "100" }], ["facebook_search_posts", {}],
      ["facebook_create_story", { privacy: "current", photoID: "1", videoID: "2" }],
      ["facebook_publish_post_verified", {}],
      ["facebook_delete_comment", { commentID: "300" }]]) {
      const result = await client.callTool({ name, arguments: input });
      assert.equal(result.structuredContent.error.code, "INVALID_INPUT");
    }
  } finally { await client.close(); await host.close(); }
});

test("configured-ledger inspection and reconciliation never replay an uncertain mutation", async t => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const { ActionLedger } = require("../lib/facebook/ActionLedger");
  const createReconcile = require("../src/reconcileAction");
  const root = process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "Temp", "opencode") : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(root, "mcp-management-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const actionLedgerPath = path.join(directory, "actions.json");
  const ledger = new ActionLedger({ path: actionLedgerPath, accountID: "200" });
  const action = { type: "comment", target: "100", text: "exact text" };
  let mutations = 0;
  await assert.rejects(ledger.run(action, async () => { mutations++; throw new Error("uncertain"); }));
  const actionKey = ledger.key(action);
  let items = [];
  const api = { getPostComments: async () => ({ items, pageInfo: { hasNextPage: false, endCursor: null } }) };
  const registry = createRegistry({ reconcileAction: createReconcile({}, api, { userID: "200", globalOptions: { actionLedgerPath } }) });
  assert.equal((await envelope(registry, "facebook_inspect_action", { key: actionKey })).data.status, "unknown");
  const negative = (await envelope(registry, "facebook_reconcile_action", { key: actionKey })).data;
  assert.equal(negative.reconciled, false);
  assert.equal(negative.status, "unknown");
  items = [{ id: "300", authorID: "200", text: "exact text" }];
  const positive = (await envelope(registry, "facebook_reconcile_action", { key: actionKey })).data;
  assert.equal(positive.reconciled, true);
  assert.equal(positive.status, "completed");
  assert.equal(mutations, 1);
  assert.equal((await ledger.inspect(actionKey)).status, "completed");
});
