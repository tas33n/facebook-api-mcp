"use strict";

const path = require("node:path");
const login = require("..");
const { disposeApi } = require("../lib/mcp");

async function main() {
  const appStatePath = process.env.FACEBOOK_APP_STATE_PATH;
  if (!appStatePath || !path.isAbsolute(appStatePath)) {
    throw new Error("Set FACEBOOK_APP_STATE_PATH to an absolute private cookie-file path.");
  }
  const api = await login({ appStatePath }, {
    logLevel: "silent", online: false, autoMarkRead: false,
    autoMarkDelivery: false, updatePresence: false, autoTyping: false
  });
  try {
    console.log(JSON.stringify(api.getFacebookCapabilities(), null, 2));
  } finally {
    // Save rotations and stop local maintenance without revoking the session.
    await disposeApi(api);
  }
}

if (require.main === module) {
  main().catch(() => {
    // Provider errors can include request/session details: keep diagnostics local.
    console.error("Cookie login or cleanup failed. Check FACEBOOK_APP_STATE_PATH and session validity.");
    process.exitCode = 1;
  });
}

module.exports = { main };
