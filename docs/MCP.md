# Facebook API MCP server

The MCP adapter exposes a curated subset of the existing cookie-authenticated FCA API over the official Model Context Protocol SDK's stdio transport. It accepts the same API object returned by login, preserving the existing Chika/FCA method signatures.

## Requirements and package integration

The package requires **Node.js 20.18.1 or later** (including its runtime dependencies):

For profile video posts, use `facebook_publish_video_post` with a staged `videoID`.
Audience defaults to **PUBLIC**; `audience: "FRIENDS"` or `"SELF"` explicitly
overrides it. This uses the live-verified profile composer path.

Pass `--notifications` to poll Facebook notifications every 60 seconds and add
new items/errors to `facebook_get_events`. The initial snapshot is a baseline.
This can be combined with `--listen` for Messenger events. Polling is bounded
and may miss bursts larger than its newest-page window.

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.2",
    "zod": "^4.6.7"
  },
  "bin": {
    "facebook-api-mcp": "bin/facebook-api-mcp.js"
  }
}
```

The runtime package includes `lib/mcp/`, `bin/` and public guides. The current
adapter uses SDK **1.32.2** and Zod **4.6.7**; callers do not need to install a
separate schema peer to launch the CLI. The complete current tool list is in
[the tool catalog below](#complete-tool-catalog), generated from the registry.

The adapter is a separate subpath (`require("facebook-api-mcp/lib/mcp")`) and preserves the callable FCA login export. `lib/mcp/index.d.ts` supplies declarations for the subpath using official SDK types; no nested package.json is required.

## Start a stdio server

Configure the client to launch a dedicated process:

```json
{
  "mcpServers": {
    "facebook": {
      "command": "node",
      "args": ["/absolute/path/to/facebook-api-mcp/bin/facebook-api-mcp.js"],
      "env": {
        "FACEBOOK_APP_STATE_PATH": "/absolute/path/to/appstate.json"
      }
    }
  }
}
```

Alternatively use `node bin/facebook-api-mcp.js --app-state /path/to/appstate.json`. The cookie file is loaded by the existing login/session implementation. Credentials and cookie values are never MCP arguments or resources.

Add `--listen` to start the existing MQTT listener for operations such as editing messages and marking personal-account conversations read. Incoming events and listener errors enter a sanitized bounded buffer, exposed by `facebook_get_events`. Starting the listener is asynchronous; its readiness is not implied by an available tool. The CLI disables automatic read/delivery marking, presence updates and automatic typing in its login options. Notification polling is not started automatically.

The CLI reserves stdout exclusively for SDK JSON-RPC messages. It suppresses legacy stdout/stderr diagnostics, which can contain raw requests, and writes only fixed credential-free lifecycle messages to stderr. `--help` also writes to stderr. SIGINT, SIGTERM and stdin EOF close the transport, cancel local pending requests, stop listening, save the session and dispose Chika session maintenance. CLI shutdown has a five-second deadline for legacy work that cannot be cancelled. Shutdown does not log out the Facebook account.

## Curated tools

Messaging verification is summarized in [capability limits](API_REFERENCE.md#capability-limits).
In particular, `facebook_edit_message` preserves `verified: false`: an LS response
contained the requested edit, but independent legacy reads did not show it.

Tools appear only when their corresponding FCA function exists on the injected API at startup. Every tool declares strict Zod input schemas and MCP read-only, destructive, idempotent and open-world annotations.

| Tool | FCA method | Arguments | Semantics |
| --- | --- | --- | --- |
| `facebook_get_current_user` | `getCurrentUserID` | none | Read current user ID |
| `facebook_get_thread_info` | `getThreadInfo` | `threadID` | Read one thread |
| `facebook_list_threads` | `getThreadList` | `limit?`, `before?`, `tags?` | Read one thread page |
| `facebook_get_thread_history` | `getThreadHistory` | `threadID`, `limit?`, `before?` | Read one message page |
| `facebook_get_message` | `getMessage` | `threadID`, `messageID` | Read one message |
| `facebook_get_user_info` | `getUserInfo` | `userIDs` | Read up to 50 profiles |
| `facebook_send_message` | `sendMessage` | `threadID`, `text`, `replyToMessageID?` | Create a text message |
| `facebook_edit_message` | `editMessage` | `messageID`, `text` | Replace message text |
| `facebook_unsend_message` | `unsendMessage` | `messageID` | Remove a message for participants |
| `facebook_set_message_reaction` | `setMessageReaction` | `threadID`, `messageID`, `reaction` | Set/remove reaction |
| `facebook_mark_thread_read` | `markAsRead` | `threadID`, `read?` | Change read state/receipt |
| `facebook_change_thread_nickname` | `changeNickname` | `threadID`, `participantID`, `nickname` | Set/reset nickname |
| `facebook_change_thread_emoji` | `changeThreadEmoji` | `threadID`, `emoji` | Set thread emoji |
| `facebook_mute_thread` | `muteThread` | `threadID`, `seconds` | MQTT; -1 indefinitely, 0 unmute, positive duration |
| `facebook_delete_message_for_me` | `deleteMessage` | `threadID`, `messageID` | Remove only from the current account; distinct from unsend |
| `facebook_change_thread_admin` | `changeAdminStatus` | `threadID`, `participantID`, `isAdmin` | Experimental MQTT admin change |
| `facebook_remove_thread_participant` | `removeUserFromGroup` | `threadID`, `participantID` | Experimental MQTT participant removal |
| `facebook_pin_message` | `pinMessage` | `threadID`, `messageID`, `pinned` | MQTT pin/unpin request; offline coverage |
| `facebook_share_contact` | `shareContact` | `threadID`, `contactID`, `text?` | Experimental MQTT contact card |
| `facebook_share_link` | `shareLink` | `threadID`, `url`, `text?` | HTTP URL attachment; HTTP(S) URLs only |
| `facebook_create_post` | `createPost` | `text`, `audience`, `groupID?` | Create a text post, return URL |
| `facebook_create_comment` | `createCommentPost` | `postID`, `text`, `replyCommentID?` | Create a text comment/reply |
| `facebook_set_post_reaction` | `setPostReaction` | `postID`, `reaction` | Set/remove post reaction |
| `facebook_set_comment_reaction` | `setCommentReaction` | `commentID`, `reaction` | Set/remove comment reaction |
| `facebook_set_story_reaction` | `setStoryReaction` | `storyID`, `reaction` | Send story reaction/reply |
| `facebook_get_capabilities` | `getFacebookCapabilities` | none | Read synchronous feature metadata |
| `facebook_get_notifications` | `getNotifications` | `limit?`, `cursor?` | Read one bounded GraphQL page |
| `facebook_get_content` | `getContent` | `url` | Read normalized content |
| `facebook_analyze_content` | `analyzeContent` | `url` | Read deterministic metadata/counts |
| `facebook_get_events` | injected event buffer | `after?`, `limit?` | Read non-consuming event page |
| `facebook_create_story` | `createStory` | exactly one `photoID`/`videoID`/`text`, `privacy`, text formatting IDs when using text | Create a Story |
| `facebook_publish_video` | `publishVideo` | `videoID`, `title?`, `description?`, `targetID?` | Publish staged video |
| `facebook_publish_reel` | `publishReel` | `videoID`, `placements`, `caption?`, `draft?`, `enableRemix?`, `embeddable?` | Publish/draft staged Reel |

Post/comment creation and reactions have selected-account live evidence; current
web operation IDs remain deployment-sensitive. Text posts require an explicit
audience: PUBLIC maps to baseState 1, FRIENDS to 2, SELF to 3. Group destinations
use their own visibility rules. The comment adapter preserves
`createCommentPost(text, postID, callback, replyCommentID)`.

Post/comment reaction enums are `unlike`, `like`, `heart`, `love`, `care`, `haha`, `wow`, `sad`, `angry`. They preserve the legacy mapping (`heart=2`, `love/care=16`); `unlike` removes the reaction. Story reactions accept only `👍`, `❤️`, `🤗`, `😆`, `😮`, `😢`, `😡`. Sending a story reaction may create a reply and is not marked idempotent.

Content tools accept HTTPS URLs on `www.facebook.com` or `facebook.com` only; the latter normalizes to `www.facebook.com`. Credentials, other hosts, nonstandard ports, and HTTP URLs are rejected. `analyzeContent` provides deterministic metadata/counts, **not AI vision**. Notifications accept `{ limit: 1..100, cursor?: string }` (default limit 20), returning `{ items, pageInfo }`. When `pageInfo.hasMore` is true and `pageInfo.endCursor` is a nonempty string, pass that genuine opaque cursor to the next call. Cursors are bounded to 4,096 characters and are not fabricated by the adapter. Each call makes one GraphQL page request. This notification provider path was live-verified for a selected cookie account, not every account. `listenNotifications` is not exposed as a tool or started by this adapter.

### Experimental staged-media publishing

Story, video and Reel publishing adapters are **experimental and not live-verified**. All are non-idempotent mutations and appear only when the underlying method exists. They accept already staged decimal-string media IDs; uploads, file paths and file streams are not MCP tools. `uploadPhoto` and `uploadVideo` remain direct FCA APIs. A future MCP uploader would need a separately configured, scoped media root.

`facebook_create_story` requires exactly one of `photoID`, `videoID`, or `text`, and requires `privacy: "current"` explicitly. This uses the account's existing **Story** audience settings. Text additionally requires decimal-string `textPresetID` and `fontID` from the current Story composer. The runtime rejects conflicting content types and incomplete formatting IDs before calling FCA. Results such as `{ storyID, status: "accepted", published: null, verification }` are preserved: accepted does not establish that encoding/publication completed.

`facebook_publish_video` accepts `videoID`, optional `title`, `description` and `targetID`. `facebook_publish_reel` accepts `videoID`, a nonempty array of deployment-supported `placements` strings (maximum 20, 128 characters each), optional `caption`, and optional boolean `draft`, `enableRemix`, and `embeddable`. No placement enum is invented. Video/Reel audience behavior is determined by the web backend; these tools expose no privacy field and make no claim that the current audience is preserved. Provider publication/draft results are returned as supplied.

Facebook user/thread IDs are decimal strings, preserving precision. Message IDs are nonempty strings, at most 256 characters, without whitespace/control characters. Message text is bounded to 20,000 characters. `reaction: ""` removes a reaction; `nickname: ""` resets a nickname. Mutations execute immediately using the current account and are never automatically retried by the MCP adapter. A provider response such as `{ "queued": true }` is returned as-is and is not treated as proof of remote acknowledgement.

There is no arbitrary-method dispatcher, raw GraphQL/HTTP tool, cookie export, credential-setting tool or client-supplied executable adapter.

### Pagination and bounds

Thread lists/history default to 20 items and accept a maximum of 100. `before` is an integer millisecond timestamp or null; `tags` defaults to `["INBOX"]` and accepts `INBOX`, `ARCHIVED`, `PENDING`, and `OTHER`.

```json
{
  "ok": true,
  "data": {
    "items": [],
    "pagination": {
      "limit": 20,
      "nextBefore": null,
      "hasMore": false,
      "cursorStalled": false,
      "boundary": "provider-before",
      "deduplicateByID": true
    }
  }
}
```

For a full page, pass `nextBefore` to the next call. `hasMore: null` means the provider does not report whether another page exists. The adapter retains the provider's timestamp boundary rather than subtracting a millisecond. Deduplicate thread/message IDs across pages. A full page with `cursorStalled: true` has no advancing timestamp; do not loop on it. Timestamp-only provider APIs cannot guarantee a lossless snapshot for concurrent updates or multiple items at identical boundary timestamps. Each MCP request makes one provider call and never traverses all pages automatically.

The sanitized JSON result is limited to 256 KiB, 20,000 visited values and 16 nesting levels. Oversized results fail explicitly rather than silently truncating message contents. Default request timeout is 30 seconds; default concurrency is eight local requests. Provider requests already in progress can continue after timeout or cancellation because legacy FCA does not expose cancellation handles.

## Capability/status resource

Read `facebook://capabilities` to obtain the currently registered tool names, their underlying FCA methods, annotations, configured bounds, pending request count and local lifecycle state. `authenticatedApiProvided: true` means an API object was supplied, not that a live authentication probe succeeded. `connectionHealth: "not-probed"` is deliberate: resource reads make no Facebook request and reveal no cookie state.

