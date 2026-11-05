"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { OperationRegistry } = require("../lib/facebook/OperationRegistry");
const createClient = require("../lib/facebook/GraphQLClient");
test("incremental decoder appends contiguous streamed edges and rejects sparse or unsafe paths", () => {
  const { combineData } = createClient;
  const initial = () => ({ data: { node: { edges: [{ node: { id: "1" } }] } } });
  const merged = combineData([initial(), { path: ["node", "edges", 1], data: { node: { id: "2" } } },
    { path: ["node"], data: { page_info: { has_next_page: false } } }], { allowIncremental: true });
  assert.equal(merged.node.edges[1].node.id, "2");
  assert.equal(merged.node.page_info.has_next_page, false);
  assert.throws(() => combineData([initial(), { path: ["node", "edges", 3], data: {} }], { allowIncremental: true }), { code: "INVALID_RESPONSE" });
  assert.throws(() => combineData([initial(), { path: ["__proto__"], data: { polluted: true } }], { allowIncremental: true }), { code: "INVALID_RESPONSE" });
});
const { contentURL, contentFromHTML, analyze } = require("../lib/facebook/Content");
const { extractNotifications, listen } = require("../lib/facebook/Notifications");

test("operation discovery binds Relay params and rejects native transport", () => {
  const registry = new OperationRegistry();
  assert.throws(() => registry.register("NativeQuery", { docId: "910937906", transport: "native" }), { code: "TRANSPORT_MISMATCH" });
  assert.equal(registry.discover('"SomeQuery", "123456789"').length, 0);
  registry.discover('params:{id:"123456789",metadata:{},name:"SomeQuery",operationKind:"query"}');
  assert.equal(registry.resolve("SomeQuery").docId, "123456789");
  assert.equal(registry.resolve("SomeQuery").verified, false);
});

test("comment replies target parent feedback rather than creating a top-level comment", async () => {
  let variables;
  const method = require("../src/createCommentPost")({ post: async (url, jar, form) => {
    variables = JSON.parse(form.variables);
    return { statusCode: 200, body: JSON.stringify({ data: { comment_create: {
      feedback: {}, feedback_comment_edge: { node: { id: "reply", feedback: { url: "https://www.facebook.com/?reply_comment_id=3" } } },
    } } }) };
  } }, {}, { userID: "1", globalOptions: {} });
  await method("reply text", "100", Buffer.from("comment:100_200").toString("base64"));
  assert.equal(Buffer.from(variables.input.feedback_id, "base64").toString(), "feedback:200");
  assert.equal(Buffer.from(variables.input.reply_comment_parent_fbid, "base64").toString(), "comment:100_200");
});

test("GraphQL parses prefixed records and rejects malformed errors without replay", async () => {
  let calls = 0;
  let body = 'for (;;);{"data":{"a":1}}\n{"data":{"b":2}}';
  const client = createClient({ post: async () => { calls++; return { statusCode: 200, body }; } }, { globalOptions: { facebookOperations: { TestQuery: "123" } } });
  assert.deepEqual(await client.request("TestQuery", {}), { a: 1, b: 2 });
  body = '{"errors":{"message":"bad"},"data":{"a":1}}';
  await assert.rejects(client.request("TestQuery", {}, { mutation: true }), { code: "INVALID_RESPONSE", outcome: "unknown" });
  assert.equal(calls, 2);
  body = '{"data":{"a":1},"errors":[{"code":42}]}';
  await assert.rejects(client.request("TestQuery", {}), error => error.code === "GRAPHQL_ERROR" && error.partialData);
});

test("metadata reader validates origins, leaves unavailable counts null and rejects shells", () => {
  for (const url of ["https://facebook.com.evil.test/reel/1", "https://user@facebook.com/reel/1", "http://facebook.com/reel/1", "https://facebook.com/settings"]) assert.throws(() => contentURL(url));
  const url = contentURL("https://facebook.com/reel/123");
  const content = contentFromHTML('<meta property="og:title" content="Clip"><meta property="og:description" content="Hello #test"><meta property="og:video" content="https://video.example/test.mp4">', url);
  assert.equal(content.kind, "reel");
  assert.equal(content.counts.reactions, null);
  assert.deepEqual(analyze(content).analysis.hashtags, ["#test"]);
  assert.throws(() => contentFromHTML("<script>window.WebLite={}</script>", url), { code: "CONTENT_UNAVAILABLE" });
});

test("notification parser distinguishes empty connection from unsupported response", () => {
  assert.throws(() => extractNotifications([], 20), { code: "NOTIFICATIONS_UNAVAILABLE" });
  assert.deepEqual(extractNotifications([{ viewer: { notifications_page: { edges: [] } } }], 20).items, []);
  const result = extractNotifications([{ notifications_page: { edges: [{ node: { notif: { id: "1", body: { text: "Hi" } } } }, { node: { id: "1" } }] } }], 20);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].unread, null);
});

test("notification stop waits for active request and suppresses late events", async () => {
  let resolve;
  let called = false;
  const listener = listen(() => new Promise(r => { resolve = r; }), { emitExisting: true }, () => { called = true; });
  await Promise.resolve();
  const stop = listener.stopListeningAsync();
  resolve({ items: [{ id: "1" }] });
  await stop;
  assert.equal(called, false);
});

test("notification errors are delivered and unsupported sessions terminate", async () => {
  let calls = 0;
  const listener = listen(async () => { calls++; throw Object.assign(new Error("unsupported"), { code: "NOTIFICATIONS_UNAVAILABLE" }); });
  const error = await new Promise(resolve => listener.once("error", resolve));
  assert.equal(error.code, "NOTIFICATIONS_UNAVAILABLE");
  await listener.stopListeningAsync();
  assert.equal(calls, 1);
});
