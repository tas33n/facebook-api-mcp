"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { searchOptions, searchVariables, normalizeSearch } = require("../lib/facebook/PostDiscovery");

module.exports = (defaults, api, ctx) => (options = {}, callback) => {
  const promise = Promise.resolve().then(async () => {
    const parsed = searchOptions(options);
    const name = parsed.cursor ? "SearchCometResultsPaginatedResultsQuery" : "SearchCometResultsInitialResultsQuery";
    const data = await createGraphQLClient(defaults, ctx).request(name, searchVariables(parsed), { allowIncremental: true });
    return normalizeSearch(data, parsed);
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
};
