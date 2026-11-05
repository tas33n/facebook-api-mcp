"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");

let dependencies = true;
try {
  require.resolve("zod");
  require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
} catch (_) { dependencies = false; }
const needsDependencies = { skip: dependencies ? false : "Install @modelcontextprotocol/sdk@1.32.2 and zod@3.25.76 to run MCP integration tests" };

test("MCP registry curates capabilities and validates before invoking providers", needsDependencies, async () => {
  const { createRegistry } = require("../lib/mcp");
  let calls = 0;
  const registry = createRegistry({
    getThreadList(amount, timestamp, tags, callback) { calls++; callback(null, []); },
    getAppState() { throw new Error("must not expose session"); },
    arbitraryMutation() { throw new Error("must not dispatch arbitrary methods"); }
  });
  assert.deepEqual(registry.tools.map(tool => tool.name), ["facebook_list_threads"]);
  for (const args of [{ limit: 101 }, { before: "123" }, { unexpected: "secret" }, { tags: ["INVALID"] }]) {
    const response = await registry.call("facebook_list_threads", args);
    assert.equal(response.structuredContent.error.code, "INVALID_INPUT");
  }
  assert.equal(calls, 0);
  assert.equal((await registry.call("arbitraryMutation", {})).structuredContent.error.code, "UNKNOWN_TOOL");
  const response = await registry.call("facebook_list_threads", {});
  assert.equal(response.structuredContent.data.pagination.limit, 20);
  assert.equal(calls, 1);
});

test("MCP pagination bounds calls and returns advancing provider timestamp cursors", needsDependencies, async () => {
  const { createRegistry } = require("../lib/mcp");
  const observed = [];
  const registry = createRegistry({
    getThreadHistory(threadID, amount, before, callback) {
      observed.push([threadID, amount, before]);
      callback(null, before === null
        ? [{ messageID: "a", timestamp: "300" }, { messageID: "b", timestamp: "200" }]
        : [{ messageID: "c", timestamp: "100" }]);
    }
  });
  const first = (await registry.call("facebook_get_thread_history", { threadID: "123", limit: 2 })).structuredContent.data;
  assert.equal(first.pagination.nextBefore, 200);
  assert.equal(first.pagination.hasMore, null);
  const second = (await registry.call("facebook_get_thread_history", { threadID: "123", limit: 2, before: first.pagination.nextBefore })).structuredContent.data;
  assert.equal(second.pagination.nextBefore, null);
  assert.deepEqual(observed, [["123", 2, null], ["123", 2, 200]]);
});

test("MCP registry bounds results, redacts credentials and aborts pending calls on close", needsDependencies, async () => {
  const { createRegistry } = require("../lib/mcp");
  const registry = createRegistry({
    getThreadInfo: async () => ({ threadID: "123", token: "private", name: "secret-cookie" }),
    sendMessage() {},
    getMessage: async () => ({ body: "x".repeat(262145) })
  }, { secretValues: ["secret-cookie"], maxConcurrent: 1 });
  const read = await registry.call("facebook_get_thread_info", { threadID: "123" });
  assert.ok(!JSON.stringify(read).includes("secret-cookie"));
  assert.ok(!JSON.stringify(read).includes("private"));
  assert.equal((await registry.call("facebook_get_message", { threadID: "123", messageID: "m" })).structuredContent.error.code, "RESULT_TOO_LARGE");
  const pending = registry.call("facebook_send_message", { threadID: "123", text: "hello" });
  assert.equal((await registry.call("facebook_get_thread_info", { threadID: "123" })).structuredContent.error.code, "BUSY");
  registry.close();
  assert.equal((await pending).structuredContent.error.code, "CANCELLED");
  assert.equal((await registry.call("facebook_get_thread_info", { threadID: "123" })).structuredContent.error.code, "SERVER_CLOSED");
});

test("official SDK negotiates, lists typed tools, calls mocks and reads capability resources", needsDependencies, async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer, STATUS_URI } = require("../lib/mcp");
  let disposed = 0;
  const host = createMcpServer({ api: {
    getCurrentUserID: () => "123",
    sendMessage(text, threadID, callback, replyID) {
      assert.deepEqual([text, threadID, replyID], ["hello", "456", "mid.reply"]);
      callback(null, { messageID: "mid.sent" });
    }
  }, dispose: async () => { disposed++; } });
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await host.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const send = tools.find(tool => tool.name === "facebook_send_message");
    assert.equal(send.annotations.readOnlyHint, false);
    assert.equal(send.annotations.idempotentHint, false);
    assert.equal(send.inputSchema.properties.threadID.type, "string");
    const result = await client.callTool({ name: "facebook_send_message", arguments: { text: "hello", threadID: "456", replyToMessageID: "mid.reply" } });
    assert.equal(result.structuredContent.data.messageID, "mid.sent");
    const resource = await client.readResource({ uri: STATUS_URI });
    assert.equal(JSON.parse(resource.contents[0].text).tools.length, 2);
    const invalid = await client.callTool({ name: "facebook_send_message", arguments: { text: "hello", threadID: "bad" } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await host.close();
    await host.close();
  }
  assert.equal(disposed, 1);
});

test("stdio SDK writes only JSON-RPC and signal shutdown disposes once", needsDependencies, async () => {
  const { startStdioServer } = require("../lib/mcp");
  const input = new PassThrough();
  const output = new PassThrough();
  const processObject = new EventEmitter();
  let disposed = 0;
  let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const host = await startStdioServer({ api: { getCurrentUserID: () => "123" }, input, output, processObject, dispose: async () => { disposed++; } });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(text.trim()).id, 1);
  processObject.emit("SIGTERM");
  await host.close();
  assert.equal(disposed, 1);
  assert.equal(processObject.listenerCount("SIGINT"), 0);
});
