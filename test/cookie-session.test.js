"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const utils = require("../utils");
const { CookieSession, importCookies, snapshot, readState } = require("../lib/auth/CookieSession");

function temp(t) {
  const root = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "facebook-cookie-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("cookie round trip preserves attributes, host/path identities, and server expiry", () => {
  const jar = utils.getJar();
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  importCookies(jar, [
    { name: "xs", value: "auth", domain: ".facebook.com", path: "/", expirationDate: expiry, secure: true, httpOnly: true, sameSite: "no_restriction", hostOnly: false },
    { name: "xs", value: "host", domain: "www.facebook.com", path: "/messages", hostOnly: true, secure: true },
    { name: "xs", value: "messenger", domain: ".messenger.com", path: "/" },
    { name: "wd", value: "100x100", domain: ".facebook.com" },
    { name: "presence", value: "stale", domain: ".facebook.com" },
    { name: "expired", value: "old", domain: ".facebook.com", expires: 1 },
    { name: "other", value: "unrelated", domain: "example.com" },
    { name: "future_auth", value: "keep", domain: ".facebook.com" },
  ]);
  const cookies = snapshot(jar);
  assert.equal(cookies.length, 4);
  const auth = cookies.find(c => c.value === "auth");
  assert.equal(auth.expires, new Date(expiry * 1000).toISOString());
  assert.equal(auth.secure, true);
  assert.equal(auth.httpOnly, true);
  assert.equal(auth.sameSite, "none");
  assert.equal(cookies.find(c => c.value === "host").hostOnly, true);
  assert.ok(!jar.getCookieStringSync("http://www.facebook.com").includes("xs=auth"));
  const restored = utils.getJar();
  importCookies(restored, cookies);
  assert.deepEqual(snapshot(restored).map(({ lastAccessed, ...c }) => c), cookies.map(({ lastAccessed, ...c }) => c));
});

test("Set-Cookie honors origin, host-only scope, deletion, and domain separation", () => {
  const jar = utils.getJar();
  utils.saveCookies(jar)({ url: "https://www.facebook.com/messages/", headers: { "set-cookie": [
    "xs=new; Domain=.facebook.com; Path=/; Secure; HttpOnly",
    "local=value; Path=/messages; Secure",
  ] } });
  assert.ok(jar.getCookieStringSync("https://www.facebook.com/").includes("xs=new"));
  assert.equal(jar.getCookieStringSync("https://www.messenger.com/"), "");
  assert.ok(!jar.getCookieStringSync("https://m.facebook.com/messages/").includes("local="));
  utils.saveCookies(jar)({ url: "https://www.facebook.com/", headers: { "set-cookie": "xs=; Domain=.facebook.com; Path=/; Max-Age=0" } });
  assert.ok(!snapshot(jar).some(c => c.key === "xs"));
  assert.doesNotThrow(() => utils.saveCookies(jar)({}));
});

test("Max-Age stays anchored to receipt time through reads and reloads", () => {
  const jar = utils.getJar();
  const issued = new Date(Date.now() - 10000);
  jar.setCookie("xs=session; Domain=.facebook.com; Path=/; Max-Age=60; Secure", "https://www.facebook.com", { now: issued });
  const deadline = new Date(issued.getTime() + 60000).toISOString();
  assert.equal(snapshot(jar)[0].expires, deadline);
  jar.getCookieStringSync("https://www.facebook.com");
  jar.getCookieStringSync("https://www.facebook.com");
  const reload = utils.getJar();
  importCookies(reload, snapshot(jar));
  assert.equal(snapshot(reload)[0].expires, deadline);
  const expired = utils.getJar();
  importCookies(expired, [{ key: "xs", value: "old", domain: "facebook.com", maxAge: 10, creation: issued.toISOString(), lastAccessed: new Date(Date.now() - 20000).toISOString() }]);
  assert.deepEqual(snapshot(expired), []);
});

