"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRegistry, createMcpServer } = require("../lib/mcp");
const createEngagePost = require("../src/engagePost");

const plain = value => JSON.parse(JSON.stringify(value));
const page = items => ({ items, pageInfo: { hasNextPage: false, endCursor: null } });

test("curated read adapters preserve identity, options, full pages and genuine continuation values", async () => {
  const calls = [];
  const items = Array.from({ length: 7 }, (_, i) => ({ postID: String(i + 1), text: "post" }));
  const returned = { ...page(items), pageInfo: { hasNextPage: true, endCursor: "opaque-next" },
    sessionID: "search-context", scannedCount: 7, requestedLimit: 2, filterScope: "returned-page-only" };
  const api = Object.fromEntries(["getPost", "getPostComments", "getCommentReplies", "searchPosts", "getFeedPosts", "getProfilePosts"].map(method => [method,
    (...args) => { const callback = args.pop(); calls.push([method, ...args]); callback(null, returned); }
  ]));
  const registry = createRegistry(api);
  const inputs = [
    ["facebook_get_post", { target: "100", actorID: "200" }, ["getPost", "100", { actorID: "200" }]],
    ["facebook_get_post", { target: { postID: "100", actorID: "200" } }, ["getPost", { postID: "100", actorID: "200" }, {}]],
    ["facebook_get_post", { target: { storyID: "UzpfSTIwMDoxMDA=" } }, ["getPost", { storyID: "UzpfSTIwMDoxMDA=" }, {}]],
    ["facebook_get_post_comments", { postID: "100", cursor: "next" }, ["getPostComments", "100", { limit: 20, cursor: "next" }]],
    ["facebook_get_comment_replies", { feedbackID: "feedback-parent", limit: 2, cursor: "next", expansionToken: "expansion", clientKey: "client" },
      ["getCommentReplies", "feedback-parent", { limit: 2, cursor: "next", expansionToken: "expansion", clientKey: "client" }]],
    ["facebook_search_posts", { query: "cats", hashtag: "#pets", limit: 2, sessionID: "search-context", cursor: "next", types: ["video", "reel"], keywords: ["rescue"], keywordMode: "all", authorID: "200", groupID: "300" }, null],
    ["facebook_get_feed_posts", { limit: 2, types: ["text"], authorID: "200" }, ["getFeedPosts", { limit: 2, types: ["text"], authorID: "200" }]],
    ["facebook_get_profile_posts", { profileID: "200", limit: 2, keywords: ["cat"], cursor: "next" }, ["getProfilePosts", "200", { limit: 2, keywords: ["cat"], cursor: "next" }]]
  ];
  for (const [name, input, expected] of inputs) {
    const result = await registry.call(name, input);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.items.length, 7, "MCP must not truncate a provider page behind its cursor");
    assert.deepEqual(calls.pop(), expected || ["searchPosts", input]);
    if (name === "facebook_search_posts") assert.equal(result.structuredContent.data.sessionID, "search-context");
  }
  for (const tool of registry.tools) assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(createRegistry({ filterPosts() {}, httpPost() {}, actionLedger() {} }).tools.length, 0);
});

test("search contexts and reply expansion tokens survive only in scoped read outputs", async () => {
  const registry = createRegistry({
    searchPosts: async () => ({ ...page([]), sessionID: "search-context", cookie: "private-cookie", access_token: "private-token", nested: { sessionID: "login-session" } }),
    getPostComments: async () => page([{ id: "1", expansionToken: "provider-expansion", access_token: "private-token" }, { id: "2", expansionToken: "known-credential" }]),
    getCommentReplies: async () => page([{ id: "3", expansionToken: "next-expansion" }]),
    engagePost: async () => ({ sessionID: "login-session", expansionToken: "private-token" })
  }, { secretValues: ["known-credential"] });
  const search = (await registry.call("facebook_search_posts", { query: "cat" })).structuredContent.data;
  assert.equal(search.sessionID, "search-context");
  assert.equal(search.nested.sessionID, "[REDACTED]");
  const comments = (await registry.call("facebook_get_post_comments", { postID: "100" })).structuredContent.data;
  assert.equal(comments.items[0].expansionToken, "provider-expansion");
  assert.equal(comments.items[1].expansionToken, "[REDACTED]");
  const replies = (await registry.call("facebook_get_comment_replies", { feedbackID: "parent" })).structuredContent.data;
  assert.equal(replies.items[0].expansionToken, "next-expansion");
  const mutation = (await registry.call("facebook_engage_post", { action: "comment", postID: "100", text: "hi" })).structuredContent.data;
  assert.equal(mutation.sessionID, "[REDACTED]");
  assert.equal(mutation.expansionToken, "[REDACTED]");
  assert.ok(!JSON.stringify([search, comments, replies, mutation]).includes("private-"));
});

