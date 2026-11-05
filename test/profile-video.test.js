"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
test("profile video publication uses staged media and handles fallback story identity", async () => {
  let form;
  const method = require("../src/createPost")({ post: async (url, jar, input) => {
    form = input;
    return { statusCode: 200, body: JSON.stringify({ data: { story_create: {
      story_id: Buffer.from("S:_I123:456").toString("base64"), publishing_flow: "FALLBACK", story: null,
    } } }) };
  } }, {}, { userID: "123", globalOptions: {} });
  assert.equal(await method({ videoID: "789", baseState: 3 }), "https://www.facebook.com/123/posts/456/");
  assert.equal(form.doc_id, "40854814490784248");
  const variables = JSON.parse(form.variables);
  assert.deepEqual(variables.input.attachments, [{ video: { id: "789" } }]);
  assert.equal(variables.input.audience.privacy.base_state, "SELF");
  assert.equal(variables.__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider, "AUTO_TRANSLATE");
});
test("profile publish adapter defaults public, preserves overrides and does not claim ready playback", async () => {
  let calls = 0;
  const inputs = [];
  const method = require("../src/publishVideoPost")({}, { createPost: async input => { calls++; inputs.push(input); return "https://www.facebook.com/123/posts/456/"; } });
  await assert.rejects(method({ videoID: "789", baseState: 0 }));
  assert.equal(calls, 0);
  const result = await method({ videoID: "789" });
  assert.equal(inputs[0].baseState, 1);
  assert.equal(result.published, null);
  assert.equal(result.status, "accepted");
  assert.equal(calls, 1);
  await method({ videoID: "789", baseState: 3 });
  assert.equal(inputs[1].baseState, 3);
});
test("MCP profile-video tool defaults Public and preserves explicit audience", async () => {
  const inputs = [];
  const registry = require("../lib/mcp/registry").createRegistry({ publishVideoPost: async input => { inputs.push(input); return { status: "accepted" }; } });
  assert.equal((await registry.call("facebook_publish_video_post", { videoID: "789" })).structuredContent.ok, true);
  assert.equal(inputs[0].baseState, 1);
  await registry.call("facebook_publish_video_post", { videoID: "789", audience: "FRIENDS" });
  assert.equal(inputs[1].baseState, 2);
  registry.close();
});
