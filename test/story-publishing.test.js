"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("../src/createStory");
test("Story uses the separate Story mutation, current audience and accepted state", async () => {
  let form;
  const method = create({ post: async (url, jar, body) => { form = body; return { statusCode: 200, body: JSON.stringify({ data: { story_create: { story_id: "123" } } }) }; } }, {}, { userID: "456", globalOptions: {} });
  const result = await method({ videoID: "789", privacy: "current" });
  assert.equal(form.fb_api_req_friendly_name, "StoriesCreateMutation");
  assert.equal(form.doc_id, "26770527039211553");
  const input = JSON.parse(form.variables).input;
  assert.equal(input.audiences[0].stories.self.target_id, "456");
  assert.deepEqual(input.attachments, [{ video: { id: "789" } }]);
  assert.equal(result.status, "accepted");
  assert.equal(result.published, null);
});
test("Story rejects ambiguous media and fabricated styling before requests", async () => {
  let calls = 0;
  const method = create({ post: async () => { calls++; } }, {}, { userID: "456" });
  await assert.rejects(method({ photoID: "1", videoID: "2", privacy: "current" }));
  await assert.rejects(method({ text: "hello", privacy: "current" }));
  await assert.rejects(method({ photoID: "1" }));
  assert.equal(calls, 0);
});
