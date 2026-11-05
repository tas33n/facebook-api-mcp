"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { withCallback } = require("../lib/facebook/PostReader");
const { videoIdentity, normalizeVideoStatus, readOptions, boundedRead } = require("../lib/facebook/PublicationVerifier");

module.exports = (defaults, api, ctx) => function getVideoStatus(target, options = {}, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    const videoID = videoIdentity(target), parsed = readOptions(options);
    const data = await boundedRead(() => createGraphQLClient(defaults, ctx).request("CometWatchAndScrollVideoQuery",
      { videoID, chainingSeedVideoID: videoID, scale: 1, chainingDisabled: true }, { allowIncremental: true }),
    Date.now() + parsed.timeoutMs, parsed.signal);
    return normalizeVideoStatus(data, videoID);
  });
  return withCallback(promise, callback);
};