test("read schemas reject unbounded pages, invalid filters, identities and arbitrary options before invocation", async () => {
  let calls = 0;
  const stub = async () => { calls++; return page([]); };
  const registry = createRegistry({ getPost: stub, getPostComments: stub, getCommentReplies: stub, searchPosts: stub, getFeedPosts: stub, getProfilePosts: stub });
  for (const [name, input] of [
    ["facebook_get_post", { target: "100" }],
    ["facebook_get_post", { target: { postID: "100", raw: {} }, actorID: "200" }],
    ["facebook_get_post_comments", { postID: 100 }],
    ["facebook_get_post_comments", { postID: "100", limit: 101 }],
    ["facebook_get_comment_replies", { feedbackID: "parent", expansionToken: "x".repeat(16385) }],
    ["facebook_search_posts", {}], ["facebook_search_posts", { query: " " }],
    ["facebook_search_posts", { hashtag: "#" }], ["facebook_search_posts", { hashtag: "two tags" }],
    ["facebook_search_posts", { query: "cats", limit: 51 }],
    ["facebook_search_posts", { query: "cats", sessionID: " " }],
    ["facebook_get_feed_posts", { limit: 0 }], ["facebook_get_feed_posts", { types: ["arbitrary"] }],
    ["facebook_get_feed_posts", { keywords: [" "] }], ["facebook_get_feed_posts", { keywordMode: "regex" }],
    ["facebook_get_profile_posts", { profileID: "abc" }],
    ["facebook_get_profile_posts", { profileID: "200", raw: { doc_id: "1" } }]
  ]) assert.equal((await registry.call(name, input)).structuredContent.error.code, "INVALID_INPUT", JSON.stringify(input));
  assert.equal(calls, 0);
});

test("engagement adapters expose only explicit bounded action inputs and preserve compatibility tools", async () => {
  const calls = [];
  const registry = createRegistry({
    engagePost: async input => { calls.push(input); return { duplicate: false, provenance: "mutation" }; },
    createCommentPost(text, postID, callback, replyID) { calls.push([text, postID, replyID]); callback(null, { id: "created" }); },
    publishVideoPost: async () => ({ accepted: true }),
    sharePost() { assert.fail("raw share must not be exposed"); }
  });
  for (const input of [
    { action: "comment", postID: "100", text: "Exact  text\n", maxScanPages: 2 },
    { action: "reply", postID: "100", text: "reply", parentCommentID: "201", parentFeedbackID: "parent-feedback", expansionToken: "expansion" },
    { action: "reaction", postID: "100", actorID: "200", reaction: "like" },
    { action: "share", postID: "100", storyID: "story", text: "", url: "https://www.facebook.com/100", baseState: 3, groupID: "300" }
  ]) {
    assert.equal((await registry.call("facebook_engage_post", input)).structuredContent.ok, true);
    assert.deepEqual(calls.pop(), input);
  }
  assert.equal((await registry.call("facebook_create_comment", { postID: "100", text: "reply", replyCommentID: "201" })).structuredContent.ok, true);
  assert.deepEqual(calls.pop(), ["reply", "100", "201"]);
  assert.ok(registry.tools.some(tool => tool.name === "facebook_publish_video_post"));
  assert.ok(!registry.tools.some(tool => tool.method === "sharePost"));
  assert.equal(createRegistry({}).tools.length, 0);
  assert.equal(registry.tools.find(tool => tool.name === "facebook_engage_post").annotations.idempotentHint, true);
});

