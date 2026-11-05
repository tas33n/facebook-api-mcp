"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVideoStatus, verifyPublication } = require("../lib/facebook/PublicationVerifier");
const getVideoStatusFactory = require("../src/getVideoStatus");
const verifyFactory = require("../src/verifyPublication");

const storyID = Buffer.from("S:_I100:200").toString("base64");
const target = { postID: "200", actorID: "100" };
const post = { storyID, postID: "200", authorID: "100", text: "Hello", kind: "video" };
function video(overrides = {}) {
  return { id: "123", video_status_type: "OK", owner: { id: "100" }, creation_story: { id: storyID },
    videoDeliveryLegacyFields: { browser_native_sd_url: "https://cdn.example/video?secret=signed" }, ...overrides };
}
const normalized = overrides => normalizeVideoStatus({ video: video(overrides) }, "123");
function client(body) {
  const calls = [];
  const defaults = { async post(url, jar, form) {
    calls.push({ url, form, variables: JSON.parse(form.variables) });
    return { statusCode: 200, body: typeof body === "string" ? body : JSON.stringify({ data: body }) };
  } };
  return { calls, read: getVideoStatusFactory(defaults, {}, { jar: {}, globalOptions: {
    facebookOperations: { CometWatchAndScrollVideoQuery: "38751426284470540" },
  } }) };
}

test("publication needs OK, story and playback; upload timestamps do not prove publication", () => {
  const staged = normalized({ video_status_type: "UPLOADING", publish_time: 1234, title: { text: "Uploaded" },
    creation_story: null, videoDeliveryLegacyFields: {} });
  assert.equal(staged.publishTime, 1234);
  assert.equal(staged.published, false);
  assert.equal(staged.hasStory, false);
  assert.equal(staged.playable, false);
  assert.equal(normalized({ video_status_type: "UPLOADING" }).published, false);
  assert.equal(normalized({ creation_story: null }).published, false);
  assert.equal(normalized({ videoDeliveryLegacyFields: {} }).published, false);
  assert.equal(normalized().published, true);
  assert.equal(normalized({ creation_story: null, container_story: { id: storyID } }).published, true);
});

test("only HTTP playback URLs count and signed URLs never appear in status output", () => {
  for (const url of [null, "", "  ", true, {}, "not a URL", "javascript:alert(1)"]) {
    assert.equal(normalized({ videoDeliveryLegacyFields: { browser_native_sd_url: url } }).playable, false);
  }
  assert.equal(normalized({ videoDeliveryLegacyFields: { dash_manifest_url: "https://cdn.example/a.mpd" } }).playable, true);
  const result = normalized();
  assert.deepEqual(result.playback, { dash: false, sd: true, hd: false });
  assert.doesNotMatch(JSON.stringify(result), /cdn|secret|signed/);
  for (const data of [{}, { video: null }, { video: video({ id: "999" }) }]) {
    assert.throws(() => normalizeVideoStatus(data, "123"), { code: "VIDEO_UNAVAILABLE" });
  }
});

test("getVideoStatus uses observed variables, incremental data and callback", async () => {
  const body = [JSON.stringify({ data: { video: video({ videoDeliveryLegacyFields: {} }) } }),
    JSON.stringify({ path: ["video", "videoDeliveryLegacyFields"], data: { browser_native_hd_url: "https://cdn.example/hd" } })].join("\n");
  const { read, calls } = client(body);
  let callbackValue;
  const result = await read({ videoID: "123" }, (error, value) => { assert.equal(error, null); callbackValue = value; });
  assert.equal(callbackValue, result);
  assert.equal(result.published, true);
  assert.deepEqual(calls[0].variables, { videoID: "123", chainingSeedVideoID: "123", scale: 1, chainingDisabled: true });
  assert.equal(calls[0].form.doc_id, "38751426284470540");
  assert.equal(calls[0].form.fb_api_req_friendly_name, "CometWatchAndScrollVideoQuery");
});

test("getVideoStatus rejects bad IDs and options before reading and honours cancellation", async () => {
  const { read, calls } = client({ video: video() });
  for (const id of [123, "pfbid123", {}, null]) await assert.rejects(read(id), { code: "INVALID_ARGUMENT" });
  for (const options of [null, [], { timeoutMs: 0 }, { timeoutMs: 600001 }, { signal: {} }]) {
    await assert.rejects(read("123", options), { code: "INVALID_ARGUMENT" });
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(read("123", { signal: controller.signal }), { code: "ABORTED" });
  assert.equal(calls.length, 0);
});

test("polls only reads until video becomes published and stops immediately on success", async () => {
  let reads = 0;
  const api = { async getVideoStatus() { return normalized(++reads === 1 ? { video_status_type: "UPLOADING" } : {}); },
    createPost() { assert.fail("must not publish"); }, publishVideoPost() { assert.fail("must not publish"); } };
  const result = await verifyPublication(api, { videoID: "123" }, { intervalMs: 100 });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 2);
  assert.equal(reads, 2);
  assert.deepEqual(result.history.map(item => item.status), ["pending", "verified"]);
});