test("refreshFb_dtsg updates the shared token context and detects a login redirect", async t => {
  const jar = utils.getJar();
  const ctx = { jar, globalOptions: {}, loggedIn: true };
  const refresh = require("../src/refreshFb_dtsg")({}, {}, ctx);
  const get = t.mock.method(utils, "get", async () => ({ statusCode: 200, url: "https://www.facebook.com/", body: '<input name="fb_dtsg" value="new-token" />' }));
  await refresh();
  assert.equal(ctx.fb_dtsg, "new-token");
  assert.equal(ctx.ttstamp, "2" + [..."new-token"].map(c => c.charCodeAt(0)).join(""));
  get.mock.mockImplementation(async () => ({ statusCode: 200, url: "https://www.facebook.com/login/", body: "login" }));
  await assert.rejects(refresh(), { code: "SESSION_EXPIRED" });
  assert.equal(ctx.loggedIn, false);
});

test("async cookie rotation is persisted atomically and session envelope fields survive", async t => {
  const dir = temp(t);
  const file = path.join(dir, "cookies.txt"), envelope = path.join(dir, "session.json");
  fs.writeFileSync(envelope, JSON.stringify({ uid: "10001", sessionCookies: [], custom: "retain" }));
  const jar = utils.getJar();
  importCookies(jar, [{ key: "c_user", value: "10001", domain: ".facebook.com" }, { key: "xs", value: "old", domain: ".facebook.com" }]);
  const ctx = { jar, userID: "10001", appStatePath: file, globalOptions: { sessionSavePath: envelope, cookieRefreshIntervalMs: 0 } };
  const session = new CookieSession(ctx, {}, utils);
  t.after(() => session.dispose());
  await new Promise((resolve, reject) => jar.setCookie("xs=rotated; Domain=.facebook.com; Path=/; Secure; HttpOnly", "https://www.facebook.com", error => error ? reject(error) : resolve()));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(readState(file).cookies.find(c => c.key === "xs").value, "rotated");
  assert.equal(readState(envelope).data.custom, "retain");
  assert.equal(readState(envelope).cookies.find(c => c.key === "xs").value, "rotated");
  assert.ok(!fs.readdirSync(dir).some(name => name.endsWith(".tmp")));
  jar.setCookie("xs=; Domain=.facebook.com; Path=/; Max-Age=0", "https://www.facebook.com");
  session.dispose();
  assert.ok(!readState(file).cookies.some(c => c.key === "xs"));
});

test("refresh is single-flight and revoked sessions stop further refresh work", async t => {
  const jar = utils.getJar();
  let resolveRefresh, calls = 0;
  const api = { refreshFb_dtsg: () => { calls++; return new Promise(resolve => { resolveRefresh = resolve; }); } };
  const ctx = { jar, userID: "10001", loggedIn: true, globalOptions: { cookieRefreshIntervalMs: 0 } };
  const session = new CookieSession(ctx, api, utils);
  t.after(() => session.dispose());
  const first = session.refresh(), second = session.refresh();
  assert.equal(first, second);
  resolveRefresh({});
  assert.equal((await first).refreshed, true);
  assert.equal(calls, 1);
  api.refreshFb_dtsg = async () => { throw Object.assign(new Error("login required"), { code: "SESSION_EXPIRED" }); };
  await assert.rejects(session.refresh(), { code: "SESSION_EXPIRED" });
  assert.equal(ctx.loggedIn, false);
  await assert.rejects(session.refresh(), /not active/);
});

test("JSON cookie instructions process every entry without copying to Messenger", async () => {
  const jar = utils.getJar();
  const ctx = { jar, globalOptions: {} };
  await utils.parseAndCheckLogin(ctx, {})({
    statusCode: 200, url: "https://www.facebook.com/api/graphql/", headers: {},
    body: JSON.stringify({ jsmods: { require: [
      ["DTSG", "setToken", null, ["fresh-token"]],
      ["Cookie", "set", null, ["_js_xs", "fresh", 3600, "/"]],
      ["Cookie", "set", null, ["_js_fr", "routing", 3600, "/"]],
    ] } }),
  });
  assert.equal(snapshot(jar).length, 2);
  assert.equal(ctx.fb_dtsg, "fresh-token");
  assert.equal(jar.getCookieStringSync("https://www.messenger.com/"), "");
});
