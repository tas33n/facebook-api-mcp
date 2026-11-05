"use strict";

const { randomUUID } = require("node:crypto");
const { ScanCheckpoint } = require("../lib/facebook/ScanCheckpoint");
const { filterPosts, pageOptions, searchOptions } = require("../lib/facebook/PostDiscovery");
const fail = (code, message) => Object.assign(new Error(message), { code });

/** scanPosts({source, targetID?, checkpointPath, maxPages=10, ...readOptions,
 * signal?}) returns an async-iterable job with next(), ack(token), status(), clear().
 * Pages must be explicitly acked AFTER processing. next/resume redelivers pending
 * pages until ack; break/return only cancels this iterator. clear resets this scan
 * job, never the action ledger. Retry read errors by calling next() again.
 */
module.exports = (defaults, api, ctx) => function scanPosts(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw fail("INVALID_ARGUMENT", "Scan options are required");
  const { source, targetID, checkpointPath, maxPages = 10, signal, ...readOptions } = options;
  const methods = { search: "searchPosts", feed: "getFeedPosts", profile: "getProfilePosts", page: "getPagePosts", group: "getGroupPosts" };
  if (!Object.prototype.hasOwnProperty.call(methods, source)) throw fail("INVALID_ARGUMENT", "source must be search, feed, profile, page or group");
  if (typeof api[methods[source]] !== "function") throw fail("SCAN_SOURCE_UNAVAILABLE", `${methods[source]} is unavailable at runtime`);
  if (["profile", "page", "group"].includes(source) && (typeof targetID !== "string" || !/^\d+$/.test(targetID))) {
    throw fail("INVALID_ARGUMENT", "targetID must be a decimal-string ID");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw fail("INVALID_ARGUMENT", "maxPages must be 1..1000");
  const parsed = source === "search" ? searchOptions(readOptions) : pageOptions(readOptions);
  // Do not fingerprint a generated session: restarts recover it from disk.
  const configuration = { source, targetID: targetID ?? null, maxPages, ...parsed,
    sessionID: readOptions.sessionID ?? null, actingID: ctx.globalOptions?.pageID || ctx.i_userID || ctx.userID };
  const checkpoint = new ScanCheckpoint({ path: checkpointPath, accountID: ctx.userID,
    fingerprint: ScanCheckpoint.fingerprint(configuration), initialCursor: parsed.cursor,
    sessionID: source === "search" ? parsed.sessionID || randomUUID() : null });
  let stopped = false;
  const job = {
    async next() {
      if (stopped) return { done: true, value: undefined };
      return checkpoint.next(async ({ cursor, sessionID }) => {
        const request = { ...parsed, cursor, ...(source === "search" ? { sessionID } : {}) };
        const page = ["profile", "page", "group"].includes(source) ?
          await api[methods[source]](targetID, request) : await api[methods[source]](request);
        if (!Array.isArray(page?.items) || page.items.length > 100) throw fail("SCAN_PAGE_INVALID", "Invalid source page");
        return { ...page, items: filterPosts(page.items, parsed), source,
          coverage: page.coverage || "Bounded visible server pages with local filters; not a complete historical inventory" };
      }, { maxPages, signal });
    },
    ack: token => checkpoint.ack(token),
    status: () => checkpoint.status(),
    clear: () => checkpoint.clear(),
    async return() { stopped = true; return { done: true, value: undefined }; },
    [Symbol.asyncIterator]() { return this; },
  };
  return job;
};