test("engagement rejects paths, raw overrides, invalid action requirements and scan limits", async () => {
  let calls = 0;
  const registry = createRegistry({ engagePost: async () => { calls++; } });
  const valid = { action: "comment", postID: "100", text: "hello" };
  for (const input of [
    { ...valid, actionLedgerPath: "C:\\bypass.json" }, { ...valid, ledger: {} }, { ...valid, force: true },
    { ...valid, raw: {} }, { ...valid, skipDuplicateCheck: true }, { ...valid, action: "delete" },
    { ...valid, text: " " }, { ...valid, postID: 100 }, { ...valid, maxScanPages: 11 }, { ...valid, maxScanPages: 0 },
    { ...valid, action: "reply" }, { ...valid, action: "reaction", reaction: "like" },
    { ...valid, action: "reaction", actorID: "200", reaction: "invalid" },
    { ...valid, action: "share" }, { ...valid, action: "share", url: "https://example.test/100" },
    { ...valid, action: "share", url: "https://www.facebook.com/100", baseState: 4 }
  ]) assert.equal((await registry.call("facebook_engage_post", input)).structuredContent.error.code, "INVALID_INPUT");
  assert.equal(calls, 0);
});

test("MCP engagement uses the configured durable ledger and never retries uncertain actions", async t => {
  const root = process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "Temp", "opencode") : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(root, "mcp-engagement-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "actions.json");
  let mutations = 0;
  const api = { getPostComments: async () => page([]), createCommentPost: async () => { mutations++; return { id: "created" }; } };
  const makeRegistry = globalOptions => createRegistry({ engagePost: createEngagePost({}, api, { userID: "200", globalOptions }) });
  const input = { action: "comment", postID: "100", text: "hi" };
  const missing = await makeRegistry({}).call("facebook_engage_post", input);
  assert.equal(missing.isError, true);
  assert.equal(mutations, 0);
  const first = (await makeRegistry({ actionLedgerPath: ledgerPath }).call("facebook_engage_post", input)).structuredContent;
  assert.equal(first.ok, true);
  assert.equal(first.data.duplicate, false);
  const duplicate = (await makeRegistry({ actionLedgerPath: ledgerPath }).call("facebook_engage_post", input)).structuredContent.data;
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.provenance, "ledger");
  assert.equal(mutations, 1);
  api.createCommentPost = async () => { mutations++; throw new Error("unknown remote result; cookie=secret"); };
  const uncertainInput = { ...input, text: "second" };
  const failure = await makeRegistry({ actionLedgerPath: ledgerPath }).call("facebook_engage_post", uncertainInput);
  assert.equal(failure.structuredContent.error.outcomeUnknown, true);
  assert.ok(!JSON.stringify(failure).includes("secret"));
  const replay = (await makeRegistry({ actionLedgerPath: ledgerPath }).call("facebook_engage_post", uncertainInput)).structuredContent.data;
  assert.equal(replay.status, "unknown");
  assert.equal(replay.duplicate, true);
  assert.equal(mutations, 2);
});

test("SDK discovers explicit engagement/search fields and enforces refined requirements", async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const host = createMcpServer({ api: { engagePost: async () => ({ duplicate: false }), searchPosts: async () => page([]) } });
  const client = new Client({ name: "engagement-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await host.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    const engage = tools.find(tool => tool.name === "facebook_engage_post");
    assert.deepEqual(engage.inputSchema.properties.action.enum, ["comment", "reply", "reaction", "share"]);
    assert.equal(engage.inputSchema.properties.actionLedgerPath, undefined);
    assert.equal(engage.inputSchema.additionalProperties, false);
    assert.equal(tools.find(tool => tool.name === "facebook_search_posts").inputSchema.properties.limit.maximum, 50);
    const invalid = await client.callTool({ name: "facebook_engage_post", arguments: { action: "reply", postID: "100", text: "hi" } });
    assert.equal(invalid.structuredContent.error.code, "INVALID_INPUT");
    const valid = await client.callTool({ name: "facebook_engage_post", arguments: { action: "comment", postID: "100", text: "hi" } });
    assert.deepEqual(plain(valid.structuredContent.data), { duplicate: false });
    const search = await client.callTool({ name: "facebook_search_posts", arguments: {} });
    assert.equal(search.structuredContent.error.code, "INVALID_INPUT");
  } finally { await client.close(); await host.close(); }
});
