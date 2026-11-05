"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const createEngagePost = require("../src/engagePost");

const comment = { action: "comment", postID: "100", text: "Exact  text\n" };
const storyID = Buffer.from("S:_I900:100").toString("base64");
const page = (items = [], cursor = null) => ({ items, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });

async function fixture(t, overrides = {}, options = {}) {
  const root = process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "Temp", "opencode") : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(root, "engage-post-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ctx = { userID: "alice", globalOptions: { actionLedgerPath: path.join(directory, "ledger.json"), ...options } };
  const calls = [];
  const api = {
    getPostComments: async () => page(), getCommentReplies: async () => page(),
    getPost: async () => ({ postID: "100", viewerReactionKnown: true, viewerReaction: null, viewerHasShared: null }),
    createCommentPost: async (...args) => { calls.push(["comment", ...args]); return { id: "created" }; },
    setPostReaction: async (...args) => { calls.push(["reaction", ...args]); return { id: "reacted" }; },
    sharePost: async (...args) => { calls.push(["share", ...args]); return { id: "shared" }; },
    ...overrides,
  };
  return { ctx, api, calls, engage: createEngagePost({}, api, ctx) };
}

test("durable concurrent requests reserve before reads and mutate once across recreated contexts", async t => {
  const f = await fixture(t);
  let reads = 0;
  f.api.getPostComments = async () => {
    reads++;
    const stored = JSON.parse(await fs.readFile(f.ctx.globalOptions.actionLedgerPath, "utf8"));
    assert.equal(Object.values(stored.records)[0].status, "pending");
    return page([{ id: "other", authorID: "bob", text: comment.text }, { id: "near", authorID: "alice", text: "Exact text\n" }]);
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => f.engage(comment)));
  assert.equal(reads, 1);
  assert.deepEqual(f.calls, [["comment", comment.text, "100"]]);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(results[0].result.coverage.exhausted, true);
  const restored = createEngagePost({}, f.api, { userID: "alice", globalOptions: { ...f.ctx.globalOptions } });
  const replay = await restored(comment);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.provenance, "ledger");
  assert.equal(reads, 1);
});

test("own exact comments are found on subsequent pages using the acting page identity", async t => {
  const seen = [];
  const f = await fixture(t, { getPostComments: async (postID, options) => {
    seen.push([postID, options]);
    return options.cursor ? page([{ id: "existing", authorID: "page-actor", text: comment.text }]) : page([], "next");
  } }, { pageID: "page-actor" });
  const result = await f.engage(comment);
  assert.equal(result.result.reason, "already-commented");
  assert.equal(result.result.existingID, "existing");
  assert.equal(result.result.coverage.pagesScanned, 2);
  assert.deepEqual(seen, [["100", { limit: 100, cursor: undefined }], ["100", { limit: 100, cursor: "next" }]]);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.engage(comment)).duplicate, true);
});

test("bounded, malformed, repeated and unreadable scans never assert absence or mutate", async t => {
  for (const mode of ["limit", "missing-page-info", "missing-author", "repeat", "read-error"]) {
    let reads = 0;
    const f = await fixture(t, { getPostComments: async () => {
      reads++;
      if (mode === "read-error") throw Object.assign(new Error("unavailable"), { code: "COMMENTS_UNAVAILABLE" });
      if (mode === "missing-page-info") return { items: [] };
      if (mode === "missing-author") return page([{ id: "unknown", text: "unreadable" }]);
      return page([], mode === "repeat" ? "same" : `cursor-${reads}`);
    } });
    await assert.rejects(f.engage(comment), error => {
      assert.equal(error.code, mode === "read-error" ? "COMMENTS_UNAVAILABLE" : "STATE_UNAVAILABLE");
      assert.equal(error.coverage.exhausted, false);
      return true;
    });
    assert.equal(reads, mode === "limit" ? 3 : mode === "repeat" ? 2 : 1);
    assert.equal(f.calls.length, 0);
    const replay = await f.engage(comment);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.status, "unknown");
  }
});

test("reply resolves parent metadata and uses the explicit parent comment mutation argument", async t => {
  const parentID = Buffer.from("comment:100_200").toString("base64");
  const scans = [];
  const f = await fixture(t, {
    getPostComments: async () => page([{ id: parentID, authorID: "bob", text: "parent", feedbackID: "feedback-parent", expansionToken: "token" }]),
    getCommentReplies: async (...args) => { scans.push(args); return page(); },
  });
  const input = { ...comment, action: "reply", parentCommentID: "200" };
  const result = await f.engage(input);
  assert.deepEqual(scans, [["feedback-parent", { limit: 100, cursor: undefined, expansionToken: "token" }]]);
  assert.deepEqual(f.calls, [["comment", comment.text, "100", "200"]]);
  assert.equal(result.result.coverage.parent.pagesScanned, 1);
  assert.equal((await f.engage({ ...input, parentCommentID: parentID })).duplicate, true);
});

