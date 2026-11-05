"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const createScan = require("../src/scanPosts");
const { ScanCheckpoint } = require("../lib/facebook/ScanCheckpoint");
const page = (items, cursor = null) => ({ items, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });

async function fixture(t, api, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scan-checkpoint-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ctx = { userID: "123", globalOptions: {} };
  const input = { source: "feed", checkpointPath: path.join(directory, "scan.json"), ...options };
  const scan = createScan({}, api, ctx);
  return { scan, input, ctx, job: scan(input) };
}

test("page is durable before delivery; restart replays it and ack alone advances the cursor", async t => {
  const requests = [];
  const f = await fixture(t, { getFeedPosts: async options => {
    requests.push(options.cursor);
    return options.cursor ? page([{ postID: "2", text: "two" }]) : page([{ postID: "1", text: "one" }], "cursor-1");
  } });
  const first = (await f.job.next()).value;
  const disk = JSON.parse(await fs.readFile(f.input.checkpointPath, "utf8")).records.checkpoint;
  assert.equal(disk.pending.token, first.token);
  assert.equal(disk.cursor, null);
  assert.equal(disk.pagesAcknowledged, 0);
  const restart = f.scan(f.input);
  assert.deepEqual((await restart.next()).value, first);
  assert.equal(requests.length, 1);
  await restart.ack(first.token);
  await restart.ack(first.token); // Idempotent last acknowledgment.
  const second = (await restart.next()).value;
  assert.deepEqual(requests, [null, "cursor-1"]);
  await assert.rejects(restart.ack(first.token), { code: "CHECKPOINT_ACK_MISMATCH" });
  await restart.ack(second.token);
  assert.equal((await restart.next()).done, true);
  assert.equal((await restart.status()).exhausted, true);
});

test("failed read retries same cursor/session and cancellation after response retains pending results", async t => {
  let fail = true;
  const sessions = [];
  const controller = new AbortController();
  const f = await fixture(t, { searchPosts: async options => {
    sessions.push(options.sessionID);
    if (fail) throw new Error("offline");
    controller.abort();
    return { ...page([{ postID: "1" }]), sessionID: options.sessionID };
  } }, { source: "search", query: "test", signal: controller.signal });
  await assert.rejects(f.job.next(), /offline/);
  fail = false;
  await assert.rejects(f.scan(f.input).next(), { code: "ABORT_ERR" });
  assert.equal(sessions[0], sessions[1]);
  const resumed = f.scan({ ...f.input, signal: undefined });
  const pending = (await resumed.next()).value;
  assert.equal(sessions.length, 2);
  assert.equal(pending.items[0].postID, "1");
  await resumed.ack(pending.token);
});

test("fingerprints isolate account, target, filters and bounds; explicit clear invalidates old acknowledgments", async t => {
  const f = await fixture(t, { getProfilePosts: async () => page([{ postID: "1" }]) }, { source: "profile", targetID: "10", maxPages: 2 });
  const pending = (await f.job.next()).value;
  for (const change of [{ targetID: "11" }, { keywords: ["x"] }, { maxPages: 3 }]) {
    await assert.rejects(f.scan({ ...f.input, ...change }).next(), { code: "CHECKPOINT_MISMATCH" });
  }
  const foreign = createScan({}, { getProfilePosts: async () => assert.fail("foreign read") }, { userID: "456" });
  await assert.rejects(foreign(f.input).next(), { code: "CHECKPOINT_ACCOUNT_MISMATCH" });
  await f.job.clear();
  await assert.rejects(f.job.ack(pending.token), { code: "CHECKPOINT_ACK_MISMATCH" });
  assert.equal((await f.job.status()).pagesFetched, 0);
});

test("source dispatch is read-only, filters persist empty pages and page cap is per job", async t => {
  for (const source of ["feed", "profile", "page", "group", "search"]) {
    let calls = 0;
    const method = { feed: "getFeedPosts", profile: "getProfilePosts", page: "getPagePosts", group: "getGroupPosts", search: "searchPosts" }[source];
    const f = await fixture(t, { [method]: async (...args) => {
      calls++;
      if (["profile", "page", "group"].includes(source)) assert.equal(args[0], "10");
      return page([{ postID: "1", text: "no match" }], "next");
    }, engagePost: () => assert.fail("scan mutated") }, { source, targetID: "10", query: "query", keywords: ["missing"], maxPages: 1 });
    const pending = (await f.job.next()).value;
    assert.deepEqual(pending.items, []);
    await f.job.ack(pending.token);
    assert.equal((await f.scan(f.input).next()).done, true);
    assert.equal(calls, 1);
    assert.equal((await f.job.status()).exhausted, false);
  }
  assert.throws(() => createScan({}, {}, { userID: "123" })({ source: "group", targetID: "1", checkpointPath: "x" }), { code: "SCAN_SOURCE_UNAVAILABLE" });
});

test("malformed pagination and stale locks fail closed; concurrent consumers replay one pending page", async t => {
  let calls = 0;
  const f = await fixture(t, { getFeedPosts: async () => { calls++; return page([{ postID: "1" }], "next"); } });
  const values = await Promise.all([f.job.next(), f.scan(f.input).next()]);
  assert.equal(calls, 1);
  assert.equal(values[0].value.token, values[1].value.token);
  await f.job.ack(values[0].value.token);
  await assert.rejects(f.job.next(), { code: "SCAN_PAGE_INVALID" });
  assert.equal((await f.job.status()).cursor, "next");
  await fs.writeFile(f.input.checkpointPath + ".lock", "orphaned");
  await assert.rejects(f.job.status(), { code: "LEDGER_BUSY" });
  await fs.unlink(f.input.checkpointPath + ".lock");
  const before = await fs.readFile(f.input.checkpointPath, "utf8");
  await fs.writeFile(f.input.checkpointPath, "{truncated");
  await assert.rejects(f.job.next(), { code: "CHECKPOINT_CORRUPT" });
  assert.equal(await fs.readFile(f.input.checkpointPath, "utf8"), "{truncated");
  await fs.writeFile(f.input.checkpointPath, before);
  assert.equal(ScanCheckpoint.fingerprint({ b: 1, a: 2 }), ScanCheckpoint.fingerprint({ a: 2, b: 1 }));
});

test("a killed consumer resumes its durable unacknowledged page without a new server read", async t => {
  const f = await fixture(t, { getFeedPosts: async () => assert.fail("page was already fetched by killed consumer") });
  const script = `
    const scan = require(${JSON.stringify(require.resolve("../src/scanPosts"))})({}, {
      getFeedPosts: async () => (${JSON.stringify(page([{ postID: "crash-page" }], "after-crash"))})
    }, ${JSON.stringify(f.ctx)});
    scan(${JSON.stringify(f.input)}).next().then(result => {
      process.send(result.value);
      process.on("message", () => {});
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [pending] = await once(child, "message");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const resumed = (await f.job.next()).value;
  assert.deepEqual(resumed, pending);
  await f.job.ack(resumed.token);
  assert.equal((await f.job.status()).cursor, "after-crash");
});
