"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const uploadFactory = require("../src/uploadVideo");
const videoFactory = require("../src/publishVideo");
const reelFactory = require("../src/publishReel");

const operations = {
  MediaUploadFBDefaultServerConfigurationRetrieverQuery: "26396735533340887",
  VideoComposerVideoPublishingMutation: "28122626904057092",
  ReelComposerReelPublishMutation: "27793168930376367",
};
const uploadOptions = { source: "fixture-source", sourceType: "fixture-source-type" };
const response = payload => ({ statusCode: 200, body: "for (;;);" + JSON.stringify({ payload }) });

function harness(overrides = {}) {
  const calls = [];
  const ctx = { userID: "123", jar: {}, globalOptions: { facebookOperations: operations } };
  const funcs = {
    async post(url, jar, form) {
      assert.equal(jar, ctx.jar);
      calls.push({ url, form });
      if (form.fb_api_req_friendly_name) {
        if (overrides.graphql) return overrides.graphql(form);
        return { statusCode: 200, body: { data: { media_upload_config: overrides.config ?? {} } } };
      }
      return overrides.start ? overrides.start(form) : response({ video_id: "456", upload_session_id: "789", start_offset: "0", end_offset: "3" });
    },
    async postFormData(url, jar, form) {
      assert.equal(jar, ctx.jar);
      assert.equal(path.extname(form.video_file_chunk.path), ".mp4");
      const buffers = [];
      for await (const buffer of form.video_file_chunk) buffers.push(buffer);
      const chunk = Buffer.concat(buffers);
      calls.push({ url, form, chunk });
      if (overrides.receive) return overrides.receive(form, chunk);
      return response({ start_offset: form.end_offset, end_offset: "6" });
    },
  };
  return { calls, ctx, funcs, upload: uploadFactory(funcs, {}, ctx), video: videoFactory(funcs, {}, ctx), reel: reelFactory(funcs, {}, ctx) };
}

async function fixture(t, content = "abcdef") {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, "video-upload-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.mp4");
  await fs.writeFile(file, content);
  return file;
}

test("video upload streams negotiated ranges and stages without publishing", async t => {
  const file = await fixture(t);
  const h = harness();
  let callbackCount = 0;
  const result = await h.upload(file, uploadOptions, (error, value) => {
    assert.equal(error, null);
    assert.equal(value.published, false);
    callbackCount++;
  });
  assert.deepEqual(result, { videoID: "456", uploadSessionID: "789", bytesUploaded: 6, published: false });
  assert.equal(callbackCount, 1);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(JSON.parse(h.calls[0].form.variables), { source_type: "fixture-source-type" });
  const start = h.calls[1].form;
  assert.equal(start.file_size, 6);
  assert.equal(start.file_extension, "mp4");
  assert.equal(start.creator_product, 2);
  assert.equal(start.supports_file_api, true);
  assert.equal(start.partition_end_offset, 6);
  assert.deepEqual(h.calls.slice(2).map(call => call.chunk.toString()), ["abc", "def"]);
  assert.equal(h.calls[2].form.supports_chunking, "true");
  assert.equal(h.calls[3].form.composer_session_id, start.composer_session_id);
  assert.equal(h.calls[3].form.waterfall_id, start.waterfall_id);
});

test("upload skip flag stages the supplied ID without transferring chunks", async t => {
  const file = await fixture(t);
  const h = harness({ start: () => response({ video_id: "456", upload_session_id: "789", skip_upload: true }) });
  assert.deepEqual(await h.upload(file, uploadOptions), { videoID: "456", uploadSessionID: "789", bytesUploaded: 0, published: false });
  assert.equal(h.calls.length, 2);
});

