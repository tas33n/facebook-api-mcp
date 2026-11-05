"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { pageOptions, feedVariables, normalizeConnection } = require("../lib/facebook/PostDiscovery");

module.exports = (defaults, api, ctx) => (options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    const parsed = pageOptions(options);
    const data = await createGraphQLClient(defaults, ctx).request("CometNewsFeedPaginationQuery", feedVariables(parsed), { allowIncremental: true });
    return normalizeConnection(data?.viewer?.news_feed, parsed, "news feed", "FEED_UNAVAILABLE");
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
};
