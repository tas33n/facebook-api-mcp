"use strict";
const createGraphQLClient = require("../lib/facebook/GraphQLClient");
const { pageOptions, profileVariables, normalizeConnection } = require("../lib/facebook/PostDiscovery");
const { operationError } = require("../lib/facebook/OperationRegistry");
const { withCallback } = require("../lib/facebook/PostReader");

module.exports = (defaults, api, ctx) => (pageID, options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  return withCallback(Promise.resolve().then(async () => {
    const parsed = pageOptions(options);
    const variables = profileVariables(pageID, parsed);
    const graphql = createGraphQLClient(defaults, ctx);
    const data = await graphql.request("ProfileCometTimelineFeedRefetchQuery", variables, { allowIncremental: true });
    const node = data?.node;
    let delegatePageID = null;
    if (node?.__typename === "User" && node.id === pageID) {
      const root = await graphql.request("ProfileCometTimelineListViewRootQuery", {
        userID: pageID, scale: 1, useDefaultActor: false, privacySelectorRenderLocation: "COMET_STREAM",
        referringStoryRenderLocation: null, renderLocation: "timeline", previousProfileId: null,
        __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
        __relay_internal__pv__GroupsCometGroupChatLazyLoadLastMessageSnippetrelayprovider: false,
        __relay_internal__pv__ProfileCometFeaturedHighlightsPortraitAspectRatioGKrelayprovider: true,
        __relay_internal__pv__WebPixelRatiorelayprovider: 1,
        __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
      }, { allowIncremental: true });
      const profile = root.user ?? root.node;
      if (profile?.id === pageID && typeof profile.delegate_page?.id === "string") delegatePageID = profile.delegate_page.id;
    }
    if ((node?.__typename !== "Page" && !delegatePageID) || (node.id && node.id !== pageID)) {
      throw operationError("PAGE_POSTS_UNSUPPORTED", "Timeline response does not identify the requested Page node");
    }
    const connection = node.timeline_list_feed_units ?? node.timeline_feed_units;
    if (!connection) throw operationError("PAGE_POSTS_UNSUPPORTED", "This Page does not expose a supported timeline connection");
    return { ...normalizeConnection(connection, parsed, "Page timeline", "PAGE_POSTS_UNAVAILABLE"), pageID, delegatePageID };
  }), callback);
};
