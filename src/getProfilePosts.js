"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { pageOptions, profileVariables, normalizeConnection } = require("../lib/facebook/PostDiscovery");

module.exports = (defaults, api, ctx) => (profileID, options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    const parsed = pageOptions(options);
    const variables = profileVariables(profileID, parsed);
    const data = await createGraphQLClient(defaults, ctx).request("ProfileCometTimelineFeedRefetchQuery", variables, { allowIncremental: true });
    return normalizeConnection(data?.node?.timeline_list_feed_units ?? data?.node?.timeline_feed_units, parsed, "profile timeline", "PROFILE_POSTS_UNAVAILABLE");
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
};
