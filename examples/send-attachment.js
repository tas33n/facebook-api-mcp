"use strict";
const fs = require("node:fs");
const login = require("../index");
const { disposeApi } = require("../lib/mcp");

async function main() {
  const [threadID, file] = process.argv.slice(2);
  if (!threadID || !file || !process.env.FACEBOOK_APP_STATE_PATH) throw new Error("Usage: node examples/send-attachment.js THREAD_ID FILE (set FACEBOOK_APP_STATE_PATH)");
  const stream = fs.createReadStream(file);
  let api;
  try {
    api = await login({ appStatePath: process.env.FACEBOOK_APP_STATE_PATH }, { autoMarkRead: false, autoMarkDelivery: false });
    const result = await api.sendMessage({ body: "Attachment", attachment: stream }, threadID);
    console.log({ messageID: result.messageID });
  } finally { stream.destroy(); if (api) await disposeApi(api); }
}
if (require.main === module) main().catch(error => { console.error(error.code || "SEND_FAILED"); process.exitCode = 1; });