test("reply skips own matching replies and keeps separate parents distinct", async t => {
  const f = await fixture(t, {
    getPostComments: async () => page([
      { id: "201", authorID: "bob", text: "parent", feedbackID: "feedback-1", expansionToken: "token" },
      { id: "202", authorID: "bob", text: "parent", feedbackID: "feedback-2", expansionToken: "token" },
    ]),
    getCommentReplies: async feedbackID => page(feedbackID === "feedback-1" ? [{ id: "reply", authorID: "alice", text: comment.text }] : []),
  });
  const input = { ...comment, action: "reply", parentCommentID: "201", parentFeedbackID: "feedback-1", expansionToken: "token" };
  assert.equal((await f.engage(input)).result.reason, "already-replied");
  assert.equal((await f.engage({ ...input, parentCommentID: "202", parentFeedbackID: "feedback-2" })).duplicate, false);
  assert.equal(f.calls.length, 1);
});

test("unresolved parent or missing expansion token blocks replies", async t => {
  for (const items of [[], [{ id: "201", authorID: "bob", text: "parent", feedbackID: "feedback" }]]) {
    const f = await fixture(t, { getPostComments: async () => page(items), getCommentReplies: async () => assert.fail("unresolved scan") });
    await assert.rejects(f.engage({ ...comment, action: "reply", parentCommentID: "201" }), { code: "PARENT_UNRESOLVED" });
    assert.equal(f.calls.length, 0);
  }
});

test("reaction checks known Like ID, viewer name, numeric normalization and no-reaction state", async t => {
  for (const [reaction, viewerReaction] of [["like", { id: "1635855486666999", name: null }],
    [1, { id: "unknown", name: "Like" }], ["care", { id: "unknown", name: "Care" }], ["unlike", null]]) {
    const f = await fixture(t, { getPost: async target => {
      assert.deepEqual(target, { postID: "100", actorID: "900" });
      return { postID: "100", viewerReactionKnown: true, viewerReaction };
    } });
    assert.equal((await f.engage({ action: "reaction", postID: "100", actorID: "900", reaction })).result.reason, "already-reacted");
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  const first = await f.engage({ action: "reaction", postID: "100", storyID, reaction: "love" });
  assert.deepEqual(f.calls, [["reaction", "100", 16]]);
  f.api.getPost = async () => ({ postID: "100", viewerReactionKnown: true, viewerReaction: { name: "Care" } });
  assert.equal((await f.engage({ action: "reaction", postID: "100", storyID, reaction: "care" })).key, first.key);
  assert.equal((await f.engage({ action: "reaction", postID: "100", storyID, reaction: 16 })).duplicate, true);
});

test("manual reaction changes authorize one revisioned mutation across concurrent restored callers", async t => {
  let current = { name: "Like" }, reads = 0;
  const f = await fixture(t, { getPost: async () => { reads++; return { postID: "100", viewerReactionKnown: true, viewerReaction: current }; } });
  const input = { action: "reaction", postID: "100", actorID: "900", reaction: "like" };
  const initial = await f.engage(input);
  assert.equal(initial.result.reason, "already-reacted");
  current = { name: "Angry" }; // Manual change outside this library.
  f.api.setPostReaction = async (...args) => { f.calls.push(args); current = { name: "Like" }; return { success: true }; };
  const restored = createEngagePost({}, f.api, { userID: "alice", globalOptions: f.ctx.globalOptions });
  const results = await Promise.all(Array.from({ length: 12 }, () => restored(input)));
  assert.equal(f.calls.length, 1);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  const record = (await f.ctx.facebookActionLedger.inspect(initial.key)).record;
  assert.equal(record.revision, 1);
  assert.equal(record.history.length, 1);
  assert.ok(reads >= 2);
  assert.equal((await restored(input)).duplicate, true);
});

test("an uncertain reaction blocks changed desired values and cannot use fresh negative state to retry", async t => {
  let calls = 0;
  const f = await fixture(t, { setPostReaction: async () => { calls++; throw new Error("lost response"); } });
  const input = { action: "reaction", postID: "100", actorID: "900", reaction: "like" };
  await assert.rejects(f.engage(input), { ledgerStatus: "unknown" });
  assert.equal((await f.engage(input)).status, "unknown");
  assert.equal((await f.engage({ ...input, reaction: "angry" })).status, "unknown");
  assert.equal(calls, 1);
});

test("lost response on a refreshed reaction retains the previous revision and blocks later refreshes", async t => {
  let current = { name: "Like" }, calls = 0;
  const f = await fixture(t, { getPost: async () => ({ postID: "100", viewerReactionKnown: true, viewerReaction: current }),
    setPostReaction: async () => { calls++; throw new Error("lost refreshed response"); } });
  const input = { action: "reaction", postID: "100", actorID: "900", reaction: "like" };
  const first = await f.engage(input);
  current = null;
  await assert.rejects(f.engage(input), { ledgerStatus: "unknown" });
  const restored = createEngagePost({}, f.api, { userID: "alice", globalOptions: f.ctx.globalOptions });
  assert.equal((await restored(input)).status, "unknown");
  const snapshot = await f.ctx.facebookActionLedger.inspect(first.key);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.record.history[0].status, "completed");
  assert.equal(calls, 1);
});

