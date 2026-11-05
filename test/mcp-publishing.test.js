"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistry, createMcpServer } = require("../lib/mcp");
const { errorResult } = require("../lib/mcp/safety");

test("publishing adapters preserve staged media options and accepted Story result", async () => {
  const calls = [];
  const accepted = { storyID: "123", status: "accepted", published: null, verification: "Check publication separately" };
  const registry = createRegistry({
    createStory(options, callback) { calls.push(options); callback(null, accepted); },
    publishVideo(options, callback) { calls.push(options); callback(null, { videoID: options.videoID, published: true }); },
    publishReel(options, callback) { calls.push(options); callback(null, { videoID: options.videoID, published: !options.draft, draft: !!options.draft }); },
    uploadPhoto() { throw new Error("must not expose upload"); },
    uploadVideo() { throw new Error("must not expose upload"); }
  });
  assert.equal(registry.tools.length, 3);
  for (const options of [
    { photoID: "123", privacy: "current" }, { videoID: "234", privacy: "current" },
    { text: "hello", textPresetID: "345", fontID: "456", privacy: "current" }
  ]) {
    const result = await registry.call("facebook_create_story", options);
    assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent.data)), accepted);
    assert.deepEqual(calls.pop(), options);
  }
  const video = { videoID: "123", title: "Title", description: "Description", targetID: "456" };
  await registry.call("facebook_publish_video", video);
  assert.deepEqual(calls.pop(), video);
  const reel = { videoID: "123", caption: "Caption", placements: ["DEPLOYMENT_PLACEMENT"], draft: true, enableRemix: false, embeddable: true };
  const result = await registry.call("facebook_publish_reel", reel);
  assert.deepEqual(calls.pop(), reel);
  assert.equal(result.structuredContent.data.published, false);
  for (const tool of registry.tools) {
    assert.match(tool.description, /Experimental.*not live-verified/);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
  }
  assert.equal(createRegistry({ uploadPhoto() {}, uploadVideo() {} }).tools.length, 0);
});

test("publishing inputs reject conflicting Story types, missing privacy, paths and invented audiences", async () => {
  let calls = 0;
  const mutate = () => { calls++; };
  const registry = createRegistry({ createStory: mutate, publishVideo: mutate, publishReel: mutate });
  for (const input of [
    {}, { photoID: "123" }, { photoID: "123", privacy: "PUBLIC" },
    { photoID: "123", videoID: "456", privacy: "current" },
    { text: "hello", privacy: "current" },
    { text: "hello", textPresetID: 123, fontID: "456", privacy: "current" },
    { photoID: "123", fontID: "456", privacy: "current" },
    { photoID: "C:\\photo.jpg", privacy: "current" }
  ]) assert.equal((await registry.call("facebook_create_story", input)).structuredContent.error.code, "INVALID_INPUT");
  for (const [name, input] of [
    ["facebook_publish_video", { videoID: "123", privacy: "current" }],
    ["facebook_publish_video", { videoID: "123", filePath: "C:\\video.mp4" }],
    ["facebook_publish_reel", { videoID: "123", placements: [] }],
    ["facebook_publish_reel", { videoID: "123", placements: [" "] }],
    ["facebook_publish_reel", { videoID: "123", placements: ["X"], draft: "true" }],
    ["facebook_publish_reel", { videoID: "123", placements: ["X"], privacy: "current" }]
  ]) assert.equal((await registry.call(name, input)).structuredContent.error.code, "INVALID_INPUT");
  assert.equal(calls, 0);
});

test("provider error codes survive without raw messages, stacks or details", async () => {
  for (const code of ["NOTIFICATIONS_UNAVAILABLE", "CONTENT_UNAVAILABLE", "GRAPHQL_ERROR", "SESSION_EXPIRED", "OPERATION_UNAVAILABLE"]) {
    const error = Object.assign(new Error("private-cookie"), { code, details: { access_token: "private-token" } });
    const registry = createRegistry({ getNotifications: async () => { throw error; } });
    const result = await registry.call("facebook_get_notifications", {});
    assert.equal(result.structuredContent.error.code, code);
    assert.ok(!JSON.stringify(result).includes("private-"));
    assert.equal(result.structuredContent.error.outcomeUnknown, false);
  }
  assert.equal(errorResult({ code: "GRAPHQL_ERROR" }, true).structuredContent.error.outcomeUnknown, true);
  assert.equal(errorResult({ code: "OPERATION_UNAVAILABLE" }, true).structuredContent.error.outcomeUnknown, false);
  assert.equal(errorResult({ code: "SESSION_EXPIRED", outcome: "unknown" }, true).structuredContent.error.outcomeUnknown, true);
  assert.equal(errorResult({ code: "SECRET_UNKNOWN_CODE" }).structuredContent.error.code, "API_ERROR");
});

test("SDK discovers refined Story schema and enforces exact-one semantics", async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const host = createMcpServer({ api: { createStory(options, cb) { cb(null, { storyID: "123", status: "accepted", published: null }); } } });
  const client = new Client({ name: "publishing-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await host.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    assert.equal(tools[0].inputSchema.properties.privacy.const, "current");
    const invalid = await client.callTool({ name: "facebook_create_story", arguments: { privacy: "current", photoID: "1", videoID: "2" } });
    assert.equal(invalid.structuredContent.error.code, "INVALID_INPUT");
    const valid = await client.callTool({ name: "facebook_create_story", arguments: { privacy: "current", photoID: "1" } });
    assert.equal(valid.structuredContent.data.published, null);
  } finally { await client.close(); await host.close(); }
});
