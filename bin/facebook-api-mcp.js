#!/usr/bin/env node
"use strict";

const { Writable } = require("node:stream");
const path = require("node:path");

// Capture the protocol stream before loading legacy modules, some of which use
// console.log or direct stdout writes. Only the SDK receives this writable.
const protocolWrite = process.stdout.write.bind(process.stdout);
const diagnosticWrite = process.stderr.write.bind(process.stderr);
const protocolOutput = new Writable({
  write(chunk, encoding, callback) { protocolWrite(chunk, encoding, callback); }
});

// Upstream diagnostics can contain cookie jars and request bodies. Suppress them
// in this standalone process and emit only fixed, credential-free diagnostics.
function discard(chunk, encoding, callback) {
  if (typeof encoding === "function") encoding();
  else if (typeof callback === "function") callback();
  return true;
}
process.stdout.write = discard;
process.stderr.write = discard;

function diagnostic(message) { diagnosticWrite(`[facebook-api-mcp] ${message}\n`); }

async function main() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && (minor < 18 || (minor === 18 && patch < 1)))) throw new Error("NODE_VERSION");
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    diagnostic("Usage: facebook-api-mcp [--app-state PATH] [--listen] [--notifications]. Or set FACEBOOK_APP_STATE_PATH. Node 20.18.1+ is required.");
    return;
  }
  let appStatePath = process.env.FACEBOOK_APP_STATE_PATH;
  let listen = false;
  let notifications = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app-state" && argv[i + 1] && !argv[i + 1].startsWith("--")) appStatePath = argv[++i];
    else if (argv[i] === "--listen") listen = true;
    else if (argv[i] === "--notifications") notifications = true;
    else throw new Error("ARGUMENTS");
  }
  if (!appStatePath) throw new Error("APP_STATE_REQUIRED");
  const { startStdioServer, createEventBuffer, disposeApi } = require("../lib/mcp");
  const login = require("../index");
  let api;
  let host;
  let eventBuffer;
  let notificationListener;
  let ending = false;
  let shutdownPromise;
  async function shutdown(code = 0) {
    if (shutdownPromise) return shutdownPromise;
    ending = true;
    process.exitCode = code;
    // Legacy HTTP/MQTT work cannot always be cancelled; bound process shutdown.
    const deadline = setTimeout(() => process.exit(process.exitCode || 0), 5000);
    deadline.unref();
    shutdownPromise = (async () => {
      try {
        if (notificationListener) await notificationListener.stopListeningAsync();
        if (host) await host.close();
        else if (api) await disposeApi(api);
      } catch (_) { process.exitCode = 1; diagnostic("Session cleanup failed."); }
      finally { eventBuffer?.close(); if (api) process.exit(process.exitCode || 0); }
    })();
    return shutdownPromise;
  }
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.stdin.once("end", () => { void shutdown(); });
  process.stdin.once("error", () => { void shutdown(1); });
  protocolOutput.once("error", () => { void shutdown(1); });
  process.once("uncaughtException", () => { diagnostic("Unexpected runtime error."); void shutdown(1); });
  process.once("unhandledRejection", () => { diagnostic("Unexpected asynchronous error."); void shutdown(1); });
  try {
    api = await login({ appStatePath: path.resolve(appStatePath) }, {
      ...(process.env.FACEBOOK_ACTION_LEDGER_PATH ? { actionLedgerPath: path.resolve(process.env.FACEBOOK_ACTION_LEDGER_PATH) } : {}),
      logLevel: "silent", online: false, autoMarkRead: false, autoMarkDelivery: false,
      updatePresence: false, listenEvents: listen, autoTyping: false
    });
    if (ending) { await disposeApi(api); return; }
    const secretValues = typeof api.getAppState === "function"
      ? api.getAppState().filter(cookie => !["c_user", "i_user"].includes(cookie.key))
        .map(cookie => cookie.value).filter(value => typeof value === "string") : [];
    if (listen || notifications) eventBuffer = createEventBuffer({ secretValues });
    if (listen) {
      if (typeof api.listenMqtt !== "function") throw new Error("LISTENER_UNAVAILABLE");
      api.listenMqtt((error, event) => {
        if (error) {
          eventBuffer.publishError(error, "mqtt");
          diagnostic("Messenger listener reported an error; recorded in the event buffer.");
        }
        if (event !== undefined && event !== null) eventBuffer.publish(event, "mqtt");
      });
    }
    if (notifications) {
      notificationListener = api.listenNotifications({ intervalMs: 60000 }, (error, event) => {
        if (error) eventBuffer.publishError(error, "notifications");
        if (event != null) eventBuffer.publish(event, "notifications");
      });
    }
    host = await startStdioServer({ api, secretValues, eventBuffer, output: protocolOutput, signals: false, dispose: disposeApi });
    diagnostic("Ready.");
  } catch (_) {
    diagnostic("Startup failed. Check the cookie file, session validity and installed MCP dependencies.");
    await shutdown(1);
  }
}

main().catch(() => {
  diagnostic("Configuration error. Use --help; provide a cookie file via --app-state or FACEBOOK_APP_STATE_PATH.");
  process.exitCode = 1;
});
