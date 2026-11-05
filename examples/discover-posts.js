"use strict";

const path = require("node:path");
const login = require("..");
const { disposeApi } = require("../lib/mcp");

// Read at most three pages. Empty locally filtered pages can still have a cursor.
async function discover(api, query, maxPages = 3) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) {
    throw new RangeError("maxPages must be 1..3");
  }
  const seenPosts = new Set();
  const seenCursors = new Set();
  let cursor;
  let sessionID;
  const pages = [];
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await api.searchPosts({
      query, limit: 5, types: ["text", "photo"], cursor, sessionID
    });
    const items = page.items.filter(post => {
      if (seenPosts.has(post.postID)) return false;
      seenPosts.add(post.postID);
      return true;
    });
    pages.push({ ...page, items });
    const next = page.pageInfo?.endCursor;
    if (!page.pageInfo?.hasNextPage || !next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
    sessionID = page.sessionID ?? sessionID;
  }
  return pages;
}

async function main() {
  const appStatePath = process.env.FACEBOOK_APP_STATE_PATH;
  const query = process.argv.slice(2).join(" ").trim();
  if (!appStatePath || !path.isAbsolute(appStatePath) || !query) {
    throw new Error("Set an absolute FACEBOOK_APP_STATE_PATH and supply a search query.");
  }
  const api = await login({ appStatePath }, {
    logLevel: "silent", online: false, autoMarkRead: false,
    autoMarkDelivery: false, updatePresence: false, autoTyping: false
  });
  try {
    const pages = await discover(api, query);
    // Print counts and coverage, not account-specific post bodies.
    console.log(JSON.stringify(pages.map(page => ({
      count: page.items.length, scannedCount: page.scannedCount,
      partial: page.partial, coverage: page.coverage,
      filterScope: page.filterScope, hasNextPage: page.pageInfo?.hasNextPage
    })), null, 2));
  } finally {
    await disposeApi(api);
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Discovery failed. Supply a query and a valid private cookie file.");
    process.exitCode = 1;
  });
}

module.exports = { discover };
