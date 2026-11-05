"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistry, createEventBuffer, createMcpServer } = require("../lib/mcp");

test("social MCP adapters preserve actual argument order and map explicit audiences", async () => {
  const observed = [];
  const api = {
    createPost(content, cb) { observed.push(content); cb(null, "https://www.facebook.com/123/posts/456"); },
    createCommentPost(text, postID, cb, replyID) { observed.push([text, postID, replyID]); cb(null, { id: "comment" }); },
    setPostReaction(postID, reaction, cb) { observed.push([postID, reaction]); cb(null, {}); },
    setCommentReaction(commentID, reaction, cb) { observed.push([commentID, reaction]); cb(null, {}); },
    setStoryReaction(storyID, reaction, cb) { observed.push([storyID, reaction]); cb(null, {}); }
  };
  const registry = createRegistry(api);
  for (const [audience, baseState] of [["PUBLIC", 1], ["FRIENDS", 2], ["SELF", 3]]) {
    const result = await registry.call("facebook_create_post", { text: "hello", audience, groupID: "321" });
    assert.equal(result.structuredContent.data, "https://www.facebook.com/123/posts/456");
    assert.deepEqual(observed.pop(), { body: "hello", baseState, groupID: "321" });
  }
  await registry.call("facebook_create_comment", { text: "comment", postID: "123_456", replyCommentID: "789" });
  assert.deepEqual(observed.pop(), ["comment", "123_456", "789"]);
  for (const [tool, args, expected] of [
    ["facebook_set_post_reaction", { postID: "123", reaction: "heart" }, ["123", "heart"]],
    ["facebook_set_comment_reaction", { commentID: "123_456", reaction: "unlike" }, ["123_456", "unlike"]],
    ["facebook_set_story_reaction", { storyID: "c3Rvcnk6MTIz", reaction: "❤️" }, ["c3Rvcnk6MTIz", "❤️"]]
  ]) {
    assert.equal((await registry.call(tool, args)).structuredContent.ok, true);
    assert.deepEqual(observed.pop(), expected);
  }
  for (const tool of registry.tools) {
    assert.match(tool.description, /historical web operation IDs.*not live-verified/);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
  assert.equal(registry.tools.find(tool => tool.method === "setStoryReaction").annotations.idempotentHint, false);
  for (const [name, args] of [
    ["facebook_create_post", { text: "hello" }],
    ["facebook_create_post", { text: " ", audience: "PUBLIC" }],
    ["facebook_create_comment", { postID: "123", text: "hello", attachment: "/tmp/file" }],
    ["facebook_set_post_reaction", { postID: "123", reaction: "arbitrary" }],
    ["facebook_set_story_reaction", { storyID: "123", reaction: "unlike" }]
  ]) assert.equal((await registry.call(name, args)).structuredContent.error.code, "INVALID_INPUT");
  assert.equal(observed.length, 0);
});

test("feature read tools normalize allowed Facebook URLs and make one bounded snapshot call", async () => {
  const calls = [];
  const registry = createRegistry({
    getFacebookCapabilities() { return { notifications: true }; },
    getNotifications: async function (options) {
      assert.equal(arguments.length, 1);
      calls.push(options);
      return { items: [{ id: "1" }, { id: "2" }, { id: "3" }], pageInfo: { hasMore: true, endCursor: "opaque-cursor==" } };
    },
    getContent(url, cb) { calls.push(url); cb(null, { url }); },
    analyzeContent(url, cb) { calls.push(url); cb(null, { counts: { images: 1 } }); },
    listenNotifications() { throw new Error("must not start polling"); }
  });
  assert.equal((await registry.call("facebook_get_capabilities", {})).structuredContent.data.notifications, true);
  const notifications = (await registry.call("facebook_get_notifications", { limit: 2 })).structuredContent.data;
  assert.equal(notifications.items.length, 2);
  assert.equal(notifications.pageInfo.hasMore, true);
  assert.deepEqual(calls.pop(), { limit: 2 });
  await registry.call("facebook_get_notifications", { limit: 2, cursor: notifications.pageInfo.endCursor });
  assert.deepEqual(calls.pop(), { limit: 2, cursor: "opaque-cursor==" });
  for (const cursor of [42, "", "x".repeat(4097)]) {
    assert.equal((await registry.call("facebook_get_notifications", { cursor })).structuredContent.error.code, "INVALID_INPUT");
  }
  for (const tool of ["facebook_get_content", "facebook_analyze_content"]) {
    assert.equal((await registry.call(tool, { url: "https://facebook.com/posts/123?x=1" })).structuredContent.ok, true);
    assert.equal(calls.pop(), "https://www.facebook.com/posts/123?x=1");
    for (const url of ["https://evil.test/", "https://www.facebook.com.evil.test/", "https://user:pass@facebook.com/", "https://facebook.com:444/", "http://facebook.com/", "https://m.facebook.com/"]) {
      assert.equal((await registry.call(tool, { url })).structuredContent.error.code, "INVALID_INPUT");
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(createRegistry({}).tools.length, 0);
  assert.ok(!registry.tools.some(tool => tool.method === "listenNotifications"));
});

test("event buffer has independent cursors, overflow accounting and sanitized error records", () => {
  const events = createEventBuffer({ capacity: 2, secretValues: ["secret-cookie"] });
  assert.equal(events.publish({ type: "message", body: "secret-cookie", token: "private" }), 1);
  const first = events.read();
  assert.equal(first.nextCursor, 1);
  assert.ok(!JSON.stringify(first).includes("secret-cookie"));
  assert.ok(!JSON.stringify(first).includes("private"));
  first.items[0].event.body = "tampered";
  assert.equal(events.read().items[0].event.body, "[REDACTED]");
  assert.equal(events.publishError(new Error("cookie=private")), 2);
  assert.equal(events.publish({ type: "message", body: "new" }), 3);
  const lagged = events.read({ after: 0, limit: 1 });
  assert.equal(lagged.overflow, true);
  assert.equal(lagged.missed, 1);
  assert.equal(lagged.droppedTotal, 1);
  assert.equal(lagged.nextCursor, 2);
  assert.equal(lagged.hasMore, true);
  assert.equal(lagged.items[0].event.error.code, "LISTENER_ERROR");
  assert.ok(!JSON.stringify(lagged).includes("private"));
  const next = events.read({ after: lagged.nextCursor });
  assert.equal(next.overflow, false);
  assert.equal(next.nextCursor, 3);
  assert.equal(next.hasMore, false);
  assert.equal(events.status().errorCount, 1);
  assert.throws(() => events.read({ after: 4 }), { code: "INVALID_INPUT" });
  events.close();
  assert.throws(() => events.publish({}), { code: "SERVER_CLOSED" });
});

test("event byte limits reject oversized entries visibly and bound read batches", () => {
  const events = createEventBuffer({ capacity: 500 });
  events.publish({ body: "x".repeat(40000) });
  assert.equal(events.read().items[0].event.error.code, "EVENT_REJECTED");
  for (let i = 0; i < 100; i++) events.publish({ body: "x".repeat(30000) });
  assert.ok(events.status().bytes <= events.status().maxBytes);
  assert.ok(events.status().droppedTotal > 0);
  const page = events.read({ limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 262144);
  assert.equal(page.hasMore, true);
  assert.equal(page.overflow, true);
});

test("event tools are opt-in through the injected buffer and never start listeners", async () => {
  const events = createEventBuffer();
  const api = { listenMqtt() { throw new Error("should not start"); } };
  assert.equal(createRegistry(api).tools.length, 0);
  const host = createMcpServer({ api, eventBuffer: events });
  events.publishError(new Error("provider secrets"));
  const result = await host.registry.call("facebook_get_events", { after: 0, limit: 1 });
  assert.equal(result.structuredContent.data.items[0].event.error.code, "LISTENER_ERROR");
  assert.equal(host.registry.status().events.errorCount, 1);
  assert.equal(host.registry.tools[0].annotations.readOnlyHint, true);
  await host.close();
  // Ownership stays with the host that injected the buffer.
  assert.equal(events.status().state, "open");
  events.close();
});

test("SDK discovers social and event schemas and returns structured feature results", async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const events = createEventBuffer();
  events.publish({ type: "message", body: "hello" });
  const host = createMcpServer({ eventBuffer: events, api: {
    createPost(content, cb) { cb(null, "https://www.facebook.com/posts/123"); },
    getContent(url, cb) { cb(null, { url }); }
  } });
  const client = new Client({ name: "social-event-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await host.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.find(tool => tool.name === "facebook_create_post").inputSchema.properties.audience.enum, ["PUBLIC", "FRIENDS", "SELF"]);
    assert.equal(tools.find(tool => tool.name === "facebook_get_events").annotations.openWorldHint, false);
    const content = await client.callTool({ name: "facebook_get_content", arguments: { url: "https://facebook.com/posts/123" } });
    assert.equal(content.structuredContent.data.url, "https://www.facebook.com/posts/123");
    const page = await client.callTool({ name: "facebook_get_events", arguments: { after: 0 } });
    assert.equal(page.structuredContent.data.nextCursor, 1);
    const invalid = await client.callTool({ name: "facebook_create_post", arguments: { text: "hello", audience: "EVERYONE" } });
    assert.equal(invalid.structuredContent.error.code, "INVALID_INPUT");
  } finally {
    await client.close();
    await host.close();
    events.close();
  }
});
