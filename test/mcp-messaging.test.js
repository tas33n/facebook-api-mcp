"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistry } = require("../lib/mcp");

test("messaging MCP adapters preserve target identities, argument order and unverified acknowledgements", async () => {
  const cases = [
    ["facebook_mute_thread", "muteThread", { threadID: "20002", seconds: 60 }, ["20002", 60]],
    ["facebook_delete_message_for_me", "deleteMessage", { threadID: "20002", messageID: "mid.one" }, ["mid.one", "20002"]],
    ["facebook_change_thread_admin", "changeAdminStatus", { threadID: "20002", participantID: "30003", isAdmin: false }, ["20002", "30003", false]],
    ["facebook_remove_thread_participant", "removeUserFromGroup", { threadID: "20002", participantID: "30003" }, ["30003", "20002"]],
    ["facebook_pin_message", "pinMessage", { threadID: "20002", messageID: "mid.one", pinned: false }, [false, "mid.one", "20002"]],
    ["facebook_share_contact", "shareContact", { threadID: "20002", contactID: "30003" }, ["", "30003", "20002"]],
    ["facebook_share_link", "shareLink", { threadID: "20002", url: "https://example.com", text: "caption" }, ["caption", "https://example.com", "20002"]],
  ];
  for (const [name, method, input, expected] of cases) {
    let count = 0;
    const registry = createRegistry({ [method](...args) {
      const callback = args.pop();
      assert.deepEqual(args, expected);
      count++;
      callback(null, { acknowledged: true, verified: false });
    } });
    const result = (await registry.call(name, input)).structuredContent;
    assert.equal(result.ok, true, name);
    assert.equal(result.data.verified, false);
    assert.equal((await registry.call(name, { ...input, arbitrary: true })).structuredContent.error.code, "INVALID_INPUT");
    assert.equal(count, 1);
    registry.close();
  }
});
