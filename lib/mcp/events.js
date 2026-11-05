"use strict";

const { createSanitizer, McpToolError } = require("./safety");

function createEventBuffer({ capacity = 500, maxBytes = 2097152, secretValues = [] } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new RangeError("Invalid event capacity");
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16777216) throw new RangeError("Invalid event byte limit");
  const sanitizer = createSanitizer(secretValues);
  const entries = [];
  let cursor = 0;
  let bytes = 0;
  let dropped = 0;
  let errors = 0;
  let closed = false;
  function publish(event, source = "mqtt") {
    if (closed) throw new McpToolError("SERVER_CLOSED");
    if (!["mqtt", "notifications", "host"].includes(source)) throw new TypeError("Invalid event source");
    if (cursor === Number.MAX_SAFE_INTEGER) throw new RangeError("Event cursor exhausted");
    let data;
    try {
      data = sanitizer.sanitize(event);
      if (Buffer.byteLength(JSON.stringify(data)) > Math.min(32768, maxBytes - 512)) throw new McpToolError("RESULT_TOO_LARGE");
    } catch (_) {
      data = { type: "error", error: { code: "EVENT_REJECTED", message: "An event could not be safely represented within the buffer limits." } };
    }
    if (data?.type === "error") errors++;
    const item = { cursor: ++cursor, source, receivedAt: Date.now(), event: data };
    const size = Buffer.byteLength(JSON.stringify(item));
    entries.push({ item, size });
    bytes += size;
    while (entries.length > capacity || bytes > maxBytes) {
      bytes -= entries.shift().size;
      dropped++;
    }
    return cursor;
  }
  function publishError(_error, source = "mqtt") {
    // Provider errors can embed request bodies and tokens. Preserve occurrence,
    // source and ordering, never the unsafe provider error itself.
    return publish({ type: "error", error: { code: "LISTENER_ERROR", message: "The event source reported an error." } }, source);
  }
  function read({ after = 0, limit = 20 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || after > cursor || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new McpToolError("INVALID_INPUT");
    }
    const oldestCursor = entries[0]?.item.cursor ?? cursor + 1;
    const missed = Math.max(0, oldestCursor - after - 1);
    const items = [];
    let responseBytes = 0;
    for (const entry of entries) {
      if (entry.item.cursor <= after) continue;
      if (items.length === limit || responseBytes + entry.size > 196608) break;
      // Give every reader an independent snapshot; reads never consume events.
      items.push(JSON.parse(JSON.stringify(entry.item)));
      responseBytes += entry.size;
    }
    const nextCursor = items.length ? items[items.length - 1].cursor : Math.max(after, oldestCursor - 1);
    return { items, nextCursor, latestCursor: cursor, oldestCursor, hasMore: nextCursor < cursor,
      overflow: missed > 0, missed, droppedTotal: dropped };
  }
  function status() {
    return { state: closed ? "closed" : "open", capacity, maxBytes, size: entries.length, bytes,
      latestCursor: cursor, droppedTotal: dropped, errorCount: errors };
  }
  function close() { closed = true; }
  return { publish, publishError, read, status, close };
}

module.exports = { createEventBuffer };