The resource also reports whether an `api.facebook` namespace exists and, when injected, event-buffer state, bounds, dropped count and error count. The curated feature tools use top-level FCA methods; each is registered only if that method exists at startup. Namespace presence alone does not expose its methods. Feature implementations added after server startup require a new server instance to become discoverable through tools.

## Event-buffer hosting contract

`createEventBuffer({ capacity = 500, maxBytes = 2097152, secretValues = [] })` creates a process-local buffer. Pass it as `eventBuffer` to `createMcpServer`, `startStdioServer`, or `createRegistry`. The event tool exists only when a buffer is injected; the CLI injects one when `--listen` is requested and `api.listenMqtt` exists.

```js
const { createEventBuffer, createMcpServer, disposeApi } = require("facebook-api-mcp/lib/mcp");
const events = createEventBuffer({ secretValues: knownCookieSecrets });
api.listenMqtt((error, event) => {
  if (error) events.publishError(error, "mqtt");
  if (event != null) events.publish(event, "mqtt");
});
const host = createMcpServer({
  api,
  eventBuffer: events,
  dispose: async api => {
    try { await disposeApi(api); }
    finally { events.close(); }
  }
});
```

Hosting methods:
- `publish(event, source = "mqtt")`: synchronously sanitize/store an event and return its numeric cursor. Allowed sources: `mqtt`, `notifications`, `host`.
- `publishError(error, source = "mqtt")`: store a fixed `LISTENER_ERROR` record without retaining the raw provider error. Error occurrence, source and ordering are visible to agents.
- `read({ after = 0, limit = 20 })`: return `{ items, nextCursor, latestCursor, oldestCursor, hasMore, overflow, missed, droppedTotal }`. Each item is `{ cursor, source, receivedAt, event }`. Reads are independent snapshots and never consume events.
- `status()`: local size/byte bounds, latest cursor, total dropped entries, error count and open/closed state.
- `close()`: reject future publications; buffered snapshots remain readable. The injecting host owns this lifecycle; closing an MCP server does not close an externally shared buffer.

