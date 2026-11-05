"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const metadata = require("../package.json");
let manifest;

function packManifest() {
  if (manifest) return manifest;
  // npm.cmd needs a shell on Windows. The command contains no user-controlled
  // arguments; package lifecycle scripts are deliberately disabled.
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root, encoding: "utf8", shell: process.platform === "win32",
      timeout: 60000, maxBuffer: 8 * 1024 * 1024
    });
  assert.ifError(result.error);
  assert.equal(result.status, 0, "npm pack dry run must succeed");
  [manifest] = JSON.parse(result.stdout);
  return manifest;
}

test("npm publication excludes session/config files and raw research artifacts", () => {
  const forbidden = packManifest().files.map(file => file.path).filter(file =>
    /(^|\/)(?:config|secrets?|sessions?|cookies?|node_modules|reports?|captures?|raw)(?:\/|$)/i.test(file) ||
    /(^|\/)\.env(?:\.|$)/i.test(file) ||
    /^docs\/.*\.json$/i.test(file) ||
    /\.(?:apk|apkm|aab|apks|xapk|dex|har|pem|key|p12|pfx|log|heapsnapshot|bak|backup)$/i.test(file) ||
    /(?:app.?state|cookies?|credentials?|secrets?|session|checkpoint|ledger|report|verification|discovery|capture|audit)[^/]*\.(?:json|jsonl|txt|csv|zip)$/i.test(file));
  // Check manifest paths only: never open or print real local credentials.
  assert.deepEqual(forbidden, [], "private state and raw reports must not be published");
});

test("published entry points and lockfile agree with package metadata", () => {
  const packed = packManifest();
  const files = new Set(packed.files.map(file => file.path));
  assert.equal(packed.name, metadata.name);
  assert.equal(metadata.name, "facebook-api-mcp", "Use the owner-selected published identity");
  assert.equal(packed.version, metadata.version);
  for (const file of [metadata.main, metadata.types, ...Object.values(metadata.bin)]) {
    assert.ok(files.has(file), `Published entry point is missing: ${file}`);
  }
  assert.ok(files.has("LICENSE"), "MIT license text must accompany the package");
  for (const file of fs.readdirSync(path.join(root, "src")).filter(file => file.endsWith(".js"))) {
    assert.ok(files.has(`src/${file}`), `Active source missing from npm package: ${file}`);
  }
  for (const file of ["README.md", "CHANGELOG.md", "ATTRIBUTION.md", "docs/API_REFERENCE.md",
    "docs/SETUP.md", "docs/MCP.md", "docs/AGENT_INTEGRATION.md", "examples/cookie-login.js", "examples/discover-posts.js", "examples/mcp-client.json"]) {
    assert.ok(files.has(file), `Public release documentation/example missing: ${file}`);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const key of ["name", "version", "dependencies", "engines", "bin"]) {
    assert.deepEqual(lock.packages[""][key], metadata[key], `Lockfile root differs for ${key}`);
  }
});

test("MQTT dependency supports the legacy stream constructor, MQTT 3 handshake and publish offline", { timeout: 10000 }, async () => {
  const { Duplex } = require("node:stream");
  const { once } = require("node:events");
  const { createRequire } = require("node:module");
  const mqtt = require("mqtt");
  const packet = createRequire(require.resolve("mqtt"))("mqtt-packet");
  const parser = packet.parser();
  const packets = [];
  let receivedPublish;
  const published = new Promise(resolve => { receivedPublish = resolve; });
  const stream = new Duplex({
    read() {},
    write(chunk, encoding, callback) { parser.parse(chunk); callback(); }
  });
  parser.on("packet", value => {
    packets.push(value);
    if (value.cmd === "connect") {
      process.nextTick(() => stream.push(packet.generate({ cmd: "connack", returnCode: 0, sessionPresent: false })));
    }
    if (value.cmd === "publish") receivedPublish(value);
  });
  const client = new mqtt.Client(() => stream, {
    clientId: "offline-package-contract", protocolId: "MQIsdp", protocolVersion: 3,
    username: "offline-fixture", clean: true, keepalive: 0, reconnectPeriod: 0,
    connectTimeout: 2000
  });
  try {
    await once(client, "connect");
    await new Promise((resolve, reject) => client.publish("/ls_req", "offline-payload", { qos: 0 },
      error => error ? reject(error) : resolve()));
    assert.equal(packets[0].protocolVersion, 3);
    assert.equal(packets[0].protocolId, "MQIsdp");
    // MQTT's callback can precede the stream's final buffered write.
    const sent = await published;
    assert.equal(sent.topic, "/ls_req");
    assert.equal(sent.payload.toString(), "offline-payload");
  } finally {
    await new Promise(resolve => client.end(true, {}, resolve));
    stream.destroy();
  }
});

