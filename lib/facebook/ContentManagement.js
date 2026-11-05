"use strict";
const createClient = require("./GraphQLClient");
const { storyIdentity, storyVariables } = require("./PostReader");
const { operationError } = require("./OperationRegistry");
const { randomUUID } = require("node:crypto");

function callback(promise, cb) {
  if (typeof cb === "function") promise.then(value => cb(null, value), cb).catch(() => {});
  return promise;
}
function client(defaults, ctx) { return createClient(defaults, ctx); }
async function readStory(graphql, identity) {
  const data = await graphql.request("groupsCometFetchStoryQuery", storyVariables(identity), { allowIncremental: true });
  if (data.node?.id) {
    const actual = storyIdentity(data.node.id);
    if (actual.postID !== identity.postID || actual.actorID !== identity.actorID) throw operationError("TARGET_MISMATCH", "Readback returned a different story");
  }
  return data;
}
function audienceRows(data) {
  const rows = [];
  walkRootStory(data.node, node => { if (node.privacy_row_input) rows.push(node.privacy_row_input); });
  return rows;
}
function walkRootStory(root, visit) {
  const seen = new Set();
  let identity;
  try { if (root?.id) identity = storyIdentity(root.id); } catch (_) {}
  function traverse(node, depth) {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 30) return;
    if (seen.size >= 50000) throw operationError("RESPONSE_TOO_LARGE", "Story traversal limit exceeded");
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(item => traverse(item, depth + 1)); return; }
    if (node !== root && node.id && (node.__typename === "Story" || node.comet_sections || node.post_id)) {
      let same = node.id === root.id;
      try { const other = storyIdentity(node.id); same ||= identity && identity.postID === other.postID && identity.actorID === other.actorID; } catch (_) {}
      if (!same) return;
    }
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (["attached_story", "shared_story", "attachments", "attachment", "comments", "recommendations"].includes(key)) continue;
      traverse(value, depth + 1);
    }
  }
  traverse(root, 0);
}
function commentID(value, postID) {
  if (typeof value !== "string" || !value || value.length > 4096) throw new TypeError("commentID is required and bounded");
  if (/^\d+$/.test(value)) {
    if (typeof postID !== "string" || !/^\d+$/.test(postID)) throw new TypeError("postID is required for numeric commentID");
    return Buffer.from(`comment:${postID}_${value}`).toString("base64");
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const match = /^comment:(\d+)_(\d+)$/.exec(decoded);
  if (!match || Buffer.from(decoded).toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new TypeError("Unrecognized comment ID");
  if (postID != null && postID !== match[1]) throw new TypeError("Comment and postID identify different posts");
  return value;
}
const actingID = ctx => String(ctx.globalOptions?.pageID || ctx.i_userID || ctx.userID);
function sameStory(left, right) { try { const a = storyIdentity(left), b = storyIdentity(right); return a.postID === b.postID && a.actorID === b.actorID; } catch (_) { return false; } }
module.exports = { callback, client, readStory, audienceRows, walkRootStory, storyIdentity, storyVariables, commentID, actingID, sameStory, operationError, randomUUID };
