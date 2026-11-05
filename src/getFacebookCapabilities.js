"use strict";
const { getRegistry } = require("../lib/facebook/OperationRegistry");
module.exports = (defaults, api, ctx) => () => ({
  authentication: "web-cookie",
  features: {
    messaging: { status: "implemented", verification: "Prior live send/readback; current session read verified" },
    posts: { status: "implemented", verification: "Public image+caption and text-only posts live verified by caption, media and audience readback" },
    comments: { status: "implemented", verification: "Live comments on text/photo/video and threaded reply readback; bounded connection scans" },
    reactions: { status: "implemented", verification: "Like mutation and viewer-state readback live verified" },
    shares: { status: "implemented", verification: "Public profile share and original-content readback live verified; historical shares may be unknown" },
    search: { status: "implemented", verification: "Keyword, hashtag and cursor pagination live verified; local returned-page filters" },
    feed: { status: "implemented", verification: "News feed and own-profile cursor pagination live verified" },
    engagementDeduplication: { status: "implemented", verification: "Existing own comments/replies/Like skipped live; durable ledger blocks repeated and uncertain actions" },
    groupTimeline: { status: "implemented", verification: "Selected group regular-discussion feed and pagination live verified; excludes announcements and respects membership" },
    pageTimeline: { status: "implemented", verification: "Selected profile-plus Page and pagination live verified with delegate Page identity" },
    contentManagement: { status: "implemented", verification: "Edit/restore post and comment, delete post/comment, remove reaction and audience readback live verified" },
    publicationVerification: { status: "implemented", verification: "Verified post text/audience and video OK/story/playable readback; no mutation retries" },
    scanCheckpoints: { status: "implemented", verification: "Pending-page replay and explicit acknowledgement advancement verified live and in crash tests" },
    content: { status: "experimental", verification: "Page metadata parser; WebLite shell is unsupported" },
    notifications: { status: "implemented", verification: "Web Relay query and selected cookie-account live read; polling tested locally" },
    videoPublishing: { status: "partial", verification: "uploadVideo + publishVideoPost SELF path live verified with ready playback and feed story; publishVideo asset mutation failed 1675030" },
    reelPublishing: { status: "experimental", verification: "Observed web publishing builder and local tests; deployment placements required" },
    storyPublishing: { status: "experimental", verification: "Observed web Story transformers and local tests; no live publication readback" },
  },
  operations: getRegistry(ctx).list(),
});