test("pending video and unavailable reads stay distinct when attempts are exhausted", async () => {
  const pending = await verifyPublication({ getVideoStatus: async () => normalized({ video_status_type: "UPLOADING" }) },
    { videoID: "123" }, { maxAttempts: 2, intervalMs: 100 });
  assert.equal(pending.status, "pending");
  assert.equal(pending.verified, false);
  assert.equal(pending.attempts, 2);
  const missing = await verifyPublication({ async getPost() { throw Object.assign(new Error("missing"), { code: "POST_UNAVAILABLE" }); } },
    target, { maxAttempts: 2, intervalMs: 100 });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.errorCode, "POST_UNAVAILABLE");
  assert.equal(missing.attempts, 2);
  const unknown = await verifyPublication({ getVideoStatus: async () => normalized({ video_status_type: null }) },
    { videoID: "123" }, { maxAttempts: 1 });
  assert.equal(unknown.status, "unavailable");
});

test("post expectations require exact observed text/media/audience and never infer privacy", async () => {
  const api = { getPost: async () => ({ ...post, media: [{ playableURL: "https://cdn/secret" }] }) };
  const result = await verifyPublication(api, target, { expectedText: "Hello", expectedMediaType: "video" });
  assert.equal(result.verified, true);
  assert.doesNotMatch(JSON.stringify(result), /cdn|secret/);
  const mismatch = await verifyPublication(api, target, { expectedText: "hello", maxAttempts: 1 });
  assert.equal(mismatch.status, "mismatch");
  const audience = await verifyPublication(api, target, { expectedAudience: "PUBLIC", maxAttempts: 1 });
  assert.equal(audience.status, "unavailable");
  assert.equal(audience.evidence.checks.audience, null);
  const known = await verifyPublication({ getPost: async () => ({ ...post, audience: "PUBLIC" }) }, target,
    { expectedAudience: "PUBLIC", maxAttempts: 1 });
  assert.equal(known.verified, true);
  const unknown = await verifyPublication({ getPost: async () => ({ ...post, text: null, kind: "unknown" }) }, target,
    { expectedText: "", expectedMediaType: "text", maxAttempts: 1 });
  assert.equal(unknown.status, "unavailable");
});

test("video expectations read the linked story only after publication evidence exists", async () => {
  let postReads = 0;
  const api = { getVideoStatus: async () => normalized(), async getPost(identity) {
    postReads++;
    assert.equal(identity.storyID, storyID);
    return post;
  } };
  const result = await verifyPublication(api, { videoID: "123" }, { expectedText: "Hello" });
  assert.equal(result.verified, true);
  assert.equal(postReads, 1);
  api.getVideoStatus = async () => normalized({ video_status_type: "UPLOADING" });
  assert.equal((await verifyPublication(api, { videoID: "123" }, { expectedText: "Hello", maxAttempts: 1 })).status, "pending");
  assert.equal(postReads, 1);
});

test("hanging reads time out, late completion cannot retry, and session failures stop", async () => {
  let finish, reads = 0;
  const result = await verifyPublication({ getPost() { reads++; return new Promise(resolve => { finish = resolve; }); } },
    target, { timeoutMs: 20 });
  assert.equal(result.status, "timeout");
  assert.equal(result.attempts, 1);
  finish(post);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  const unavailable = await verifyPublication({ async getPost() {
    throw Object.assign(new Error("sensitive raw transport response"), { code: "SESSION_EXPIRED" });
  } }, target);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.attempts, 1);
  assert.doesNotMatch(JSON.stringify(unavailable), /sensitive/);
});

test("cancellation before reads, during reads and between attempts prevents further work", async () => {
  const before = new AbortController();
  before.abort();
  const early = await verifyPublication({ getPost() { assert.fail("cancelled read"); } }, target, { signal: before.signal });
  assert.equal(early.status, "cancelled");
  assert.equal(early.attempts, 0);
  const during = new AbortController();
  const pending = verifyPublication({ getPost() { during.abort(); return new Promise(() => {}); } }, target, { signal: during.signal });
  assert.equal((await pending).status, "cancelled");
  const waiting = new AbortController();
  let reads = 0;
  const waitingResult = verifyPublication({ async getVideoStatus() {
    reads++;
    setTimeout(() => waiting.abort(), 10);
    return normalized({ video_status_type: "UPLOADING" });
  } }, { videoID: "123" }, { signal: waiting.signal, intervalMs: 100 });
  assert.equal((await waitingResult).status, "cancelled");
  assert.equal(reads, 1);
});

test("verification validation rejects unsupported URLs and bounds without issuing reads", async () => {
  const api = { getPost() { assert.fail("invalid read"); }, getVideoStatus() { assert.fail("invalid read"); } };
  for (const input of ["123", {}, { url: "https://www.facebook.com/pfbid123" }, { postID: "200" },
    { videoID: "123", postID: "200" }]) {
    await assert.rejects(verifyPublication(api, input), { code: "INVALID_ARGUMENT" });
  }
  for (const options of [null, { maxAttempts: 0 }, { maxAttempts: 21 }, { maxAttempts: 1.5 }, { intervalMs: 99 },
    { intervalMs: 30001 }, { expectedText: 1 }, { expectedMediaType: "audio" }, { expectedAudience: 1 }]) {
    await assert.rejects(verifyPublication(api, target, options), { code: "INVALID_ARGUMENT" });
  }
});

test("verifyPublication supports promise and callback with consistent success and validation errors", async () => {
  const verify = verifyFactory({}, { getPost: async () => post });
  let callbackResult;
  const result = await verify(target, (error, value) => { assert.equal(error, null); callbackResult = value; });
  assert.equal(result, callbackResult);
  let callbackError;
  await assert.rejects(verify({}, error => { callbackError = error; }), { code: "INVALID_ARGUMENT" });
  assert.equal(callbackError.code, "INVALID_ARGUMENT");
});
