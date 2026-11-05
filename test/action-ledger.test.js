"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { ActionLedger, BeforeNetworkError, actionKey, actionKeys } = require("../lib/facebook/ActionLedger");

const action = { type: "comment", targetID: "post-1", text: "Hello  world\n" };

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "action-ledger-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "ledger.json");
  return { filename, ledger: new ActionLedger({ path: filename, accountID: "alice", ...options }) };
}

function childRun(filename, accountID = "alice", hold = false) {
  const modulePath = require.resolve("../lib/facebook/ActionLedger");
  const script = `
    const { ActionLedger } = require(${JSON.stringify(modulePath)});
    const ledger = new ActionLedger({path: ${JSON.stringify(filename)}, accountID: ${JSON.stringify(accountID)}});
    ledger.run(${JSON.stringify(action)}, async () => {
      process.send({executing: true});
      ${hold ? 'await new Promise(resolve => process.once("message", resolve));' : ""}
      return {id: "remote"};
    }).then(result => process.send({result}, () => process.disconnect()),
      error => process.send({error: error.code}, () => process.disconnect()));
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

test("canonical keys separate accounts, actors, operations and meaningful content", () => {
  const key = actionKey("alice", action);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, actionKeys.comment("alice", { text: action.text, target: " post-1 ", actor: "alice" }));
  for (const changed of [
    { ...action, text: "Hello world\n" }, { ...action, text: "Hello  world" },
    { ...action, actor: "page" }, { ...action, target: undefined, targetID: "post-2" },
    { ...action, type: "post" }, { ...action, type: "reply", parent: "parent-1" },
    { ...action, type: "reply", parent: "parent-2" },
    { ...action, type: "reaction", reaction: "like" },
    { ...action, type: "reaction", reaction: "love" },
    { ...action, type: "share", destination: "wall-1" },
    { ...action, type: "share", destination: "wall-2" },
  ]) assert.notEqual(key, actionKey("alice", changed));
  assert.notEqual(key, actionKey("bob", action));
  assert.equal(actionKeys.reaction("alice", { target: 123, reaction: "like" }),
    actionKeys.reaction("alice", { target: "123", reaction: "LIKE" }));
  assert.throws(() => actionKey("alice", { ...action, target: "different" }), { code: "INVALID_ACTION" });
  assert.throws(() => actionKeys.reply("alice", action), { code: "INVALID_ACTION" });
  assert.throws(() => new ActionLedger(), { code: "INVALID_ACTION" });
});

test("memory mode is explicitly non-durable and coalesces concurrent attempts", async () => {
  const ledger = new ActionLedger({ accountID: "alice" });
  assert.equal(ledger.durable, false);
  assert.equal(ledger.path, null);
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 20 }, () => ledger.run(action, async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    return { id: "comment-1" };
  })));
  assert.equal(calls, 1);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  results[0].result.id = "mutated";
  assert.equal((await ledger.run(action, () => assert.fail("duplicate effect"))).result.id, "comment-1");
});

test("durable reservations precede effects; instances share history without merging accounts", async t => {
  const { filename, ledger } = await fixture(t);
  assert.equal(ledger.durable, true);
  const other = new ActionLedger({ path: filename, accountID: "alice" });
  let calls = 0;
  const execute = async () => {
    calls++;
    const saved = JSON.parse(await fs.readFile(filename, "utf8"));
    assert.equal(saved.records[ledger.key(action)].status, "pending");
    await assert.rejects(fs.open(filename + ".lock", "wx"), { code: "EEXIST" });
    return { id: "comment-1" };
  };
  const results = await Promise.all([ledger.run(action, execute), other.run(action, execute)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map(result => result.duplicate), [false, true]);
  const reloaded = new ActionLedger({ path: filename, accountID: "alice" });
  assert.deepEqual(await reloaded.run(action, () => assert.fail("replayed")), { ...results[0], duplicate: true });
  const bob = new ActionLedger({ path: filename, accountID: "bob" });
  assert.equal((await bob.run(action, () => "bob-result")).duplicate, false);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(filename, "utf8")).records).length, 2);
});

test("errors default to unknown; only explicit pre-network errors allow opted-in retry", async t => {
  const { filename, ledger } = await fixture(t);
  await assert.rejects(ledger.run(action, () => { throw new Error("timeout"); }), { ledgerStatus: "unknown" });
  const reloaded = new ActionLedger({ path: filename, accountID: "alice" });
  assert.equal((await reloaded.run(action, () => assert.fail("unknown replay"), { retrySafe: true })).status, "unknown");
  const safe = { ...action, targetID: "safe" };
  await assert.rejects(ledger.run(safe, () => { throw new BeforeNetworkError("local validation"); }), { ledgerStatus: "safe_retry" });
  assert.equal((await ledger.run(safe, () => assert.fail("implicit retry"))).status, "safe_retry");
  assert.equal((await reloaded.run(safe, () => "retried", { retrySafe: true })).result, "retried");
  assert.equal((await ledger.run(safe, () => assert.fail("completed retry"), { retrySafe: true })).status, "completed");
});

test("cross-process exclusive lock blocks effects and durable results deduplicate", async t => {
  const { filename, ledger } = await fixture(t);
  const child = childRun(filename, "alice", true);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.deepEqual((await once(child, "message"))[0], { executing: true });
  await assert.rejects(ledger.run(action, () => assert.fail("concurrent process effect")), { code: "LEDGER_BUSY" });
  const done = once(child, "message");
  const exited = once(child, "exit");
  child.send("finish");
  assert.equal((await done)[0].result.status, "completed");
  assert.equal((await exited)[0], 0);
  const duplicate = await ledger.run(action, () => assert.fail("process replay"));
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.result, { id: "remote" });
});

test("crashed pending remains blocked, stale locks are not stolen, recovery is unknown", async t => {
  const { filename, ledger } = await fixture(t);
  const child = childRun(filename, "alice", true);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, "message");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const old = new Date(0);
  await fs.utimes(filename + ".lock", old, old);
  await assert.rejects(ledger.run(action, () => assert.fail("stale lock stolen")), { code: "LEDGER_BUSY" });
  // Operator recovery is safe here because this test has awaited owner exit.
  await fs.unlink(filename + ".lock");
  const recovered = await ledger.run(action, () => assert.fail("crashed action replayed"), { retrySafe: true });
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.duplicate, true);
});

test("invalid JSON and malformed history fail closed without replacing it", async t => {
  const { filename, ledger } = await fixture(t);
  for (const content of ["{truncated", JSON.stringify({ version: 1, records: { invalid: { status: "completed" } } }),
    JSON.stringify({ version: 2, records: {} })]) {
    await fs.writeFile(filename, content);
    await assert.rejects(ledger.run(action, () => assert.fail("effect on corrupt history")), { code: "LEDGER_CORRUPT" });
    assert.equal(await fs.readFile(filename, "utf8"), content);
    await assert.rejects(fs.stat(filename + ".lock"), { code: "ENOENT" });
  }
});

test("limits never evict successful history and prevent unreserved effects", async t => {
  const { filename, ledger } = await fixture(t, { maxRecords: 1 });
  await ledger.run(action, () => "first");
  const original = await fs.readFile(filename, "utf8");
  await assert.rejects(ledger.run({ ...action, text: "second" }, () => assert.fail("full effect")), { code: "LEDGER_FULL" });
  assert.equal(await fs.readFile(filename, "utf8"), original);
  assert.equal((await ledger.run(action, () => assert.fail("history evicted"))).result, "first");
  const small = new ActionLedger({ accountID: "alice", maxBytes: 20 });
  await assert.rejects(small.run(action, () => assert.fail("oversized reservation effect")), { code: "LEDGER_FULL" });
  const oversized = new ActionLedger({ path: filename, accountID: "alice", maxBytes: 20 });
  await assert.rejects(oversized.run(action, () => assert.fail("oversized file effect")), { code: "LEDGER_FULL" });
});

test("unserializable or oversized results remain unknown after effects", async t => {
  const { filename, ledger } = await fixture(t, { maxBytes: 1000 });
  let effects = 0;
  await assert.rejects(ledger.run(action, () => { effects++; return "x".repeat(2000); }), { code: "LEDGER_PERSIST_FAILED", ledgerStatus: "unknown" });
  const reloaded = new ActionLedger({ path: filename, accountID: "alice" });
  assert.equal((await reloaded.run(action, () => { effects++; })).status, "unknown");
  assert.equal(effects, 1);
  const circular = {}; circular.self = circular;
  const second = { ...action, text: "circular" };
  await assert.rejects(reloaded.run(second, () => circular), { ledgerStatus: "unknown" });
  assert.equal((await ledger.run(second, () => assert.fail("serialization replay"))).status, "unknown");
});

test("inspection and read-only reconciliation recover unknown only on positive account-scoped evidence", async t => {
  const { filename, ledger } = await fixture(t);
  assert.equal((await ledger.status(action)).status, "absent");
  await assert.rejects(ledger.run(action, () => { throw new Error("lost response"); }));
  const recovered = new ActionLedger({ path: filename, accountID: "alice" });
  const negative = await recovered.reconcile(action, async (normalized, view) => {
    assert.equal(normalized.accountID, "alice");
    assert.equal(view.status, "unknown");
    await assert.rejects(fs.open(filename + ".lock", "wx"), { code: "EEXIST" });
    return { source: "server", matched: false, coverage: { exhausted: true } };
  });
  assert.equal(negative.status, "unknown");
  assert.equal((await recovered.run(action, () => assert.fail("negative replay"), { retrySafe: true })).status, "unknown");
  assert.equal((await recovered.reconcile(action, () => ({ source: "local", matched: true }))).status, "unknown");
  const positive = await recovered.reconcile(ledger.key(action), () => ({ source: "server", matched: true, result: { existingID: "remote" } }));
  assert.equal(positive.status, "completed");
  assert.equal(positive.reconciled, true);
  positive.record.action.text = "changed snapshot";
  assert.equal((await ledger.inspect(action)).record.action.text, action.text);
  const other = new ActionLedger({ path: filename, accountID: "bob" });
  await assert.rejects(other.inspect(ledger.key(action)), { code: "LEDGER_ACCOUNT_MISMATCH" });
  await assert.rejects(other.reconcile(ledger.key(action), () => assert.fail("foreign resolver")), { code: "LEDGER_ACCOUNT_MISMATCH" });
  assert.equal((await other.reconcile(action, () => assert.fail("absent resolver"))).status, "absent");
});

test("reconciliation of crashed reservation never turns a negative scan into permission to retry", async t => {
  const { filename, ledger } = await fixture(t);
  const child = childRun(filename, "alice", true);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, "message");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await fs.unlink(filename + ".lock");
  assert.equal((await ledger.reconcile(action, () => ({ source: "server", matched: false }))).status, "unknown");
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).records[ledger.key(action)].status, "unknown");
});
