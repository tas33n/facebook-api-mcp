"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("release selection separates prereleases and validates version tags", async () => {
  const { releaseMetadata } = await import("../scripts/check-version.mjs");
  const pkg = { name: "facebook-api-mcp", version: "3.5.0-rc.2" };
  assert.equal(releaseMetadata(pkg, {}).dist_tag, "next");
  assert.equal(releaseMetadata({ ...pkg, version: "3.5.0" }, {}).dist_tag, "latest");
  assert.throws(() => releaseMetadata(pkg, { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v3.5.0" }), /Git tag/);
  assert.throws(() => releaseMetadata({ ...pkg, private: true }, {}), /private/);
});

test("registry check skips existing versions and only treats 404 as unpublished", async () => {
  const { checkVersion } = await import("../scripts/check-version.mjs");
  const pkg = { name: "facebook-api-mcp", version: "3.5.0-rc.2" };
  assert.equal((await checkVersion(pkg, {}, async () => ({ status: 404 }))).should_publish, "true");
  assert.equal((await checkVersion(pkg, {}, async () => ({ status: 200, ok: true, json: async () => pkg }))).should_publish, "false");
  await assert.rejects(checkVersion(pkg, {}, async () => ({ status: 503, ok: false })), /503/);
  await assert.rejects(checkVersion(pkg, {}, async () => { throw new Error("network unavailable"); }), /network/);
});