test("owned profile historical shares are bounded and use original target metadata", async t => {
  const cursors = [];
  const f = await fixture(t, { getProfilePosts: async (owner, options) => {
    assert.equal(owner, "alice");
    cursors.push(options.cursor);
    return options.cursor ? page([{ postID: "share-id", authorID: "alice", sharedPostID: "100" }]) :
      page([{ postID: "100", authorID: "other" }], "next");
  } });
  const input = { action: "share", postID: "100", url: "https://www.facebook.com/100" };
  const outcome = await f.engage(input);
  assert.equal(outcome.result.existingID, "share-id");
  assert.equal(outcome.result.coverage.historical, "matched");
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.equal(f.calls.length, 0);
  const another = await fixture(t, { getProfilePosts: async () => page([], "more") });
  const local = await another.engage({ ...input, maxScanPages: 1 });
  assert.equal(local.result.coverage.historical, "unknown");
  assert.equal(local.result.coverage.pagesScanned, 1);
  assert.equal(another.calls.length, 1);
});

test("unknown reaction state fails closed and does not replay", async t => {
  const f = await fixture(t, { getPost: async () => ({ postID: "100", viewerReactionKnown: false, viewerReaction: null }) });
  const input = { action: "reaction", postID: "100", actorID: "900", reaction: "like" };
  await assert.rejects(f.engage(input), { code: "STATE_UNAVAILABLE" });
  assert.equal((await f.engage(input)).status, "unknown");
  assert.equal(f.calls.length, 0);
});

test("shares mark local-only coverage, default privacy and destination-specific durable identity", async t => {
  const f = await fixture(t);
  const input = { action: "share", postID: "100", url: "https://www.facebook.com/100", text: "shared text" };
  const first = await f.engage(input);
  assert.equal(first.result.coverage.source, "local-only");
  assert.deepEqual(f.calls[0], ["share", input.url, { text: input.text, groupID: undefined, baseState: 1 }]);
  assert.equal((await f.engage(input)).duplicate, true);
  assert.notEqual((await f.engage({ ...input, groupID: "group-1", baseState: 3 })).key, first.key);
  assert.equal(f.calls.length, 2);
  f.api.getPost = async () => ({ postID: "100", viewerHasShared: true });
  assert.equal((await f.engage({ ...input, actorID: "900", groupID: "group-2" })).result.reason, "already-shared");
  assert.equal(f.calls.length, 2);
});

test("ambiguous mutation error stays unknown across new contexts without another effect", async t => {
  let calls = 0;
  const f = await fixture(t, { createCommentPost: async () => { calls++; throw new Error("response lost"); } });
  await assert.rejects(f.engage(comment), { message: "response lost", ledgerStatus: "unknown" });
  const restored = createEngagePost({}, f.api, { userID: "alice", globalOptions: f.ctx.globalOptions });
  const result = await restored(comment);
  assert.equal(result.status, "unknown");
  assert.equal(result.provenance, "ledger");
  assert.equal(calls, 1);
});

test("configuration, bounds and unsupported methods fail before any ledger reservation", async t => {
  const f = await fixture(t);
  const withoutPath = createEngagePost({}, f.api, { userID: "alice", globalOptions: {} });
  await assert.rejects(withoutPath(comment), { code: "ACTION_LEDGER_REQUIRED" });
  for (const input of [{ ...comment, maxScanPages: 0 }, { ...comment, maxScanPages: 11 },
    { ...comment, maxScanPages: 1.5 }, { ...comment, action: "bulk" }, { ...comment, text: "" },
    { action: "share", postID: "100", url: "https://example.com" },
    { action: "reaction", postID: "100", actorID: "900", reaction: "unknown" }]) {
    await assert.rejects(f.engage(input), { code: "INVALID_ACTION" });
  }
  await assert.rejects(f.engage({ action: "reaction", postID: "100", reaction: "like" }), { code: "STATE_UNAVAILABLE" });
  f.api.createCommentPost = undefined;
  await assert.rejects(f.engage(comment), { code: "UNSUPPORTED_ACTION" });
  await assert.rejects(fs.stat(f.ctx.globalOptions.actionLedgerPath), { code: "ENOENT" });
});

