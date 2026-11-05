"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { extractNotifications } = require("../lib/facebook/Notifications");
module.exports = (defaults, api, ctx) => (options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(async () => {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be 1..100");
    if (options.cursor != null && (typeof options.cursor !== "string" || options.cursor.length > 4096)) throw new TypeError("cursor must be a bounded string");
    const variables = { count: limit, environment: "MAIN_SURFACE", scale: 1 };
    if (options.cursor) Object.assign(variables, { cursor: options.cursor, filter_tokens: [], notif_cache_ids: [], notif_query_flags: ["IS_COMET", "INCLUDE_WA_P2B_NOTIFS"] });
    const data = await createGraphQLClient(defaults, ctx).request(options.cursor ? "CometNotificationsListPaginationQuery" : "CometNotificationsDropdownQuery", variables);
    const result = extractNotifications([data], limit);
    const info = data.viewer?.notifications_page?.page_info;
    result.pageInfo = { hasMore: info?.has_next_page === true, endCursor: typeof info?.end_cursor === "string" ? info.end_cursor : null, coverage: "GraphQL notification connection" };
    return result;
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