Cursors increase monotonically within one buffer instance and restart with the process. Read with `after: 0`, then reuse each `nextCursor`. A future cursor is rejected; discard stored cursors when reconnecting to a new process. `overflow: true` and `missed` identify entries evicted since the supplied cursor. `droppedTotal` is the lifetime eviction count. Capacity is 1..10,000 entries, total bytes are bounded to 1 KiB..16 MiB, and default storage is 500 entries/2 MiB. Individual payloads exceeding 32 KiB or failing sanitization become visible `EVENT_REJECTED` error entries. Read pages contain at most 100 entries and stay within the MCP result-size budget, possibly returning fewer entries with `hasMore: true`. Oldest entries, including errors, can be evicted; overflow and cumulative error counts preserve visibility of loss.

`facebook_get_events` reads only the buffer and starts no network work. An embedding host may explicitly attach an opted-in notification emitter and publish its events/errors using source `notifications`; it owns polling bounds and emitter shutdown.

## Results and errors

Tool results include matching JSON in `content[0].text` and `structuredContent`:

```json
{ "ok": true, "data": { "messageID": "mid.example" } }
```

```json
{
  "ok": false,
  "error": {
    "code": "TIMEOUT",
    "message": "The operation exceeded its time limit; its remote outcome may be unknown.",
    "retryable": false,
    "outcomeUnknown": true
  }
}
```

