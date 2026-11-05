"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { storyIdentity, storyVariables, normalizePost, withCallback } = require("../lib/facebook/PostReader");

module.exports = (defaults, api, ctx) => function getPost(target, options = {}, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    const identity = storyIdentity(target, options);
    const data = await createGraphQLClient(defaults, ctx).request("groupsCometFetchStoryQuery", storyVariables(identity), { allowIncremental: true });
    return normalizePost(data, identity);
  });
  return withCallback(promise, callback);
};