test("callbacks and promises return the same result and report validation errors once", async t => {
  const f = await fixture(t);
  let successes = 0;
  const result = await f.engage(comment, (error, value) => { assert.equal(error, null); assert.equal(value.status, "completed"); successes++; });
  assert.equal(result.status, "completed");
  assert.equal(successes, 1);
  let failures = 0;
  await assert.rejects(f.engage(null, error => { assert.equal(error.code, "INVALID_ACTION"); failures++; }));
  assert.equal(failures, 1);
});

test("engagement rejects cross-target story and parent identities before reads or reservation", async t => {
  const f = await fixture(t, { getPost: () => assert.fail("foreign story queried"),
    getPostComments: () => assert.fail("foreign parent queried") });
  const input = { action: "reaction", postID: "100", reaction: "like" };
  for (const options of [{ ...input, storyID: Buffer.from("S:_I900:200").toString("base64") },
    { ...input, storyID, actorID: "901" },
    { ...comment, action: "reply", parentCommentID: Buffer.from("comment:200_201").toString("base64"),
      parentFeedbackID: "foreign", expansionToken: "foreign" }]) {
    await assert.rejects(f.engage(options), { code: "TARGET_MISMATCH" });
  }
  await assert.rejects(f.engage({ ...comment, postID: "invalid" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(fs.stat(f.ctx.globalOptions.actionLedgerPath), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("wrong returned post cannot skip or mutate a reaction, including completed refresh", async t => {
  for (const refresh of [false, true]) {
    const f = await fixture(t, { getPost: async () => ({ postID: "100", viewerReactionKnown: true, viewerReaction: { name: "Like" } }) });
    const input = { action: "reaction", postID: "100", storyID, reaction: "like" };
    if (refresh) await f.engage(input);
    f.api.getPost = async () => ({ postID: "200", viewerReactionKnown: true, viewerReaction: refresh ? null : { name: "Like" } });
    await assert.rejects(f.engage(input), { code: "TARGET_MISMATCH" });
    assert.equal(f.calls.length, 0);
    const snapshot = await f.ctx.facebookActionLedger.inspect({ type: "reaction", targetID: "100", reaction: "1" });
    assert.equal(snapshot.status, refresh ? "completed" : "unknown");
    assert.equal(snapshot.revision, 0);
  }
});

test("supplied reply metadata cannot bypass parent lookup or select a different reply connection", async t => {
  const feedbackID = Buffer.from("feedback:pfbidOriginal_201").toString("base64");
  for (const mode of ["missing-parent", "wrong-feedback", "wrong-token", "foreign-parent", "valid-alias"]) {
    let reads = 0, replyReads = 0;
    const f = await fixture(t, {
      getPostComments: async target => {
        reads++; assert.equal(target, "100");
        return page(mode === "missing-parent" ? [] : [{
          id: Buffer.from(`comment:${mode === "foreign-parent" ? "200" : "pfbidOriginal"}_201`).toString("base64"),
          authorID: "bob", text: "parent", feedbackID, expansionToken: "resolved-token",
        }]);
      },
      getCommentReplies: async (feedback, options) => {
        replyReads++;
        assert.equal(feedback, feedbackID); assert.equal(options.expansionToken, "resolved-token");
        return page([{ id: "existing", authorID: "alice", text: comment.text }]);
      },
    });
    const input = { ...comment, action: "reply", parentCommentID: "201",
      parentFeedbackID: mode === "wrong-feedback" ? "foreign-feedback" : feedbackID,
      expansionToken: mode === "wrong-token" ? "foreign-token" : "resolved-token" };
    if (mode === "valid-alias") assert.equal((await f.engage(input)).result.reason, "already-replied");
    else await assert.rejects(f.engage(input), { code: mode === "missing-parent" ? "PARENT_UNRESOLVED" :
      mode === "foreign-parent" ? "TARGET_MISMATCH" : "PARENT_MISMATCH" });
    assert.equal(reads, 1);
    assert.equal(replyReads, mode === "valid-alias" ? 1 : 0);
    assert.equal(f.calls.length, 0);
  }
});