test("discovery example preserves continuation and bounds locally empty pages without login", async () => {
  const { discover } = require("../examples/discover-posts");
  const calls = [];
  const api = { searchPosts: async options => {
    calls.push(options);
    return calls.length === 1
      ? { items: [], sessionID: "search-fixture", pageInfo: { hasNextPage: true, endCursor: "cursor-one" } }
      : { items: [{ postID: "123" }, { postID: "123" }], sessionID: "search-fixture",
        pageInfo: { hasNextPage: true, endCursor: "cursor-one" } };
  } };
  const pages = await discover(api, "gardening", 3);
  assert.equal(calls.length, 2, "repeated cursor must terminate pagination");
  assert.equal(calls[1].cursor, "cursor-one");
  assert.equal(calls[1].sessionID, "search-fixture");
  assert.equal(calls[1].query, calls[0].query);
  assert.deepEqual(pages[1].items, [{ postID: "123" }]);
  await assert.rejects(discover(api, "gardening", 4), RangeError);
});

test("packed runtime supports CommonJS login, API assembly and MCP cleanup offline", () => {
  const temporaryRoot = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, "facebook-api-package-"));
  const staged = path.join(temporary, "package");
  try {
    // Stage only npm's published executable files/metadata, not the checkout.
    // Existing installed dependencies are shared; no install or network needed.
    for (const { path: file } of packManifest().files) {
      if (file !== "package.json" && !/^(?:(?:lib|src|bin)\/.*|index|utils)\.js$/.test(file)) continue;
      const destination = path.join(staged, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, file), destination);
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    const expectedMethods = fs.readdirSync(path.join(root, "src"))
      .filter(file => file.endsWith(".js")).map(file => file.slice(0, -3));
    const probe = `
      const assert = require('node:assert/strict');
      const path = require('node:path');
      const staged = process.argv[1];
      const fca = require(staged);
      const { createMcpServer, disposeApi } = require(path.join(staged, 'lib/mcp'));
      assert.equal(typeof fca, 'function');
      assert.equal(fca.login, fca);
      for (const name of ['buildAPI', 'setOptions', 'logger', 'FacebookSafety', 'LoginManager', 'ApiFactory']) {
        assert.equal(typeof fca[name], 'function', name);
      }
      const options = {};
      fca.setOptions(options, { selfListen: 1 });
      assert.equal(options.selfListen, true);
      // Replace only the network login boundary. The published entry point,
      // cookie session, API factory and every active src factory remain real.
      fca.LoginManager.prototype.login = async function(state, email, password, options, jar) {
        jar.setCookie('c_user=100000000000001; Domain=facebook.com; Path=/', 'https://www.facebook.com');
        return { body: '<input name="fb_dtsg" value="offline-fixture-token">' };
      };
      async function verify(api) {
        for (const method of JSON.parse(process.argv[2])) assert.ok(method in api, 'Missing published API: ' + method);
        assert.equal(api.getCurrentUserID(), '100000000000001');
        assert.equal(api.listen, api.listenMqtt);
        assert.equal(typeof api.__chikaDispose, 'function');
        assert.equal(Object.keys(api).includes('__chikaDispose'), false);
        assert.ok(Array.isArray(api.saveSession()));
        const host = createMcpServer({ api });
        assert.ok(host.registry.tools.some(tool => tool.name === 'facebook_send_message'));
        await host.close();
        api.__chikaDispose();
      }
      (async () => {
        await verify(await fca({ appState: [] }, { cookieRefreshIntervalMs: 0 }));
        await new Promise((resolve, reject) => {
          const returned = fca({ appState: [] }, (error, api) => {
            if (error) return reject(error);
            verify(api).then(resolve, reject);
          });
          assert.equal(returned, undefined);
        });
        await new Promise((resolve, reject) => {
          const returned = fca({ appState: [] }, { cookieRefreshIntervalMs: 0 }, (error, api) => {
            if (error) return reject(error);
            verify(api).then(resolve, reject);
          });
          assert.equal(returned, undefined);
        });
        // A stdio API may be used without --listen; shutdown must also work
        // before an MQTT connection has ever existed.
        await disposeApi(await fca({ appState: [] }, { cookieRefreshIntervalMs: 0 }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ["-e", probe, staged, JSON.stringify(expectedMethods)], {
      cwd: temporary, encoding: "utf8", timeout: 30000,
      env: { ...process.env, FACEBOOK_ENABLE_BACKGROUND_SAFETY: "false" }
    });
    const cli = spawnSync(process.execPath, [path.join(staged, metadata.bin["facebook-api-mcp"]), "--help"], {
      cwd: temporary, encoding: "utf8", timeout: 10000
    });
    assert.ifError(cli.error);
    assert.equal(cli.status, 0);
    assert.equal(cli.stdout, "", "MCP CLI must reserve stdout for protocol messages");
    assert.match(cli.stderr, /Usage: facebook-api-mcp/);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Staged runtime contract failed:\n${result.stderr}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
