"use strict";
const { EventEmitter } = require("node:events");
const { walk } = require("./WebDiscovery");
const { operationError } = require("./OperationRegistry");

function extractNotifications(scripts, limit) {
  const connections = [];
  walk(scripts, node => {
    // Only explicit notification connections qualify. Empty parsed HTML is not
    // evidence that an account has zero notifications.
    for (const key of ["notifications_page", "notifications_connection"]) {
      if (Array.isArray(node[key]?.edges)) connections.push(node[key]);
    }
  });
  if (!connections.length) throw operationError("NOTIFICATIONS_UNAVAILABLE", "No supported notification connection was returned by this account's web page");
  const seen = new Set();
  const items = [];
  for (const connection of connections) for (const edge of connection.edges) {
    const node = edge?.node?.notif || edge?.node;
    if (!node?.id || seen.has(String(node.id))) continue;
    seen.add(String(node.id));
    const body = node.body?.text || node.title?.text || node.message?.text || null;
    items.push({ id: String(node.id), text: body, url: typeof node.url === "string" ? node.url : null,
      timestamp: node.creation_time ?? null, unread: typeof node.seen_state === "string" ? node.seen_state === "UNSEEN_AND_UNREAD" : null });
  }
  return { items: items.slice(0, limit), pageInfo: { hasMore: items.length > limit || connections.some(c => c.page_info?.has_next_page === true), endCursor: null,
    coverage: "Initial embedded notification page only; no pagination request is implemented" } };
}

function listen(fetchPage, options = {}, callback) {
  const intervalMs = options.intervalMs ?? 60000;
  const maxSeen = options.maxSeen ?? 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 10000 || intervalMs > 3600000) throw operationError("INVALID_ARGUMENT", "intervalMs must be 10000..3600000");
  if (!Number.isInteger(maxSeen) || maxSeen < 100 || maxSeen > 10000) throw operationError("INVALID_ARGUMENT", "maxSeen must be 100..10000");
  const emitter = new EventEmitter();
  const seen = new Map();
  let timer, stopped = false, first = true, inFlight;
  const notify = (error, value) => {
    if (typeof callback === "function") { try { callback(error, value); } catch (_) { /* Consumer errors must not restart polling. */ } }
    if (error) { if (emitter.listenerCount("error")) emitter.emit("error", error); }
    else emitter.emit("notification", value);
  };
  async function poll() {
    try {
      const page = await fetchPage({ limit: 100 });
      if (stopped) return;
      for (const item of page.items) {
        if (!seen.has(item.id) && (!first || options.emitExisting === true)) notify(null, { type: "notification", ...item });
        seen.delete(item.id);
        seen.set(item.id, true);
      }
      while (seen.size > maxSeen) seen.delete(seen.keys().next().value);
      first = false;
    } catch (error) {
      if (!stopped) notify(error);
      if (["SESSION_EXPIRED", "NOTIFICATIONS_UNAVAILABLE"].includes(error.code)) stopped = true;
    } finally {
      if (!stopped) { timer = setTimeout(() => { inFlight = poll(); }, intervalMs); timer.unref?.(); }
    }
  }
  emitter.stopListeningAsync = async () => { stopped = true; clearTimeout(timer); await inFlight; };
  emitter.stopListening = cb => { const promise = emitter.stopListeningAsync(); if (typeof cb === "function") promise.then(() => cb(null), cb); return promise; };
  // Start after callers can subscribe to notification/error events.
  queueMicrotask(() => { if (!stopped) inFlight = poll(); });
  return emitter;
}
module.exports = { extractNotifications, listen };
