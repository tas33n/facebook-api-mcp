"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { feedbackIdentity, pagination, commentsVariables, normalizeComments, withCallback } = require("../lib/facebook/PostReader");

module.exports = (defaults, api, ctx) => function getPostComments(target, options = {}, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    pagination(options);
    const page = pagination({ ...(target && typeof target === "object" ? target : {}), ...options });
    const id = feedbackIdentity(target);
    const data = await createGraphQLClient(defaults, ctx).request("CommentsListComponentsPaginationQuery", commentsVariables(id, page), { allowIncremental: true });
    return normalizeComments(data, page.limit);
  });
  return withCallback(promise, callback);
};
