"use strict";

// These IDs are retained for compatibility, not claimed to work on every account.
const HISTORICAL_WEB = Object.freeze({
  ComposerLinkAttachmentPreviewQuery: "6549975235094234",
  ComposerStoryCreateMutation: "6255089511280268",
  useCometUFICreateCommentMutation: "6993516810709754",
  CometUFIFeedbackReactMutation: "4769042373179384",
  useStoriesSendReplyMutation: "4826141330837571",
});

// Public Relay modules inspected in the shipped desktop web application on
// 2026-11-04. IDs are observed, not universal or live-mutation certification.
const OBSERVED_WEB = Object.freeze({
  ProfileCometTimelineListViewRootQuery: "28636777372668338",
  useCometUFIEditCommentMutation: "29044011328543636",
  ComposerStoryEditMutation: "28448551048157936",
  useCometFeedStoryDeleteMutation: "29100969972853465",
  GroupsCometFeedRegularStoriesPaginationQuery: "39571813942465299",
  CometUFIDeleteCommentMutation: "39893993176880625",
  CometPrivacySelectorSavePrivacyMutation: "30083489664586999",
  CometWatchAndScrollVideoQuery: "38751426284470540",
  ComposerLinkAttachmentPreviewQuery: "28969700022702460",
  CometNewsFeedPaginationQuery: "29015379188155409",
  ProfileCometTimelineFeedRefetchQuery: "28819547154404280",
  useCometUFICreateCommentMutation: "28865832786377560",
  CometUFIFeedbackReactMutation: "27646120298312844",
  groupsCometFetchStoryQuery: "29252258941075043",
  CommentsListComponentsPaginationQuery: "29013552121638010",
  Depth1CommentsListPaginationQuery: "29315530901392279",
  SearchCometResultsInitialResultsQuery: "27907150285627308",
  SearchCometResultsPaginatedResultsQuery: "28493607813672479",
  ComposerStoryCreateMutation: "40854814490784248",
  CometNotificationsDropdownQuery: "40224765217121849",
  CometNotificationsListPaginationQuery: "28637046332633815",
  MediaUploadFBDefaultServerConfigurationRetrieverQuery: "26396735533340887",
  VideoComposerVideoPublishingMutation: "28122626904057092",
  ReelComposerReelPublishMutation: "27793168930376367",
  StoriesCreateMutation: "26770527039211553",
});

function operationError(code, message) {
  return Object.assign(new Error(message), { code });
}

class OperationRegistry {
  constructor(overrides = {}) {
    this.entries = new Map(Object.entries(HISTORICAL_WEB).map(([name, docId]) => [name, {
      name, docId, transport: "web-cookie", source: "historical-web", verified: false,
    }]));
    for (const [name, docId] of Object.entries(OBSERVED_WEB)) this.register(name, { docId, source: "web-relay-observed-2026-11-04" });
    for (const [name, entry] of Object.entries(overrides)) {
      this.register(name, typeof entry === "string" ? { docId: entry } : entry);
    }
  }

  register(name, entry) {
    if (!/^[A-Za-z][A-Za-z0-9_]+$/.test(name) || !entry || !/^\d+$/.test(entry.docId)) {
      throw operationError("INVALID_OPERATION", "Operations require a name and decimal-string docId");
    }
    if (entry.transport && entry.transport !== "web-cookie") {
      throw operationError("TRANSPORT_MISMATCH", "Native-app document IDs cannot be registered for cookie requests");
    }
    this.entries.set(name, { name, docId: entry.docId, transport: "web-cookie",
      source: entry.source || "configured", verified: false });
    return this.entries.get(name);
  }

  resolve(name) {
    const entry = this.entries.get(name);
    if (!entry) throw operationError("OPERATION_UNAVAILABLE", `No web-cookie document ID is known for ${name}`);
    return { ...entry };
  }

  // Match only a Relay params object, where the name and ID belong to one request.
  // Nearby arbitrary strings or native APK numeric constants are not evidence.
  discover(source) {
    if (typeof source !== "string") return [];
    const found = [];
    const objects = source.matchAll(/\{\s*(?:"?cacheID"?\s*:\s*"[^"]*"\s*,\s*)?"?id"?\s*:\s*"(\d+)"\s*,\s*"?metadata"?\s*:\s*\{\s*\}\s*,\s*"?name"?\s*:\s*"([A-Za-z][A-Za-z0-9_]+)"\s*,\s*"?operationKind"?\s*:\s*"(query|mutation)"/g);
    for (const match of objects) {
      const entry = this.register(match[2], { docId: match[1], source: "web-relay-params" });
      found.push({ ...entry, kind: match[3] });
    }
    return found;
  }

  list() { return [...this.entries.values()].map(entry => ({ ...entry })); }
}

function getRegistry(ctx) {
  if (!ctx.facebookOperations) ctx.facebookOperations = new OperationRegistry(ctx.globalOptions?.facebookOperations);
  return ctx.facebookOperations;
}

module.exports = { OperationRegistry, getRegistry, operationError };
