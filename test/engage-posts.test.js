"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
test("selected batch validates every target before mutation and stops on uncertain outcome", async () => {
  let calls = 0;
  const method = require("../src/engagePosts")({}, { engagePost: async () => { calls++; return { status: "unknown", duplicate: true }; } });
  await assert.rejects(method([{ postID: "1" }, { postID: "bad" }], { action: "comment", text: "hi" }));
  assert.equal(calls, 0);
  const result = await method([{ postID: "1" }, { postID: "2" }], { action: "reaction", reaction: "like" });
  assert.equal(calls, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.complete, false);
});
