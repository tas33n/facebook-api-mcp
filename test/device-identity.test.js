"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function freshUtils() {
  delete require.cache[require.resolve("../utils")];
  return require("../utils");
}

test("getGUID keeps one device identity per process when the device file cannot be written", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-device-"));
  const blocker = path.join(directory, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const previous = process.env.FACEBOOK_DEVICE_FILE;
  process.env.FACEBOOK_DEVICE_FILE = path.join(blocker, "facebook-device.json");
  try {
    const utils = freshUtils();
    const first = utils.getGUID();
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(utils.getGUID(), first, "reconnects must reuse the same device id");
  } finally {
    if (previous === undefined) delete process.env.FACEBOOK_DEVICE_FILE;
    else process.env.FACEBOOK_DEVICE_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getGUID persists the device identity and reloads it in a new process", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-device-"));
  const previous = process.env.FACEBOOK_DEVICE_FILE;
  process.env.FACEBOOK_DEVICE_FILE = path.join(directory, "facebook-device.json");
  try {
    const created = freshUtils().getGUID();
    assert.equal(JSON.parse(fs.readFileSync(process.env.FACEBOOK_DEVICE_FILE, "utf8")).guid, created);
    assert.equal(freshUtils().getGUID(), created);
  } finally {
    if (previous === undefined) delete process.env.FACEBOOK_DEVICE_FILE;
    else process.env.FACEBOOK_DEVICE_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
