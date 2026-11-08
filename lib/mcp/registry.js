"use strict";

const { z } = require("zod");
const { invoke } = require("./invoke");
const { createSanitizer, McpToolError, errorResult } = require("./safety");
const { timestamp: postTimestamp } = require("../facebook/PostReader");

const id = z.string().regex(/^[0-9]{1,32}$/, "Expected a decimal Facebook ID");
const messageID = z.string().min(1).max(256).regex(/^[^\s\x00-\x1f]+$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limit = z.number().int().min(1).max(100).default(20);
const before = timestamp.nullable().optional().describe("Previous page's nextBefore timestamp; omit for the newest page.");
const socialID = z.string().min(1).max(256).regex(/^[A-Za-z0-9_:+/=-]+$/);
const socialText = z.string().min(1).max(20000).refine(value => value.trim().length > 0);
const reaction = z.enum(["unlike", "like", "heart", "love", "care", "haha", "wow", "sad", "angry"]);
const facebookURL = z.string().max(4096).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["facebook.com", "www.facebook.com"].includes(url.hostname)
      && !url.username && !url.password && !url.port;
  } catch (_) { return false; }
}, "Expected an HTTPS facebook.com URL").transform(value => {
  const url = new URL(value);
  url.hostname = "www.facebook.com";
  return url.href;
});
const historical = " Uses historical web operation IDs that are not live-verified.";
const experimental = " Experimental web operation; not live-verified. Uses an already staged media ID and does not upload local files.";
const boundedText = z.string().min(1).max(4096).refine(value => value.trim().length > 0);
const cursor = boundedText.optional().describe("Use the preceding pageInfo.endCursor verbatim.");
const expansionToken = z.string().max(16384).optional();
const postDate = z.union([z.number().nonnegative().max(253402300799), z.string().max(40)])
  .refine(value => postTimestamp(value) !== null, "Expected Unix seconds or an ISO date/date-time with explicit timezone");