Errors set MCP `isError: true`. Codes include `INVALID_INPUT`, `UNKNOWN_TOOL`, `API_ERROR`, `INVALID_RESPONSE`, `RESULT_TOO_LARGE`, `TIMEOUT`, `CANCELLED`, `SERVER_CLOSED`, and `BUSY`. The allowlisted provider codes `NOTIFICATIONS_UNAVAILABLE`, `CONTENT_UNAVAILABLE`, `GRAPHQL_ERROR`, `SESSION_EXPIRED`, and `OPERATION_UNAVAILABLE` are retained with fixed sanitized messages. Provider messages, stacks and request bodies are not forwarded. Invalid tool arguments use the same structured envelope; malformed JSON-RPC/protocol envelopes are handled by the SDK. Only `BUSY` is marked retryable; inspect the remote state before deciding whether to repeat a mutation with `outcomeUnknown: true`. GraphQL mutation failures and explicit provider `outcome: "unknown"` flags preserve uncertainty.

Results redact session/token/password/header keys, cookie records and known cookie secret values. When embedding, pass any additional known secrets as `secretValues` for string-level redaction. Sanitization does not remove normal conversation content or profile metadata.

## Inject an existing API

```js
const { createMcpServer, disposeApi } = require("facebook-api-mcp/lib/mcp");

const host = createMcpServer({
  api,                         // Existing authenticated FCA API or test double
  timeoutMs: 30000,             // 1..300000
  maxConcurrent: 8,             // 1..64
  secretValues: [],
  dispose: disposeApi           // Omit if the parent owns the shared API lifetime
});

await host.connect(transport); // Any official SDK Transport
// ...
await host.close();            // Idempotent; cancels local pending tool calls
```

