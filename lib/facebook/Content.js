"use strict";

const cheerio = require("cheerio");
const { walk, parseScripts } = require("./WebDiscovery");
const { operationError } = require("./OperationRegistry");

function contentURL(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw operationError("INVALID_ARGUMENT", "Expected a Facebook content URL"); }
  if (url.protocol !== "https:" || !["facebook.com", "www.facebook.com"].includes(url.hostname) || url.port || url.username || url.password) {
    throw operationError("INVALID_ARGUMENT", "Expected an HTTPS facebook.com content URL");
  }
  if (!/^\/(?:[^/]+\/posts\/|permalink\.php|story\.php|photo(?:\.php|\/)|watch\/?|reel\/|stories\/|[^/]+\/videos\/)/.test(url.pathname)) {
    throw operationError("INVALID_ARGUMENT", "Expected a post, photo, video, reel or story permalink");
  }
  url.hostname = "www.facebook.com";
  url.hash = "";
  return url.href;
}

function text(value) {
  return typeof value === "string" ? value : typeof value?.text === "string" ? value.text : null;
}

function contentFromHTML(html, url) {
  const $ = cheerio.load(html);
  const meta = name => $(`meta[property="${name}"], meta[name="${name}"]`).first().attr("content") || null;
  const title = meta("og:title");
  const description = meta("og:description");
  const image = meta("og:image");
  const video = meta("og:video:secure_url") || meta("og:video");
  const nodes = [];
  walk(parseScripts(html), node => {
    if (["Story", "Video", "Photo", "Reel"].includes(node.__typename) && (node.id || node.post_id)) nodes.push(node);
  });
  const idFromURL = new URL(url).pathname.match(/\/(?:posts|videos|reel|stories)\/(?:\d+\/)?(\d+)/)?.[1]
    || new URL(url).searchParams.get("story_fbid") || new URL(url).searchParams.get("v");
  // Never select an arbitrary recommended story from a page as the requested item.
  const node = idFromURL ? nodes.find(item => String(item.id) === idFromURL || String(item.post_id) === idFromURL) : null;
  if (!node && !title && !description && !video && !image) {
    throw operationError("CONTENT_UNAVAILABLE", /WebLite|WebBloks/.test(html)
      ? "This account received a WebLite/Bloks shell without extractable content"
      : "The page did not contain identifiable content metadata");
  }
  const feedback = node?.feedback;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    id: node ? String(node.post_id || node.id) : idFromURL || null,
    url, kind: /\/reel\//.test(url) ? "reel" : /\/stories\//.test(url) ? "story" : video || node?.__typename === "Video" ? "video" : node?.__typename === "Photo" ? "photo" : "post",
    text: text(node?.message) || description, title,
    media: [...(video ? [{ type: "video", url: video }] : []), ...(image ? [{ type: "image", url: image }] : [])],
    counts: { reactions: count(feedback?.reaction_count?.count), comments: count(feedback?.comment_count?.total_count), shares: count(feedback?.share_count?.count) },
    source: node ? "embedded-page-data" : "open-graph-metadata",
    coverage: "Page metadata only; unavailable fields are null; media URLs may expire",
  };
}

function analyze(content) {
  const body = content.text || "";
  return { content, analysis: {
    kind: "deterministic-text-metadata", characters: [...body].length,
    words: body.trim() ? body.trim().split(/\s+/u).length : 0,
    hashtags: [...new Set(body.match(/#[\p{L}\p{N}_]+/gu) || [])],
    links: [...new Set(body.match(/https?:\/\/[^\s<>]+/g) || [])],
    mediaCount: content.media.length,
    limitations: ["No image recognition, video transcription, sentiment inference or private analytics"],
  } };
}

module.exports = { contentURL, contentFromHTML, analyze };