test("upload validates both configured endpoints before mutation", async t => {
  const file = await fixture(t);
  for (const uri of ["http://upload.facebook.com/", "https://facebook.com.evil.test/", "https://evil.test/", "https://user@upload.facebook.com/", "https://upload.facebook.com:8443/", "https://facebook.com/", ""]) {
    const h = harness({ config: { network_receive: { uri } } });
    await assert.rejects(h.upload(file, uploadOptions), { code: "INVALID_UPLOAD_ENDPOINT" });
    assert.equal(h.calls.length, 1);
  }
  const h = harness({ config: { network_start: { uri: "https://upload.facebook.com/start/" }, network_receive: { uri: "https://upload.facebook.com/chunk/" } } });
  await h.upload(file, uploadOptions);
  assert.equal(h.calls[1].url, "https://upload.facebook.com/start/");
  assert.equal(h.calls[2].url, "https://upload.facebook.com/chunk/");
});

test("configuration failures never start upload", async t => {
  const file = await fixture(t);
  for (const bad of [{ statusCode: 503, body: "unavailable" }, { statusCode: 200, body: { data: {} } }, { statusCode: 200, body: { errors: [{ message: "denied" }] } }]) {
    const h = harness({ graphql: () => bad });
    await assert.rejects(h.upload(file, uploadOptions));
    assert.equal(h.calls.length, 1);
  }
});

test("start errors and malformed payloads are not replayed", async t => {
  const file = await fixture(t);
  for (const bad of [
    { statusCode: 500, body: "retry" }, { statusCode: 200, body: "<form id='login_form'>" },
    { statusCode: 200, body: "broken" }, { statusCode: 200, body: { error: 1 } },
    response({ error: 1 }), response({ errors: { message: "bad" } }), response({ success: false }),
    response({ video_id: "456", upload_session_id: "789", skip_upload: "false" }),
  ]) {
    const h = harness({ start: () => bad });
    let count = 0;
    await assert.rejects(h.upload(file, uploadOptions, error => { assert.equal(error.outcome, "unknown"); count++; }), { outcome: "unknown" });
    assert.equal(count, 1);
    assert.equal(h.calls.length, 2);
  }
});

test("invalid initial and acknowledged offsets stop without chunk replay", async t => {
  const file = await fixture(t);
  for (const [start, end] of [[1, 3], [0, 0], [-1, 3], [0, 7], [0, 1.5], [null, 3], [0, "Infinity"]]) {
    const h = harness({ start: () => response({ video_id: "456", upload_session_id: "789", start_offset: start, end_offset: end }) });
    await assert.rejects(h.upload(file, uploadOptions), { code: "INVALID_UPLOAD_OFFSET" });
    assert.equal(h.calls.length, 2);
  }
  for (const [start, end] of [[0, 3], [2, 6], [4, 6], [3, 3], [3, 7], [6, 5]]) {
    const h = harness({ receive: () => response({ start_offset: start, end_offset: end }) });
    await assert.rejects(h.upload(file, uploadOptions), { code: "INVALID_UPLOAD_OFFSET", outcome: "unknown" });
    assert.equal(h.calls.length, 3);
  }
});

test("chunk transport and final acknowledgement failures expose partial progress without retry", async t => {
  const file = await fixture(t);
  const h = harness({ receive: form => {
    if (form.start_offset === "0") return response({ start_offset: "3", end_offset: "6" });
    return { statusCode: 503, body: "unknown outcome" };
  } });
  await assert.rejects(h.upload(file, uploadOptions), { code: "HTTP_ERROR", outcome: "unknown", videoID: "456", bytesUploaded: 3 });
  assert.equal(h.calls.length, 4);
  const failing = harness({ receive: () => { throw new Error("connection lost"); } });
  await assert.rejects(failing.upload(file, uploadOptions), { message: "connection lost", outcome: "unknown" });
  assert.equal(failing.calls.length, 3);
});

test("file and source validation fail before network; modified files stop before next chunk", async t => {
  const empty = await fixture(t, "");
  const h = harness();
  await assert.rejects(h.upload(empty, uploadOptions), /nonempty regular file/);
  await assert.rejects(h.upload(empty, {}), /sourceType/);
  await assert.rejects(h.upload(empty, { sourceType: "test" }), /source/);
  assert.equal(h.calls.length, 0);
  const file = await fixture(t);
  const changed = harness({ receive: async () => {
    await fs.appendFile(file, "changed");
    return response({ start_offset: 3, end_offset: 6 });
  } });
  await assert.rejects(changed.upload(file, uploadOptions), { code: "UPLOAD_FILE_CHANGED" });
  assert.equal(changed.calls.length, 3);
});