`startStdioServer(options)` additionally accepts `input`, `output`, `signals` (default true), and `processObject` for injected streams/lifecycle tests. It returns the server handle plus its stdio transport. Embedded callers are responsible for routing their own and legacy FCA logs away from the selected protocol output. Use the standalone CLI for process-level stdout isolation.

`createRegistry(api, options)` provides `tools`, `call(name, arguments, { signal }?)`, `status()`, and `close()`. The registry supports synchronous identity reads, callbacks, promises, and dual callback/promise implementations. It preserves `sendMessage(text, threadID, callback, replyID)` explicitly.

## Offline tests

```sh
node --test test/mcp-core.test.js test/mcp-server.test.js test/mcp-social-events.test.js test/mcp-publishing.test.js
```

Tests use injected mocks and in-memory/stdio SDK transports. They perform no login or live Facebook mutation. Install the declared SDK and Zod dependencies before running the complete suite; the core tests also run without them.

<!-- generated:tool-catalog:start -->
## Complete tool catalog

Generated from the actual registry. Configure the stdio server using [MCP.md](MCP.md).
Tools appear only when the underlying method is present. Inputs are strict; unknown fields reject.
For argument types/defaults, your MCP client's `tools/list` exposes the authoritative JSON Schema.

| Tool | Provider method | Input fields | Read only |
| --- | --- | --- | --- |
| `facebook_inspect_action` | `reconcileAction` | `key` | yes |
| `facebook_reconcile_action` | `reconcileAction` | `key`, `actorID?`, `storyID?`, `parentFeedbackID?`, `expansionToken?`, `maxScanPages?` | no |
| `facebook_engage_post` | `engagePost` | `action`, `postID`, `actorID?`, `storyID?`, `text?`, `parentCommentID?`, `parentFeedbackID?`, `expansionToken?`, `reaction?`, `url?`, `groupID?`, `baseState?`, `maxScanPages?` | no |
| `facebook_get_post` | `getPost` | `target`, `actorID?` | yes |
| `facebook_get_post_comments` | `getPostComments` | `postID`, `limit?`, `cursor?` | yes |
| `facebook_get_comment_replies` | `getCommentReplies` | `feedbackID`, `limit?`, `cursor?`, `expansionToken?`, `clientKey?` | yes |
| `facebook_search_posts` | `searchPosts` | `types?`, `keywords?`, `keywordMode?`, `authorID?`, `groupID?`, `since?`, `until?`, `limit?`, `cursor?`, `query?`, `hashtag?`, `sessionID?` | yes |
| `facebook_get_feed_posts` | `getFeedPosts` | `types?`, `keywords?`, `keywordMode?`, `authorID?`, `groupID?`, `since?`, `until?`, `limit?`, `cursor?` | yes |
| `facebook_get_profile_posts` | `getProfilePosts` | `profileID`, `types?`, `keywords?`, `keywordMode?`, `authorID?`, `groupID?`, `since?`, `until?`, `limit?`, `cursor?` | yes |
| `facebook_get_group_posts` | `getGroupPosts` | `types?`, `keywords?`, `keywordMode?`, `authorID?`, `groupID`, `since?`, `until?`, `limit?`, `cursor?` | yes |
| `facebook_get_page_posts` | `getPagePosts` | `pageID`, `types?`, `keywords?`, `keywordMode?`, `authorID?`, `groupID?`, `since?`, `until?`, `limit?`, `cursor?` | yes |
| `facebook_delete_post` | `deletePost` | `target` | no |
| `facebook_edit_post` | `editPost` | `target`, `text` | no |
| `facebook_delete_comment` | `deleteCommentPost` | `commentID`, `postID?`, `parentFeedbackID?`, `expansionToken?` | no |
| `facebook_edit_comment` | `editCommentPost` | `commentID`, `text`, `postID?`, `parentFeedbackID?`, `expansionToken?` | no |
| `facebook_set_post_audience` | `setPostAudience` | `target`, `audience` | no |
| `facebook_get_video_status` | `getVideoStatus` | `videoID` | yes |
| `facebook_verify_publication` | `verifyPublication` | `target`, `maxAttempts?`, `intervalMs?`, `timeoutMs?`, `expectedText?`, `expectedMediaType?`, `expectedAudience?` | yes |
| `facebook_publish_post_verified` | `publishPostVerified` | `text?`, `videoID?`, `audience?`, `maxAttempts?`, `intervalMs?`, `timeoutMs?`, `expectedMediaType?` | no |
| `facebook_publish_video_post` | `publishVideoPost` | `videoID`, `description?`, `audience?` | no |
| `facebook_create_story` | `createStory` | `photoID?`, `videoID?`, `text?`, `privacy`, `textPresetID?`, `fontID?` | no |
| `facebook_publish_video` | `publishVideo` | `videoID`, `title?`, `description?`, `targetID?` | no |
| `facebook_publish_reel` | `publishReel` | `videoID`, `caption?`, `placements`, `draft?`, `enableRemix?`, `embeddable?` | no |
| `facebook_create_post` | `createPost` | `text`, `audience`, `groupID?` | no |
| `facebook_create_comment` | `createCommentPost` | `postID`, `text`, `replyCommentID?` | no |
| `facebook_set_post_reaction` | `setPostReaction` | `postID`, `reaction` | no |
| `facebook_set_comment_reaction` | `setCommentReaction` | `commentID`, `reaction` | no |
| `facebook_set_story_reaction` | `setStoryReaction` | `storyID`, `reaction` | no |
| `facebook_get_capabilities` | `getFacebookCapabilities` | none | yes |
| `facebook_get_notifications` | `getNotifications` | `limit?`, `cursor?` | yes |
| `facebook_get_content` | `getContent` | `url` | yes |
| `facebook_analyze_content` | `analyzeContent` | `url` | yes |
| `facebook_get_current_user` | `getCurrentUserID` | none | yes |
| `facebook_get_thread_info` | `getThreadInfo` | `threadID` | yes |
| `facebook_list_threads` | `getThreadList` | `limit?`, `before?`, `tags?` | yes |
| `facebook_get_thread_history` | `getThreadHistory` | `threadID`, `limit?`, `before?` | yes |
| `facebook_get_message` | `getMessage` | `threadID`, `messageID` | yes |
| `facebook_get_user_info` | `getUserInfo` | `userIDs` | yes |
| `facebook_send_message` | `sendMessage` | `threadID`, `text`, `replyToMessageID?` | no |
| `facebook_edit_message` | `editMessage` | `messageID`, `text` | no |
| `facebook_unsend_message` | `unsendMessage` | `messageID` | no |
| `facebook_set_message_reaction` | `setMessageReaction` | `messageID`, `threadID`, `reaction` | no |
| `facebook_mark_thread_read` | `markAsRead` | `threadID`, `read?` | no |
| `facebook_change_thread_nickname` | `changeNickname` | `threadID`, `participantID`, `nickname` | no |
| `facebook_change_thread_emoji` | `changeThreadEmoji` | `threadID`, `emoji` | no |
| `facebook_mute_thread` | `muteThread` | `threadID`, `seconds` | no |
| `facebook_delete_message_for_me` | `deleteMessage` | `threadID`, `messageID` | no |
| `facebook_change_thread_admin` | `changeAdminStatus` | `threadID`, `participantID`, `isAdmin` | no |
| `facebook_remove_thread_participant` | `removeUserFromGroup` | `threadID`, `participantID` | no |
| `facebook_pin_message` | `pinMessage` | `threadID`, `messageID`, `pinned` | no |
| `facebook_share_contact` | `shareContact` | `threadID`, `contactID`, `text?` | no |
| `facebook_share_link` | `shareLink` | `threadID`, `url`, `text?` | no |

