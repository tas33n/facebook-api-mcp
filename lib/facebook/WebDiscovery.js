"use strict";

const { getRegistry, operationError } = require("./OperationRegistry");

function parseScripts(html) {
  const results = [];
  const pattern = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try { results.push(JSON.parse(match[1])); } catch (_) { /* Non-JSON scripts are excluded. */ }
  }
  return results;
}

function walk(root, visit, maxNodes = 100000) {
  const stack = [root];
  let examined = 0;
  while (stack.length) {
    if (++examined > maxNodes) throw operationError("RESPONSE_TOO_LARGE", "Embedded data exceeds traversal limit");
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    visit(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") stack.push(child);
  }
}

function checkPage(response) {
  const url = String(response.url || "");
  const html = String(response.body || "");
  if (/\/(?:login|checkpoint)(?:[/.?]|$)/i.test(url) || /id=["']login_form["']|name=["']pass["']/i.test(html)) {
    throw operationError("SESSION_EXPIRED", "Facebook requires login or checkpoint verification");
  }
  if (response.statusCode !== 200) throw operationError("HTTP_ERROR", `Facebook returned HTTP ${response.statusCode}`);
  return html;
}

function resourceURLs(html) {
  const urls = new Set();
  const decoded = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  for (const match of decoded.matchAll(/https:\/\/[A-Za-z0-9.-]+\/(?:[^"'\s<>\\]+)\.js(?:\?[^"'\s<>\\]*)?/g)) {
    const url = new URL(match[0]);
    if (url.hostname.endsWith(".fbcdn.net") && !url.username && !url.password) urls.add(url.href);
  }
  return [...urls];
}

function createWebDiscovery(defaultFuncs, ctx) {
  return {
    async page(path) {
      const url = new URL(path, "https://www.facebook.com");
      if (url.origin !== "https://www.facebook.com" || url.username || url.password) throw operationError("INVALID_ARGUMENT", "Expected a www.facebook.com page");
      // makeDefaults.get adds __a=1 and returns an AJAX envelope, not a page.
      const response = await require("../../utils").get(url.href, ctx.jar, null, ctx.globalOptions, ctx);
      const html = checkPage(response);
      getRegistry(ctx).discover(html);
      return { html, scripts: parseScripts(html), resourceURLs: resourceURLs(html) };
    },
    async discover(path = "/", options = {}) {
      const maxResources = options.maxResources ?? 12;
      if (!Number.isInteger(maxResources) || maxResources < 0 || maxResources > 50) throw operationError("INVALID_ARGUMENT", "maxResources must be between 0 and 50");
      const page = await this.page(path);
      const registry = getRegistry(ctx);
      const operations = [];
      let loaded = 0;
      const got = require("got");
      for (const url of page.resourceURLs.slice(0, maxResources)) {
        // CDN requests intentionally use no authentication cookies.
        const response = await got(url, { timeout: { request: 15000 }, retry: 0, followRedirect: false,
          maxResponseSize: 16 * 1024 * 1024, throwHttpErrors: false });
        if (response.statusCode !== 200) continue;
        loaded++;
        operations.push(...registry.discover(response.body));
      }
      return { operations, resourcesExamined: loaded, resourcesFound: page.resourceURLs.length,
        coverage: "Only Relay params in the selected page and bounded static resources; not runtime verification" };
    },
  };
}

module.exports = { createWebDiscovery, parseScripts, walk, checkPage, resourceURLs };