const postFilters = {
  types: z.array(z.enum(["all", "text", "photo", "video", "reel", "mixed", "share"])).max(7).optional(),
  keywords: z.array(boundedText).max(100).optional(), keywordMode: z.enum(["any", "all"]).optional(),
  authorID: id.optional(), groupID: id.optional(), since: postDate.optional(), until: postDate.optional()
};
const postPage = { ...postFilters, limit: z.number().int().min(1).max(50).default(5), cursor };
const dateRange = input => input.since === undefined || input.until === undefined || postTimestamp(input.since) <= postTimestamp(input.until);
const searchSchema = z.object({ ...postPage, query: boundedText.optional(),
  hashtag: boundedText.refine(value => /^#?[^\s#]+$/u.test(value.trim()), "Expected a single hashtag").optional(),
  sessionID: boundedText.optional()
}).strict().refine(input => input.query !== undefined || input.hashtag !== undefined, "Supply query or hashtag")
  .refine(dateRange, "since must not be after until");
const exactPostTarget = z.union([z.object({ storyID: boundedText }).strict(), z.object({ postID: id, actorID: id }).strict()]);
const actionKey = z.string().regex(/^[a-f0-9]{64}$/, "Expected an action ledger key");
const postTarget = z.union([socialID, z.object({ postID: id, actorID: id.optional() }).strict(),
  z.object({ storyID: boundedText }).strict()]);
const getPostSchema = z.object({ target: postTarget, actorID: id.optional() }).strict().refine(input => {
  const numeric = typeof input.target === "string" ? /^[0-9]+$/.test(input.target) : "postID" in input.target;
  return !numeric || Boolean(input.actorID || (typeof input.target === "object" && input.target.actorID));
}, "A numeric postID requires actorID");
const pageCoverage = " Reads one provider page, not all results. Author/group/type/keyword/date filters apply only to that returned page. since/until are inclusive Unix seconds or ISO dates; unknown dates are excluded when filtering by date. The provider may return more than requested (maximum 100); continue with pageInfo.endCursor without truncating items.";
const engageSchema = z.object({
  action: z.enum(["comment", "reply", "reaction", "share"]), postID: id,
  actorID: id.optional().describe("Post owner's ID for reading viewer state; not an acting-account override."),
  storyID: boundedText.optional(), text: z.string().max(20000).optional(),
  parentCommentID: socialID.optional(), parentFeedbackID: boundedText.optional(), expansionToken,
  reaction: reaction.optional(), url: facebookURL.optional(), groupID: id.optional(),
  baseState: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Share audience: 1 PUBLIC (default), 2 FRIENDS, 3 SELF; group visibility is controlled by the group."),
  maxScanPages: z.number().int().min(1).max(10).optional().describe("Bounded duplicate/parent scan, default 3 pages of up to 100 comments each.")
}).strict().superRefine((input, context) => {
  const issue = message => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (["comment", "reply"].includes(input.action) && !input.text?.trim()) issue("Comments and replies require text");
  if (input.action === "reply" && !input.parentCommentID) issue("Replies require parentCommentID");
  if (input.action === "reaction" && (!input.reaction || (!input.actorID && !input.storyID))) issue("Reactions require reaction and actorID or storyID");
  if (input.action === "share" && !input.url) issue("Shares require url");
});
const storySchema = z.object({
  photoID: id.optional(), videoID: id.optional(), text: socialText.optional(),
  privacy: z.literal("current").describe("Use the account's existing Story audience settings."),
  textPresetID: id.optional(), fontID: id.optional()
}).strict().superRefine((input, context) => {
  if ([input.photoID, input.videoID, input.text].filter(value => value !== undefined).length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Supply exactly one of photoID, videoID or text" });
  }
  if (input.text !== undefined && (!input.textPresetID || !input.fontID)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text stories require textPresetID and fontID" });
  }
  if (input.text === undefined && (input.textPresetID !== undefined || input.fontID !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text formatting IDs require text" });
  }
});

function annotations(readOnly, idempotent = false, destructive = false) {
  return { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly || idempotent, openWorldHint: true };
}

function page(data, input) {
  if (!Array.isArray(data)) throw new McpToolError("INVALID_RESPONSE");
  const items = data.slice(0, input.limit);
  const times = items.map(item => Number(item?.timestamp)).filter(value => Number.isSafeInteger(value) && value > 0);
  const oldest = times.length ? Math.min(...times) : null;
  // Use the provider's before boundary verbatim. Subtracting one can skip
  // messages at the boundary; repeated IDs should be deduplicated by clients.
  const nextBefore = items.length === input.limit && oldest !== null && (input.before == null || oldest < input.before)
    ? oldest : null;
  return { items, pagination: {
    limit: input.limit, nextBefore, hasMore: items.length < input.limit ? false : null,
    cursorStalled: items.length === input.limit && nextBefore === null,
    boundary: "provider-before", deduplicateByID: true
  } };
}

function definitions(api) {
  const tools = [
    {
      name: "facebook_inspect_action", method: "reconcileAction",
      description: "Inspect one action key in the login-configured durable action ledger. Does not execute or replay an action. No ledger path is accepted.",
      schema: z.object({ key: actionKey }).strict(), annotations: annotations(true),
      args: input => [input.key, { inspectOnly: true }]
    },
    {
      name: "facebook_reconcile_action", method: "reconcileAction",
      description: "Check bounded visible server state for an existing action key and persist positive evidence to the configured ledger. Reads Facebook state and updates the local ledger only; never replays mutations. Negative or partial evidence never permits retry. No ledger path is accepted.",
      schema: z.object({ key: actionKey, actorID: id.optional(), storyID: boundedText.optional(),
        parentFeedbackID: boundedText.optional(), expansionToken, maxScanPages: z.number().int().min(1).max(10).optional() }).strict(),
      annotations: annotations(false, true), args: ({ key, ...options }) => [key, options]
    },
    {
      name: "facebook_engage_post", method: "engagePost",
      description: "Perform one comment, reply, reaction or share with durable duplicate prevention. Requires actionLedgerPath configured by the embedding login, never a tool argument. Checks existing visible server state where supported. Unknown crash outcomes never replay. Completed reactions may reserve a new revision after confirmed server-state drift; other ledger duplicates do not replay. Shares cannot guarantee detection of every historical share; inspect provenance and coverage. Share audience defaults to PUBLIC (baseState=1).",
      schema: engageSchema, discoverySchema: engageSchema.innerType?.() ?? engageSchema, annotations: annotations(false, true), args: input => [input]
    },
    {
      name: "facebook_get_post", method: "getPost",
      description: "Read normalized root-post metadata and known viewer state. target is a numeric post ID (requires its author's actorID), a supported encoded story ID, or an explicit identity object; pfbid/URL decoding is unsupported.",
      schema: getPostSchema, discoverySchema: getPostSchema.innerType?.() ?? getPostSchema, annotations: annotations(true),
      args: input => [input.target, { ...(input.actorID ? { actorID: input.actorID } : {}) }]
    },
    {
      name: "facebook_get_post_comments", method: "getPostComments",
      description: "Read one bounded visible comment page for a numeric postID. Preserve comment IDs, feedbackIDs and expansionTokens for replies; server ordering and visibility apply.",
      schema: z.object({ postID: id, limit, cursor }).strict(), annotations: annotations(true),
      args: ({ postID, ...options }) => [postID, options], publicCursors: "comments"
    },
    {
      name: "facebook_get_comment_replies", method: "getCommentReplies",
      description: "Read one bounded depth-1 reply page using the parent comment's feedbackID (not its comment ID). Forward its expansionToken and provider clientKey when available.",
      schema: z.object({ feedbackID: boundedText, limit, cursor, expansionToken, clientKey: z.string().max(16384).optional() }).strict(),
      annotations: annotations(true), args: ({ feedbackID, ...options }) => [feedbackID, options], publicCursors: "comments"
    },
    {
      name: "facebook_search_posts", method: "searchPosts",
      description: "Search posts by query and/or hashtag. Reuse returned sessionID with the cursor for the same search." + pageCoverage,
      schema: searchSchema, discoverySchema: searchSchema.innerType?.() ?? searchSchema, annotations: annotations(true), args: input => [input], publicCursors: "search"
    },
    {
      name: "facebook_get_feed_posts", method: "getFeedPosts", description: "Read the ranked news feed." + pageCoverage,
      schema: z.object(postPage).strict().refine(dateRange, "since must not be after until"), annotations: annotations(true), args: input => [input]
    },
    {
      name: "facebook_get_profile_posts", method: "getProfilePosts", description: "Read a profile timeline by numeric profileID." + pageCoverage,
      schema: z.object({ profileID: id, ...postPage }).strict().refine(dateRange, "since must not be after until"), annotations: annotations(true),
      args: ({ profileID, ...options }) => [profileID, options]
    },
    {
      name: "facebook_get_group_posts", method: "getGroupPosts", description: "Read a group's regular discussion feed; announcements are excluded." + pageCoverage,
      schema: z.object({ ...postPage, groupID: id }).strict().refine(dateRange, "since must not be after until"), annotations: annotations(true),
      args: ({ groupID, ...options }) => [groupID, options]
    },
    {
      name: "facebook_get_page_posts", method: "getPagePosts", description: "Read a supported Page timeline by numeric pageID, including profile-plus User nodes with a validated delegate_page. Returns pageID and delegatePageID; unsupported Page connections fail explicitly." + pageCoverage,
      schema: z.object({ pageID: id, ...postPage }).strict().refine(dateRange, "since must not be after until"), annotations: annotations(true),
      args: ({ pageID, ...options }) => [pageID, options]
    },
    {
      name: "facebook_delete_post", method: "deletePost", description: "Delete the exact identified post. Returns deletedStoryID and whether a subsequent read verified deletion; accepted deletion is not proof of verification.",
      schema: z.object({ target: exactPostTarget }).strict(), annotations: annotations(false, false, true), args: input => [input.target, {}]
    },
    {
      name: "facebook_edit_post", method: "editPost", description: "Replace the exact identified post's text, including clearing it with an empty string. Returns storyID, text and read-back verification.",
      schema: z.object({ target: exactPostTarget, text: z.string().max(20000) }).strict(), annotations: annotations(false, true, true), args: input => [input.target, input.text, {}]
    },
    {
      name: "facebook_delete_comment", method: "deleteCommentPost", description: "Delete a comment by encoded comment identity, or numeric commentID with postID. Optional parent feedback identity supports reply verification. verified reports bounded read-back evidence.",
      schema: z.object({ commentID: socialID, postID: id.optional(), parentFeedbackID: boundedText.optional(), expansionToken }).strict()
        .refine(input => !/^[0-9]+$/.test(input.commentID) || input.postID !== undefined, "Numeric commentID requires postID"),
      annotations: annotations(false, false, true), args: ({ commentID, ...options }) => [commentID, options]
    },
    {
      name: "facebook_edit_comment", method: "editCommentPost", description: "Replace a comment's text using its encoded identity, or numeric commentID with postID. Optional parent feedback identity supports reply verification. Returns commentID, text and bounded read-back verification.",
      schema: z.object({ commentID: socialID, text: socialText, postID: id.optional(), parentFeedbackID: boundedText.optional(), expansionToken }).strict()
        .refine(input => !/^[0-9]+$/.test(input.commentID) || input.postID !== undefined, "Numeric commentID requires postID"),
      annotations: annotations(false, true, true), args: ({ commentID, text, ...options }) => [commentID, text, options]
    },
    {
      name: "facebook_set_post_audience", method: "setPostAudience", description: "Change the exact identified post's audience to PUBLIC, FRIENDS or SELF when an editable privacy scope exists. Returns read-back verification.",
      schema: z.object({ target: exactPostTarget, audience: z.enum(["PUBLIC", "FRIENDS", "SELF"]) }).strict(),
      annotations: annotations(false, true, true), args: input => [input.target, input.audience, {}]
    },
    {
      name: "facebook_get_video_status", method: "getVideoStatus", description: "Read one video's processing status, linked story and playback URL presence. published requires OK status, a linked story and playback evidence; playback is not fetched.",
      schema: z.object({ videoID: id }).strict(), annotations: annotations(true), args: input => [input.videoID, {}]
    },
    {
      name: "facebook_verify_publication", method: "verifyPublication", description: "Perform bounded read-only publication checks for an exact post or video identity. Reports verified, pending, mismatch, unavailable or timeout; an accepted mutation alone is not publication evidence.",
      schema: z.object({ target: z.union([exactPostTarget, z.object({ videoID: id }).strict()]),
        maxAttempts: z.number().int().min(1).max(20).optional(), intervalMs: z.number().int().min(100).max(30000).optional(),
        timeoutMs: z.number().int().min(1).max(30000).default(25000), expectedText: z.string().max(20000).optional(),
        expectedMediaType: z.enum(["text", "photo", "video", "reel", "mixed", "share"]).optional(),
        expectedAudience: z.enum(["PUBLIC", "FRIENDS", "SELF"]).optional() }).strict(),
      annotations: annotations(true), args: ({ target, ...options }) => [target, options]
    },
    {
      name: "facebook_publish_post_verified", method: "publishPostVerified",
      description: "Create a text or staged-video post, then perform bounded publication checks. Audience defaults to PUBLIC; choose FRIENDS or SELF explicitly. Returns url and verification. Text posts resolve the exact returned URL in at most three visible profile pages. Unavailable or failed verification does not mean publication failed: do not republish automatically.",
      schema: z.object({ text: z.string().max(20000).optional(), videoID: id.optional(),
        audience: z.enum(["PUBLIC", "FRIENDS", "SELF"]).default("PUBLIC"),
        maxAttempts: z.number().int().min(1).max(20).optional(), intervalMs: z.number().int().min(100).max(30000).optional(),
        timeoutMs: z.number().int().min(1).max(30000).default(25000),
        expectedMediaType: z.enum(["text", "photo", "video", "reel", "mixed", "share"]).optional()
      }).strict().refine(input => Boolean(input.text?.trim() || input.videoID), "Supply nonempty text or a staged videoID"),
      annotations: annotations(false), args: ({ text, videoID, audience, ...options }) => [
        { body: text ?? "", baseState: { PUBLIC: 1, FRIENDS: 2, SELF: 3 }[audience], ...(videoID ? { videoID } : {}) },
        { ...options, expectedAudience: audience }
      ]
    },
    {
      name: "facebook_publish_video_post", method: "publishVideoPost",
      description: "Publish staged video to the profile using the live-verified composer path. Defaults to PUBLIC; explicitly select FRIENDS or SELF to override. Facebook may present short videos as Reels. Accepted does not confirm processing is complete.",
      schema: z.object({ videoID: id, description: z.string().max(20000).optional(), audience: z.enum(["PUBLIC", "FRIENDS", "SELF"]).default("PUBLIC") }).strict(),
      annotations: annotations(false), args: input => [{ videoID: input.videoID, description: input.description, baseState: { PUBLIC: 1, FRIENDS: 2, SELF: 3 }[input.audience] }]
    },
    {
      name: "facebook_create_story", method: "createStory",
      description: "Create a Story from exactly one staged photoID, staged videoID, or text. Requires privacy=current to use the account's existing Story audience. Text requires numeric-string textPresetID and fontID from the Story composer. An accepted result does not confirm publication." + experimental,
      schema: storySchema, discoverySchema: storySchema.innerType?.() ?? storySchema, annotations: annotations(false), args: input => [input]
    },
    {
      name: "facebook_publish_video", method: "publishVideo",
      description: "Publish an already staged video with optional title, description and targetID. Audience behavior is determined by the web backend; this tool exposes no audience setting." + experimental,
      schema: z.object({ videoID: id, title: z.string().max(20000).optional(), description: z.string().max(20000).optional(), targetID: id.optional() }).strict(),
      annotations: annotations(false), args: input => [input]
    },
    {
      name: "facebook_publish_reel", method: "publishReel",
      description: "Publish or draft an already staged video as a Reel. Placements default to FACEBOOK_REEL. Facebook accepts the mutation, but videos staged by uploadVideo currently stay UPLOADING; publishing a vertical video with publishVideoPost is the verified way to get a Reel. Audience behavior is determined by the web backend." + experimental,
      schema: z.object({ videoID: id, caption: z.string().max(20000).optional(),
        placements: z.array(z.string().min(1).max(128).refine(value => value.trim().length > 0)).min(1).max(20).optional(),
        draft: z.boolean().optional(), enableRemix: z.boolean().optional(), embeddable: z.boolean().optional()
      }).strict(), annotations: annotations(false), args: input => [input]
    },
    {
      name: "facebook_create_post", method: "createPost", description: "Create a text post and return its URL. Audience is explicit; group visibility is controlled by the group when groupID is supplied." + historical,
      schema: z.object({ text: socialText, audience: z.enum(["PUBLIC", "FRIENDS", "SELF"]), groupID: id.optional() }).strict(),
      annotations: annotations(false), args: input => [{ body: input.text, baseState: { PUBLIC: 1, FRIENDS: 2, SELF: 3 }[input.audience], ...(input.groupID ? { groupID: input.groupID } : {}) }]
    },
    {
      name: "facebook_create_comment", method: "createCommentPost", description: "Create a text comment on a post, optionally replying to a comment." + historical,
      schema: z.object({ postID: socialID, text: socialText, replyCommentID: socialID.optional() }).strict(),
      annotations: annotations(false), args: input => [input.text, input.postID, input.replyCommentID], callbackIndex: 2
    },
    {
      name: "facebook_set_post_reaction", method: "setPostReaction", description: "Set/remove a post reaction. Legacy mapping: heart=2, love/care=16; unlike removes it." + historical,
      schema: z.object({ postID: socialID, reaction }).strict(), annotations: annotations(false, true), args: input => [input.postID, input.reaction]
    },
    {
      name: "facebook_set_comment_reaction", method: "setCommentReaction", description: "Set/remove a comment reaction. Legacy mapping: heart=2, love/care=16; unlike removes it." + historical,
      schema: z.object({ commentID: socialID, reaction }).strict(), annotations: annotations(false, true), args: input => [input.commentID, input.reaction]
    },
    {
      name: "facebook_set_story_reaction", method: "setStoryReaction", description: "Send a story reaction/reply. This can create a reply and is not assumed idempotent." + historical,
      schema: z.object({ storyID: socialID, reaction: z.enum(["👍", "❤️", "🤗", "😆", "😮", "😢", "😡"]) }).strict(),
      annotations: annotations(false), args: input => [input.storyID, input.reaction]
    },
    {
      name: "facebook_get_capabilities", method: "getFacebookCapabilities", description: "Read implemented Facebook feature capabilities and verification metadata without making a live health probe.",
      schema: z.object({}).strict(), annotations: annotations(true), synchronous: true, args: () => []
    },
    {
      name: "facebook_get_notifications", method: "getNotifications", description: "Read one bounded GraphQL notification page. Pass pageInfo.endCursor as cursor when pageInfo.hasMore is true. This provider path was live-verified for a selected cookie account, not every account.",
      schema: z.object({ limit, cursor: z.string().min(1).max(4096).optional().describe("Genuine endCursor returned by the previous notification page.") }).strict(),
      annotations: annotations(true), synchronous: true, args: input => [input],
      transform: (data, input) => {
        if (!data || !Array.isArray(data.items)) throw new McpToolError("INVALID_RESPONSE");
        return { items: data.items.slice(0, input.limit), pageInfo: data.pageInfo ?? null };
      }
    },
    {
      name: "facebook_get_content", method: "getContent", description: "Read normalized content metadata from an HTTPS facebook.com URL.",
      schema: z.object({ url: facebookURL }).strict(), annotations: annotations(true), args: input => [input.url]
    },
    {
      name: "facebook_analyze_content", method: "analyzeContent", description: "Read deterministic metadata and counts for Facebook content. This performs no AI vision or image/video interpretation.",
      schema: z.object({ url: facebookURL }).strict(), annotations: annotations(true), args: input => [input.url]
    },
    {
      name: "facebook_get_current_user", method: "getCurrentUserID", description: "Get the active Facebook user ID without returning session cookies.",
      schema: z.object({}).strict(), annotations: annotations(true), args: () => [], synchronous: true
    },
    {
      name: "facebook_get_thread_info", method: "getThreadInfo", description: "Read metadata for one Messenger thread.",
      schema: z.object({ threadID: id }).strict(), annotations: annotations(true), args: input => [input.threadID]
    },
    {
      name: "facebook_list_threads", method: "getThreadList", description: "Read one bounded page of Messenger threads. Pass pagination.nextBefore to continue; deduplicate thread IDs across pages.",
      schema: z.object({ limit, before, tags: z.array(z.enum(["INBOX", "ARCHIVED", "PENDING", "OTHER"])).min(1).max(4).default(["INBOX"]) }).strict(),
      annotations: annotations(true), args: input => [input.limit, input.before ?? null, input.tags], transform: page
    },
    {
      name: "facebook_get_thread_history", method: "getThreadHistory", description: "Read one bounded page of thread messages. Pass pagination.nextBefore to continue; deduplicate message IDs across pages. A null hasMore means the provider does not report whether another page exists.",
      schema: z.object({ threadID: id, limit, before }).strict(), annotations: annotations(true),
      args: input => [input.threadID, input.limit, input.before ?? null], transform: page
    },
    {
      name: "facebook_get_message", method: "getMessage", description: "Read a single message in a thread.",
      schema: z.object({ threadID: id, messageID }).strict(), annotations: annotations(true), args: input => [input.threadID, input.messageID]
    },
    {
      name: "facebook_get_user_info", method: "getUserInfo", description: "Read public Messenger profile metadata for up to 50 user IDs.",
      schema: z.object({ userIDs: z.array(id).min(1).max(50) }).strict(), annotations: annotations(true), args: input => [input.userIDs]
    },
    {
      name: "facebook_send_message", method: "sendMessage", description: "Send a text message, optionally replying to a message. This creates a message and is not idempotent.",
      schema: z.object({ threadID: id, text: z.string().min(1).max(20000), replyToMessageID: messageID.optional() }).strict(),
      annotations: annotations(false), args: input => [input.text, input.threadID, input.replyToMessageID], callbackIndex: 2
    },
    {
      name: "facebook_edit_message", method: "editMessage", description: "Request replacement text for an owned message over MQTT. Experimental: acknowledgement is not verification; legacy history may still return original text.",
      schema: z.object({ messageID, text: z.string().min(1).max(20000) }).strict(),
      annotations: annotations(false, true, true), args: input => [input.text, input.messageID]
    },
    {
      name: "facebook_unsend_message", method: "unsendMessage", description: "Unsend a message owned by the current account for the conversation participants.",
      schema: z.object({ messageID }).strict(), annotations: annotations(false, false, true), args: input => [input.messageID]
    },
    {
      name: "facebook_set_message_reaction", method: "setMessageReaction", description: "Set a reaction on a message; use an empty reaction to remove it.",
      schema: z.object({ messageID, threadID: id, reaction: z.string().max(32) }).strict(),
      annotations: annotations(false, true), args: input => [input.reaction, input.messageID, input.threadID]
    },
    {
      name: "facebook_mark_thread_read", method: "markAsRead", description: "Change thread read state and potentially send a read receipt. Read uses connected MQTT when available; unread and HTTP-only sessions use the HTTP adapter.",
      schema: z.object({ threadID: id, read: z.boolean().default(true) }).strict(),
      annotations: annotations(false, true), args: input => [input.threadID, input.read]
    },
    {
      name: "facebook_change_thread_nickname", method: "changeNickname", description: "Set a participant's nickname in a Messenger thread. An empty nickname resets it.",
      schema: z.object({ threadID: id, participantID: id, nickname: z.string().max(100) }).strict(),
      annotations: annotations(false, true), args: input => [input.nickname, input.threadID, input.participantID]
    },
    {
      name: "facebook_change_thread_emoji", method: "changeThreadEmoji", description: "Set the Messenger thread's quick-reaction emoji.",
      schema: z.object({ threadID: id, emoji: z.string().min(1).max(32) }).strict(),
      annotations: annotations(false, true), args: input => [input.emoji, input.threadID]
    },
    {
      name: "facebook_mute_thread", method: "muteThread", description: "Mute a Messenger thread over MQTT. Use -1 indefinitely, 0 to unmute, or a duration in seconds. Read get_thread_info separately to verify.",
      schema: z.object({ threadID: id, seconds: z.number().int().min(-1).max(31536000) }).strict(),
      annotations: annotations(false), args: input => [input.threadID, input.seconds]
    },
    {
      name: "facebook_delete_message_for_me", method: "deleteMessage", description: "Experimental MQTT remove-for-me request for one message. Distinct from unsending for everyone. Requires thread context; acknowledgement is not readback.",
      schema: z.object({ threadID: id, messageID }).strict(),
      annotations: annotations(false, true, true), args: input => [input.messageID, input.threadID]
    },
    {
      name: "facebook_change_thread_admin", method: "changeAdminStatus", description: "Experimental MQTT participant-admin change. Requires group privileges. Acknowledgement is not verification.",
      schema: z.object({ threadID: id, participantID: id, isAdmin: z.boolean() }).strict(),
      annotations: annotations(false, true, true), args: input => [input.threadID, input.participantID, input.isAdmin]
    },
    {
      name: "facebook_remove_thread_participant", method: "removeUserFromGroup", description: "Experimental MQTT group participant removal. Requires group privileges. Read thread metadata separately to verify.",
      schema: z.object({ threadID: id, participantID: id }).strict(),
      annotations: annotations(false, true, true), args: input => [input.participantID, input.threadID]
    },
    {
      name: "facebook_pin_message", method: "pinMessage", description: "Request pin or unpin of a Messenger message over MQTT. Server acknowledgement is not independently verified pin state.",
      schema: z.object({ threadID: id, messageID, pinned: z.boolean() }).strict(),
      annotations: annotations(false, true), args: input => [input.pinned, input.messageID, input.threadID]
    },
    {
      name: "facebook_share_contact", method: "shareContact", description: "Send a contact card over MQTT. Experimental adapter; this creates a message and is not idempotent.",
      schema: z.object({ threadID: id, contactID: id, text: z.string().max(20000).default("") }).strict(),
      annotations: annotations(false), args: input => [input.text, input.contactID, input.threadID]
    },
    {
      name: "facebook_share_link", method: "shareLink", description: "Send a link attachment with optional text using the HTTP message sender. This creates a message and is not idempotent.",
      schema: z.object({ threadID: id, url: z.string().url().max(4096).refine(value => /^https?:\/\//i.test(value)), text: z.string().max(20000).default("") }).strict(),
      annotations: annotations(false), args: input => [input.text, input.url, input.threadID]
    }
  ];
  return tools.filter(tool => typeof api[tool.method] === "function");
}

function createRegistry(api, options = {}) {
  if (!api || typeof api !== "object") throw new TypeError("An authenticated FCA API object is required");
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxConcurrent = options.maxConcurrent ?? 8;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new RangeError("timeoutMs must be between 1 and 300000");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) throw new RangeError("maxConcurrent must be between 1 and 64");
  const sanitizer = createSanitizer(options.secretValues);
  const tools = definitions(api);
  const eventBuffer = options.eventBuffer;
  if (eventBuffer) {
    tools.push({ name: "facebook_get_events", method: null,
      description: "Read a bounded, non-consuming page of sanitized host events after a monotonic cursor. Reports overflow and listener errors. Does not start MQTT or notification polling.",
      schema: z.object({ after: timestamp.default(0), limit }).strict(),
      annotations: { ...annotations(true), openWorldHint: false }, local: input => eventBuffer.read(input) });
  }
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const pending = new Set();
  let closed = false;

  async function call(name, input, context = {}) {
    const tool = byName.get(name);
    let controller;
    let abort;
    try {
      if (!tool) throw new McpToolError("UNKNOWN_TOOL");
      if (closed) throw new McpToolError("SERVER_CLOSED");
      const parsed = tool.schema.safeParse(input ?? {});
      if (!parsed.success) throw new McpToolError("INVALID_INPUT");
      if (pending.size >= maxConcurrent) throw new McpToolError("BUSY");
      controller = new AbortController();
      abort = () => controller.abort();
      if (context.signal?.aborted) abort();
      else context.signal?.addEventListener("abort", abort, { once: true });
      pending.add(controller);
      let data = tool.local ? tool.local(parsed.data) : await invoke(api, tool.method, tool.args(parsed.data), {
        timeoutMs, signal: controller.signal, callbackIndex: tool.callbackIndex, synchronous: tool.synchronous
      });
      if (tool.transform) data = tool.transform(data, parsed.data);
      const sanitized = sanitizer.sanitize(data);
      // These are provider pagination values, not login credentials. Keep this
      // exception scoped to documented read results; all other secret keys and
      // known credential strings still go through the normal sanitizer.
      if (tool.publicCursors === "search" && typeof data?.sessionID === "string" && data.sessionID.length <= 4096) {
        sanitized.sessionID = sanitizer.text(data.sessionID);
      }
      if (tool.publicCursors === "comments" && Array.isArray(data?.items)) {
        data.items.forEach((item, index) => {
          if (typeof item?.expansionToken === "string" && item.expansionToken.length <= 16384 && sanitized.items?.[index]) {
            sanitized.items[index].expansionToken = sanitizer.text(item.expansionToken);
          }
        });
      }
      const result = { ok: true, data: sanitized };
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 262144) throw new McpToolError("RESULT_TOO_LARGE");
      return { content: [{ type: "text", text }], structuredContent: result };
    } catch (error) {
      return errorResult(error, tool?.annotations.readOnlyHint === false);
    } finally {
      if (controller) pending.delete(controller);
      if (abort) context.signal?.removeEventListener("abort", abort);
    }
  }

  function status() {
    return {
      protocol: "mcp", state: closed ? "closed" : "ready", authenticatedApiProvided: true,
      connectionHealth: "not-probed", pendingRequests: pending.size,
      limits: { pageSize: 100, userIDs: 50, responseBytes: 262144, timeoutMs, maxConcurrent },
      tools: tools.map(tool => ({ name: tool.name, method: tool.method, annotations: tool.annotations })),
      featureNamespacePresent: Boolean(api.facebook && typeof api.facebook === "object"),
      events: eventBuffer ? eventBuffer.status() : null
    };
  }

  function close() {
    closed = true;
    for (const controller of pending) controller.abort();
  }

  return { tools, call, status, close };
}

module.exports = { createRegistry };