## facebook_inspect_action

Inspect one action key in the login-configured durable action ledger. Does not execute or replay an action. No ledger path is accepted.

## facebook_reconcile_action

Check bounded visible server state for an existing action key and persist positive evidence to the configured ledger. Reads Facebook state and updates the local ledger only; never replays mutations. Negative or partial evidence never permits retry. No ledger path is accepted.

## facebook_engage_post

Perform one comment, reply, reaction or share with durable duplicate prevention. Requires actionLedgerPath configured by the embedding login, never a tool argument. Checks existing visible server state where supported. Unknown crash outcomes never replay. Completed reactions may reserve a new revision after confirmed server-state drift; other ledger duplicates do not replay. Shares cannot guarantee detection of every historical share; inspect provenance and coverage. Share audience defaults to PUBLIC (baseState=1).

## facebook_get_post

Read normalized root-post metadata and known viewer state. target is a numeric post ID (requires its author's actorID), a supported encoded story ID, or an explicit identity object; pfbid/URL decoding is unsupported.

## facebook_get_post_comments

Read one bounded visible comment page for a numeric postID. Preserve comment IDs, feedbackIDs and expansionTokens for replies; server ordering and visibility apply.

## facebook_get_comment_replies

Read one bounded depth-1 reply page using the parent comment's feedbackID (not its comment ID). Forward its expansionToken and provider clientKey when available.

## facebook_search_posts

Search posts by query and/or hashtag. Reuse returned sessionID with the cursor for the same search. Reads one provider page, not all results. Author/group/type/keyword/date filters apply only to that returned page. since/until are inclusive Unix seconds or ISO dates; unknown dates are excluded when filtering by date. The provider may return more than requested (maximum 100); continue with pageInfo.endCursor without truncating items.

## facebook_get_feed_posts

Read the ranked news feed. Reads one provider page, not all results. Author/group/type/keyword/date filters apply only to that returned page. since/until are inclusive Unix seconds or ISO dates; unknown dates are excluded when filtering by date. The provider may return more than requested (maximum 100); continue with pageInfo.endCursor without truncating items.

## facebook_get_profile_posts

Read a profile timeline by numeric profileID. Reads one provider page, not all results. Author/group/type/keyword/date filters apply only to that returned page. since/until are inclusive Unix seconds or ISO dates; unknown dates are excluded when filtering by date. The provider may return more than requested (maximum 100); continue with pageInfo.endCursor without truncating items.

## facebook_get_group_posts

Read a group's regular discussion feed; announcements are excluded. Reads one provider page, not all results. Author/group/type/keyword/date filters apply only to that returned page. since/until are inclusive Unix seconds or ISO dates; unknown dates are excluded when filtering by date. The provider may return more than requested (maximum 100); continue with pageInfo.endCursor without truncating items.

## facebook_get_page_posts

Read a supported Page timeline by numeric pageID, including profile-plus User nodes with a validated delegate_page. Returns pageID and delegatePageID; unsupported Page connections fail explicitly. Reads one provider page, not all results. Author/group/type/keyword/date filters apply only to that returned page. since/until are inclusive Unix seconds or ISO dates; unknown dates are excluded when filtering by date. The provider may return more than requested (maximum 100); continue with pageInfo.endCursor without truncating items.

## facebook_delete_post

Delete the exact identified post. Returns deletedStoryID and whether a subsequent read verified deletion; accepted deletion is not proof of verification.

## facebook_edit_post

Replace the exact identified post's text, including clearing it with an empty string. Returns storyID, text and read-back verification.

## facebook_delete_comment

Delete a comment by encoded comment identity, or numeric commentID with postID. Optional parent feedback identity supports reply verification. verified reports bounded read-back evidence.

## facebook_edit_comment

Replace a comment's text using its encoded identity, or numeric commentID with postID. Optional parent feedback identity supports reply verification. Returns commentID, text and bounded read-back verification.

## facebook_set_post_audience

Change the exact identified post's audience to PUBLIC, FRIENDS or SELF when an editable privacy scope exists. Returns read-back verification.

## facebook_get_video_status

Read one video's processing status, linked story and playback URL presence. published requires OK status, a linked story and playback evidence; playback is not fetched.

## facebook_verify_publication

Perform bounded read-only publication checks for an exact post or video identity. Reports verified, pending, mismatch, unavailable or timeout; an accepted mutation alone is not publication evidence.

## facebook_publish_post_verified

Create a text or staged-video post, then perform bounded publication checks. Audience defaults to PUBLIC; choose FRIENDS or SELF explicitly. Returns url and verification. Text posts resolve the exact returned URL in at most three visible profile pages. Unavailable or failed verification does not mean publication failed: do not republish automatically.

## facebook_publish_video_post

Publish staged video to the profile using the live-verified composer path. Defaults to PUBLIC; explicitly select FRIENDS or SELF to override. Facebook may present short videos as Reels. Accepted does not confirm processing is complete.

## facebook_create_story

Create a Story from exactly one staged photoID, staged videoID, or text. Requires privacy=current to use the account's existing Story audience. Text requires numeric-string textPresetID and fontID from the Story composer. An accepted result does not confirm publication. Experimental web operation; not live-verified. Uses an already staged media ID and does not upload local files.

## facebook_publish_video

Publish an already staged video with optional title, description and targetID. Audience behavior is determined by the web backend; this tool exposes no audience setting. Experimental web operation; not live-verified. Uses an already staged media ID and does not upload local files.

## facebook_publish_reel

Publish or draft an already staged video as a Reel. Supply deployment-supported placements; audience behavior is determined by the web backend and no audience setting is exposed. Experimental web operation; not live-verified. Uses an already staged media ID and does not upload local files.

## facebook_create_post

Create a text post and return its URL. Audience is explicit; group visibility is controlled by the group when groupID is supplied. Uses historical web operation IDs that are not live-verified.

## facebook_create_comment

Create a text comment on a post, optionally replying to a comment. Uses historical web operation IDs that are not live-verified.

## facebook_set_post_reaction

Set/remove a post reaction. Legacy mapping: heart=2, love/care=16; unlike removes it. Uses historical web operation IDs that are not live-verified.

## facebook_set_comment_reaction

Set/remove a comment reaction. Legacy mapping: heart=2, love/care=16; unlike removes it. Uses historical web operation IDs that are not live-verified.

## facebook_set_story_reaction

Send a story reaction/reply. This can create a reply and is not assumed idempotent. Uses historical web operation IDs that are not live-verified.

## facebook_get_capabilities

Read implemented Facebook feature capabilities and verification metadata without making a live health probe.

## facebook_get_notifications

Read one bounded GraphQL notification page. Pass pageInfo.endCursor as cursor when pageInfo.hasMore is true. This provider path was live-verified for a selected cookie account, not every account.

## facebook_get_content

Read normalized content metadata from an HTTPS facebook.com URL.

## facebook_analyze_content

Read deterministic metadata and counts for Facebook content. This performs no AI vision or image/video interpretation.

## facebook_get_current_user

Get the active Facebook user ID without returning session cookies.

## facebook_get_thread_info

Read metadata for one Messenger thread.

## facebook_list_threads

Read one bounded page of Messenger threads. Pass pagination.nextBefore to continue; deduplicate thread IDs across pages.

## facebook_get_thread_history

Read one bounded page of thread messages. Pass pagination.nextBefore to continue; deduplicate message IDs across pages. A null hasMore means the provider does not report whether another page exists.

## facebook_get_message

Read a single message in a thread.

## facebook_get_user_info

Read public Messenger profile metadata for up to 50 user IDs.

## facebook_send_message

Send a text message, optionally replying to a message. This creates a message and is not idempotent.

## facebook_edit_message

Request replacement text for an owned message over MQTT. Experimental: acknowledgement is not verification; legacy history may still return original text.

## facebook_unsend_message

Unsend a message owned by the current account for the conversation participants.

## facebook_set_message_reaction

Set a reaction on a message; use an empty reaction to remove it.

## facebook_mark_thread_read

Change thread read state and potentially send a read receipt. Read uses connected MQTT when available; unread and HTTP-only sessions use the HTTP adapter.

## facebook_change_thread_nickname

Set a participant's nickname in a Messenger thread. An empty nickname resets it.

## facebook_change_thread_emoji

Set the Messenger thread's quick-reaction emoji.

## facebook_mute_thread

Mute a Messenger thread over MQTT. Use -1 indefinitely, 0 to unmute, or a duration in seconds. Read get_thread_info separately to verify.

## facebook_delete_message_for_me

Experimental MQTT remove-for-me request for one message. Distinct from unsending for everyone. Requires thread context; acknowledgement is not readback.

## facebook_change_thread_admin

Experimental MQTT participant-admin change. Requires group privileges. Acknowledgement is not verification.

## facebook_remove_thread_participant

Experimental MQTT group participant removal. Requires group privileges. Read thread metadata separately to verify.

## facebook_pin_message

Request pin or unpin of a Messenger message over MQTT. Server acknowledgement is not independently verified pin state.

## facebook_share_contact

Send a contact card over MQTT. Experimental adapter; this creates a message and is not idempotent.

## facebook_share_link

Send a link attachment with optional text using the HTTP message sender. This creates a message and is not idempotent.

## Events and resources

With a host event buffer, `facebook_get_events({ after?, limit? })` reads bounded non-consuming events and reports overflow. `facebook://capabilities` reports local tools/status, not a live health certificate.

Errors carry `code`, `retryable` and `outcomeUnknown`. Never turn an unknown mutation into an automatic retry. Cancellation stops local waiting, not necessarily the remote action.

<!-- generated:tool-catalog:end -->
