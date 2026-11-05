"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ActionLedger } = require("../lib/facebook/ActionLedger");
const createReconcile = require("../src/reconcileAction");
const page = items => ({ items, pageInfo: { hasNextPage: false, endCursor: null } });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-action-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ctx = { userID: "alice", globalOptions: { actionLedgerPath: path.join(directory, "ledger.json") } };
  const ledger = new ActionLedger({ accountID: "alice", path: ctx.globalOptions.actionLedgerPath });
  return { ctx, ledger };
}

test("read-only reconciliation completes lost comments without executing mutations", async t => {
  const { ctx, ledger } = await fixture(t);
  const action = { type: "comment", targetID: "100", text: "exact" };
  await assert.rejects(ledger.run(action, () => { throw new Error("crash after send"); }));
  let items = [];
  const reconcile = createReconcile({}, {
    getPostComments: async () => page(items),
    createCommentPost: () => assert.fail("reconciliation mutated"),
  }, ctx);
  assert.equal((await reconcile(action)).status, "unknown");
  items = [{ id: "remote", authorID: "alice", text: "exact" }];
  const result = await reconcile(ledger.key(action));
  assert.equal(result.reconciled, true);
  assert.equal(result.record.result.existingID, "remote");
  assert.equal((await reconcile(action, { inspectOnly: true })).status, "completed");
});

test("partial/error scans and historical shares missing original metadata stay unknown", async t => {
  const { ctx, ledger } = await fixture(t);
  const action = { type: "share", targetID: "100", destinationID: "wall:alice" };
  await assert.rejects(ledger.run(action, () => { throw new Error("lost share"); }));
  let items = [{ id: "100", authorID: "alice" }];
  const reconcile = createReconcile({}, { getProfilePosts: async () => page(items) }, ctx);
  assert.equal((await reconcile(action)).status, "unknown");
  items = [{ postID: "share", authorID: "alice", sharedPostID: "100" }];
  assert.equal((await reconcile(action)).status, "completed");
  const comment = { type: "comment", targetID: "100", text: "text" };
  await assert.rejects(ledger.run(comment, () => { throw new Error("uncertain"); }));
  const unavailable = createReconcile({}, { getPostComments: async () => { throw new Error("offline"); } }, ctx);
  const result = await unavailable(comment);
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence.coverage.readError, "READ_FAILED");
});

test("reaction reconciliation requires matching current viewer and preserves callback contract", async t => {
  const { ctx, ledger } = await fixture(t);
  const action = { type: "reaction", targetID: "100", reaction: "1" };
  await assert.rejects(ledger.run(action, () => { throw new Error("lost reaction"); }));
  let current = null;
  const reconcile = createReconcile({}, { getPost: async () => ({ postID: "100", viewerReactionKnown: true, viewerReaction: current }) }, ctx);
  assert.equal((await reconcile(action, { actorID: "900" })).status, "unknown");
  current = { name: "Like" };
  let called = 0;
  const result = await reconcile(action, { actorID: "900" }, (error, value) => {
    assert.equal(error, null); assert.equal(value.status, "completed"); called++;
  });
  assert.equal(result.reconciled, true);
  assert.equal(called, 1);
});

test("reaction reconciliation rejects cross-target stories before reads and mismatched returned posts", async t => {
  const { ctx, ledger } = await fixture(t);
  const action = { type: "reaction", targetID: "100", reaction: "1" };
  await assert.rejects(ledger.run(action, () => { throw new Error("lost response"); }));
  let reads = 0, returnedID = "200";
  const reconcile = createReconcile({}, { getPost: async () => {
    reads++;
    return { postID: returnedID, authorID: "900", viewerReactionKnown: true, viewerReaction: { name: "Like" } };
  } }, ctx);
  const story = (owner, post) => Buffer.from(`S:_I${owner}:${post}`).toString("base64");
  for (const options of [{ storyID: story("900", "200") }, { storyID: story("900", "100"), actorID: "901" }]) {
    await assert.rejects(reconcile(ledger.key(action), options), { code: "TARGET_MISMATCH" });
    assert.equal((await ledger.inspect(action)).status, "unknown");
  }
  assert.equal(reads, 0);
  await assert.rejects(reconcile(action, { storyID: story("900", "100") }), { code: "TARGET_MISMATCH" });
  assert.equal((await ledger.inspect(action)).status, "unknown");
  returnedID = "100";
  assert.equal((await reconcile(action, { storyID: story("900", "100"), actorID: "900" })).status, "completed");
});

test("reply reconciliation always resolves the target parent and rejects foreign feedback or tokens", async t => {
  const { ctx, ledger } = await fixture(t);
  const action = { type: "reply", targetID: "100", parentID: "201", text: "exact" };
  await assert.rejects(ledger.run(action, () => { throw new Error("lost reply"); }));
  let parentReads = 0, replyReads = 0;
  const feedbackID = Buffer.from("feedback:pfbidOriginal_201").toString("base64");
  let parents = [];
  const reconcile = createReconcile({}, {
    getPostComments: async target => { assert.equal(target, "100"); parentReads++; return page(parents); },
    getCommentReplies: async (feedback, options) => {
      assert.equal(feedback, feedbackID);
      assert.equal(options.expansionToken, "resolved-token");
      replyReads++;
      return page([{ id: "reply", authorID: "alice", text: "exact" }]);
    },
  }, ctx);
  const supplied = { parentFeedbackID: "foreign-feedback", expansionToken: "foreign-token" };
  assert.equal((await reconcile(action, supplied)).status, "unknown");
  assert.equal(replyReads, 0);
  parents = [{ id: Buffer.from("comment:pfbidOriginal_201").toString("base64"), authorID: "bob", text: "parent",
    feedbackID, expansionToken: "resolved-token" }];
  for (const options of [supplied, { parentFeedbackID: feedbackID, expansionToken: "foreign-token" },
    { parentFeedbackID: Buffer.from("feedback:100_201").toString("base64"), expansionToken: "resolved-token" }]) {
    await assert.rejects(reconcile(action, options), { code: "PARENT_MISMATCH" });
    assert.equal((await ledger.inspect(action)).status, "unknown");
  }
  assert.equal(replyReads, 0);
  assert.equal(parentReads, 4);
  assert.equal((await reconcile(action, { parentFeedbackID: feedbackID, expansionToken: "resolved-token" })).status, "completed");
  assert.equal(replyReads, 1);
});

test("invalid canonical targets and cross-post parent identities cannot query or clear uncertainty", async t => {
  const { ctx, ledger } = await fixture(t);
  const reconcile = createReconcile({}, { getPostComments: () => assert.fail("invalid target queried"),
    getCommentReplies: () => assert.fail("invalid parent queried") }, ctx);
  for (const action of [{ type: "comment", targetID: "not-a-post", text: "exact" },
    { type: "reply", targetID: "100", parentID: Buffer.from("comment:200_201").toString("base64"), text: "exact" }]) {
    await assert.rejects(ledger.run(action, () => { throw new Error("uncertain"); }));
    await assert.rejects(reconcile(action), { code: action.type === "comment" ? "INVALID_ARGUMENT" : "TARGET_MISMATCH" });
    assert.equal((await ledger.inspect(action)).status, "unknown");
  }
});
