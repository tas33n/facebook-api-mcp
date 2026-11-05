"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { replyIdentity, pagination, repliesVariables, normalizeComments, withCallback } = require("../lib/facebook/PostReader");

module.exports = (defaults, api, ctx) => function getCommentReplies(target, options = {}, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    pagination(options);
    const page = pagination({ ...(target && typeof target === "object" ? target : {}), ...options });
    const id = replyIdentity(target);
    const merged = { ...(target && typeof target === "object" ? target : {}), ...options };
    for (const key of ["expansionToken", "clientKey"]) if (merged[key] != null && (typeof merged[key] !== "string" || merged[key].length > 16384)) throw new TypeError(`${key} must be a bounded string`);
    const data = await createGraphQLClient(defaults, ctx).request("Depth1CommentsListPaginationQuery", repliesVariables(id, page, merged), { allowIncremental: true });
    return normalizeComments(data, page.limit, true);
  });
  return withCallback(promise, callback);
};
