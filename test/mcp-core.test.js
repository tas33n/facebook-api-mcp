"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { invoke } = require("../lib/mcp/invoke");
const { createSanitizer, errorResult, McpToolError } = require("../lib/mcp/safety");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("MCP invocation puts the callback before the optional reply ID and settles once", async () => {
  const api = {
    sendMessage(text, threadID, callback, replyID) {
      assert.equal(this, api);
      assert.deepEqual([text, threadID, replyID], ["hello", "123", "mid.reply"]);
      callback(null, { messageID: "mid.new" });
      callback(new Error("late callback"));
      return Promise.reject(new Error("late promise"));
    }
  };
  assert.deepEqual(await invoke(api, "sendMessage", ["hello", "123", "mid.reply"], { callbackIndex: 2 }), { messageID: "mid.new" });
});

test("MCP invocation supports synchronous IDs and promise-only implementations", async () => {
  assert.equal(await invoke({ getCurrentUserID: () => "123" }, "getCurrentUserID", [], { synchronous: true }), "123");
  assert.deepEqual(await invoke({ getThreadInfo: async () => ({ threadID: "123" }) }, "getThreadInfo", ["123"]), { threadID: "123" });
});

test("MCP invocation times out, aborts, and never retries a mutation", async () => {
  let calls = 0;
  const api = { sendMessage() { calls++; } };
  await assert.rejects(invoke(api, "sendMessage", [], { timeoutMs: 10 }), { code: "TIMEOUT" });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = invoke(api, "sendMessage", [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(calls, 2);
  await assert.rejects(invoke(api, "sendMessage", [], { signal: controller.signal }), { code: "CANCELLED" });
  assert.equal(calls, 2);
});

test("MCP sanitizer removes nested sessions, cookie records and known secret strings", () => {
  const sanitizer = createSanitizer(["known-secret-value"]);
  const input = {
    text: "hello known-secret-value", nested: { fb_dtsg: "private-token", headers: { cookie: "xs=private" } },
    cookies: [{ key: "xs", value: "private-cookie", domain: ".facebook.com" }],
    record: { key: "other", value: "private-cookie", domain: ".facebook.com" },
    url: "https://example.test/?access_token=private-token&x=1"
  };
  input.circular = input;
  const output = JSON.stringify(sanitizer.sanitize(input));
  for (const secret of ["known-secret-value", "private-token", "private-cookie"]) assert.ok(!output.includes(secret));
  assert.ok(output.includes("hello [REDACTED]"));
  assert.ok(output.includes("[Circular]"));
});

test("MCP errors never echo raw provider errors and mark unknown mutation outcomes", () => {
  const result = errorResult({ message: "private-token", request: { cookie: "private-cookie" } }, true);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "API_ERROR");
  assert.equal(result.structuredContent.error.outcomeUnknown, true);
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.equal(errorResult(new McpToolError("INVALID_INPUT"), true).structuredContent.error.outcomeUnknown, false);
});

test("standalone MCP help and configuration errors leave stdout empty", () => {
  const entry = path.join(__dirname, "../bin/facebook-api-mcp.js");
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, "");
  assert.match(help.stderr, /Usage:/);
  const invalid = spawnSync(process.execPath, [entry, "--unknown-secret-argument"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.ok(!invalid.stderr.includes("unknown-secret-argument"));
});
