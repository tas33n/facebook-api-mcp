"use strict";
const login = require("../index");
const { disposeApi } = require("../lib/mcp");

async function main() {
  if (!process.env.FACEBOOK_APP_STATE_PATH) throw new Error("Set FACEBOOK_APP_STATE_PATH");
  const api = await login({ appStatePath: process.env.FACEBOOK_APP_STATE_PATH }, {
    listenEvents: true, emitReady: true, selfListen: false,
    autoMarkRead: false, autoMarkDelivery: false, online: false,
  });
  const seen = new Set();
  api.listenMqtt((error, event) => {
    if (error) return console.error(error.code || "LISTENER_FAILED");
    if (!["message", "message_reply"].includes(event.type) || event.body !== "/ping") return;
    if (seen.has(event.messageID)) return;
    seen.add(event.messageID);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    api.sendMessage("Pong!", event.threadID, undefined, event.messageID)
      .catch(error => console.error(error.code || "SEND_FAILED"));
  });
  let closing;
  const close = () => closing ||= disposeApi(api);
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { main };
