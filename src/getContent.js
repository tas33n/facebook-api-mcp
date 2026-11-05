"use strict";
const { createWebDiscovery } = require("../lib/facebook/WebDiscovery");
const { contentURL, contentFromHTML } = require("../lib/facebook/Content");
module.exports = (defaults, api, ctx) => (url, callback) => {
  const promise = Promise.resolve().then(async () => {
    const canonical = contentURL(url);
    const page = await createWebDiscovery(defaults, ctx).page(canonical);
    return contentFromHTML(page.html, canonical);
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