test("unconsumed chunk failures release the file and do not accept a false acknowledgement", async t => {
  const file = await fixture(t);
  for (const fail of [true, false]) {
    const h = harness();
    let chunks = 0;
    h.funcs.postFormData = async () => {
      chunks++;
      if (fail) throw new Error("transport failed before reading");
      return response({ start_offset: 3, end_offset: 6 });
    };
    await assert.rejects(h.upload(file, uploadOptions), fail ? /transport failed before reading/ : { code: "UPLOAD_SIZE_MISMATCH" });
    assert.equal(chunks, 1);
  }
  await fs.rename(file, file + ".closed");
});

test("video publishing uses the observed input and only confirms a returned video ID", async () => {
  const h = harness({ graphql: () => ({ statusCode: 200, body: { data: { video_publish: { video_asset_id: "900" } } } }) });
  assert.deepEqual(await h.video({ videoID: "456", title: "Clip", description: "Caption", targetID: "321" }), { videoID: "900", published: true });
  const { input } = JSON.parse(h.calls[0].form.variables);
  assert.equal(input.actor_id, "321");
  assert.equal(input.basic_data.video_id, "456");
  assert.equal(input.basic_data.target_id, "321");
  assert.equal(input.basic_data.source, "composer");
  assert.equal(input.basic_data.composer_entry_point_ref, "timeline");
  assert.equal(input.basic_data.video_title, "Clip");
  assert.equal(input.basic_data.xhpc_message, "Caption");
  assert.equal(input.basic_data.creator_product, "2");
  assert.deepEqual(input.post_status_data, { draft: false, scheduled: false, expire_type: null });
  assert.equal("privacy" in input, false);
});

test("reel publishing requires explicit placements and distinguishes drafts", async () => {
  const h = harness({ graphql: () => ({ statusCode: 200, body: { data: { cpx_reel_publish: { success: true, published_video_id: "900" } } } }) });
  for (const placements of [undefined, [], [""], [4]]) await assert.rejects(h.reel({ videoID: "456", placements }), /placements/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.reel({ videoID: "456", caption: "Caption", placements: ["FIXTURE_DEPLOYMENT_VALUE"], draft: true }), { videoID: "900", published: false, draft: true });
  const { input } = JSON.parse(h.calls[0].form.variables);
  assert.equal(input.metadata.caption, "Caption");
  assert.equal(input.metadata.is_draft, true);
  assert.equal(input.should_skip_encoding, false);
  assert.equal(input.should_enforce_video_editor_path, false);
  assert.equal(input.trim_timestamps, null);
  assert.deepEqual(input.video_collaboration, { collaborators: [] });
  assert.deepEqual(input.audio_enhancement, { processing: 0 });
  assert.equal("thumbnail_type" in input, false);
});

test("publish failures and missing success evidence never retry and invoke callbacks once", async () => {
  for (const kind of ["video", "reel"]) {
    for (const bad of [
      { statusCode: 503, body: "failed" }, { statusCode: 200, body: { errors: [{ code: 1 }] } },
      { statusCode: 200, body: { data: {} } },
      { statusCode: 200, body: { data: { cpx_reel_publish: { success: false, published_video_id: "900" } } } },
      { statusCode: 200, body: { data: { cpx_reel_publish: { success: true } } } },
    ]) {
      const h = harness({ graphql: () => bad });
      let callbacks = 0;
      await assert.rejects(h[kind]({ videoID: "456", placements: ["FIXTURE_DEPLOYMENT_VALUE"] }, error => { assert.ok(error); callbacks++; throw new Error("callback failure"); }), { outcome: "unknown" });
      assert.equal(h.calls.length, 1);
      assert.equal(callbacks, 1);
    }
  }
});
