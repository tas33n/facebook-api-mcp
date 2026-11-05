"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { pageOptions, groupVariables, normalizeConnection } = require("../lib/facebook/PostDiscovery");
const { operationError } = require("../lib/facebook/OperationRegistry");
const { withCallback } = require("../lib/facebook/PostReader");

module.exports = (defaults, api, ctx) => (groupID, options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  return withCallback(Promise.resolve().then(async () => {
    const parsed = pageOptions(options);
    const variables = groupVariables(groupID, parsed);
    const data = await createGraphQLClient(defaults, ctx).request("GroupsCometFeedRegularStoriesPaginationQuery", variables, { allowIncremental: true });
    const node = data?.node;
    if ((node?.__typename && node.__typename !== "Group") || (node?.id && node.id !== groupID)) {
      throw operationError("GROUP_POSTS_UNAVAILABLE", "Response does not match the requested group");
    }
    const result = normalizeConnection(node?.group_feed, parsed, "group regular discussion", "GROUP_POSTS_UNAVAILABLE", { groupID });
    return { ...result, coverage: `${result.coverage}; announcements excluded by the regular-stories operation` };
  }), callback);
};
