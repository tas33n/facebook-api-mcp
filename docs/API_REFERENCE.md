# API reference

Method-oriented reference for **Facebook API MCP**. See the [complete active API
index](#complete-source-api-index), [MCP catalog](MCP.md#complete-tool-catalog), and `index.d.ts` for extended
types. This guide follows the useful signature/arguments/example layout of
ntkhang03's FCA documentation; examples and current contracts are written here.

## Contents

- [Login](#login)
- [Send and reply](#send-and-reply)
- [Listen and events](#listen-and-events)
- [Reads and pagination](#reads-and-pagination)
- [Message actions](#message-actions)
- [Thread management](#thread-management)
- [Facebook posts and discovery](#facebook-posts-and-discovery)
- [Notifications](#notifications)
- [Errors and lifecycle](#errors-and-lifecycle)

## Login

`login(credentials, options?, callback?) -> Promise<Api> | undefined`

| Argument | Contract |
| --- | --- |
| `credentials.appStatePath` | Absolute/private JSON cookie file; rotations persist atomically |
| `credentials.appState` | Cookie array for host-owned persistence |
| `options` | `listenEvents`, `emitReady`, `autoMarkRead`, `autoMarkDelivery`, `online`, timeouts and persistence settings |
| `callback(error, api)` | Callback mode returns undefined; omit to await a Promise |

```js
const login = require("facebook-api-mcp");
const api = await login({ appStatePath: process.env.FACEBOOK_APP_STATE_PATH }, {
  emitReady: true, listenEvents: true, autoMarkRead: false, autoMarkDelivery: false
});
```

ESM uses `import login from "facebook-api-mcp"`. Do not log the authenticated API
object or app-state contents.

## Send and reply

`sendMessage(message, threadID, callback?, replyToMessageID?, isGroup?)`

Returns a Promise with `{ messageID, threadID, timestamp }`. Callback receives
the same success/error. `threadID` is a string; an explicit participant-ID array
can create a conversation. Prefer known thread IDs to implicit new conversations.

| Message field | Value |
| --- | --- |
| `body` | String text |
| `attachment` | Readable stream or array of streams; HTTP also accepts supported staged `[type_id, id]` pairs |
| `url` | HTTP(S) URL attachment (HTTP sender) |
| `sticker` | Sticker ID string |
| `emoji`, `emojiSize` | Emoji with `small`, `medium`, `large`; do not combine with body |
| `mentions` | Array of `{ id, tag, fromIndex? }`; tag must occur in body |
| `location` | Finite `latitude`, `longitude`, optional `current`; live-location sessions unsupported |

```js
await api.sendMessage("Hello", threadID);
await api.sendMessage({ body: "Hello Alex", mentions: [{ id: userID, tag: "Alex" }] }, threadID);
await api.sendMessage({ body: "Photo", attachment: require("node:fs").createReadStream("photo.jpg") }, threadID);
await api.sendMessage("Reply", threadID, undefined, originalMessageID);
await api.replyMessage("Reply", threadID, originalMessageID);
```

`sendMessageMqtt(message, threadID, callback?, replyToMessageID?)` requires ready
MQTT. Result may have `messageID: null`, a separate `otid`, and
`acknowledged: true`; never substitute the offline ID for a server message ID.
URL attachments use the HTTP method. Invalid inputs fail before upload.

`shareLink(text, url, threadID, callback?)` / `shareLink(url, threadID, callback?)`
use the HTTP URL sender. `shareContact(text, contactID, threadID, callback?)` /
`shareContact(contactID, threadID, callback?)` use experimental MQTT contact cards.
`uploadAttachment(streams, callback?)` returns attachment metadata, not sent messages.

## Listen and events

`listenMqtt(callback?) -> listener`; `listen` aliases it.
`listener.stopListeningAsync() -> Promise<void>`; callback stop is also supported.
Without a callback, attach `message` and `error` emitter listeners immediately.

| Event | Principal fields |
| --- | --- |
| `message`, `message_reply` | `messageID`, `threadID`, `senderID`, `body`, `attachments`, `mentions`, `timestamp`, `isGroup`; reply adds `messageReply` |
| `message_reaction` | `messageID`, `threadID`, `userID` (reactor), `senderID` (message author), `reaction` |
| `message_unsend` | Message/thread/sender IDs, deletion timestamp |
| `event` | `threadID`, `author`, `logMessageType`, `logMessageData`, `logMessageBody` |
| `typ` | `threadID`, `from`, `isTyping` |
| `presence` | `userID`, `timestamp`, `statuses`; may have no thread ID |
| `message_deleted`, `thread_deleted` | Deletion notifications; not equivalent to an unsend event |
| `ready` | Initial synchronization completed when `emitReady` is enabled |

Enable `listenEvents` for relevant reaction/group events. Never assume all native
or encrypted event variants are implemented. `mentions` is normally an ID-to-tag
map. Group events include join/leave, admin, nickname, title, theme and emoji changes.

`sendTypingIndicator(threadID, callback?, isGroup?)` returns `stopTyping`.
Await `stopTyping.started` for start completion and `await stopTyping()` to stop.

## Reads and pagination

| Method | Result / notes |
| --- | --- |
| `getCurrentUserID()` | Active account ID |
| `getUserInfo(idOrIDs, callback?)` | Object keyed by requested user IDs; optional fields can be null |
| `getUserID(name, callback?)` | Search results; select/validate an identity, never assume first is correct |
| `getThreadInfo(idOrIDs, callback?)` | Single info object, or keyed batch; names, participantIDs, userInfo, adminIDs, nicknames, threadTheme, muteUntil |
| `getThreadList(limit, before, tags, callback?)` | Thread array; before is millisecond timestamp or null; tags such as `["INBOX"]` |
| `getThreadHistory(threadID, amount, before?, callback?)` | Bounded message array; paginate using earliest timestamp and deduplicate message IDs |
| `getMessage(threadID, messageID, callback?)` | One message; missing node rejects |

```js
const history = await api.getThreadHistory(threadID, 25, null);
const times = history.map(m => Number(m.timestamp)).filter(Number.isFinite);
const nextBefore = times.length ? Math.min(...times) : null;
// Stop on empty/nonadvancing pages; timestamp ties can limit complete enumeration.
```

`muteUntil` is server-supplied and may use seconds; message/thread cursors use
millisecond timestamps. Actor type `ReducedMessagingActor` does not prove a
deactivated account. Do not treat every non-User as removable.

## Message actions

| Method | Contract |
| --- | --- |
| `setMessageReaction(reaction, messageID, threadID, callback?)` | Connected MQTT when thread supplied; empty string removes reaction |
| `setMessageReaction(reaction, messageID, callback?, forceCustom?)` | Legacy HTTP callback signature |
| `editMessage(text, messageID, callback?)` | MQTT, acknowledged but `verified: false`; legacy readback unresolved |
| `pinMessage(pinned, messageID, threadID, callback?)` | MQTT; boolean pinned, independent verification pending |
| `unsendMessage(messageID, callback?)` | Remove owned message for recipients where allowed |
| `deleteMessage(messageIDs, threadID, callback?)` | Remove for current account only; thread ID required |
| `markAsRead(threadID, read?, callback?)` | Read uses connected MQTT; unread/HTTP-only uses HTTP |
| `markAsDelivered(threadID, messageID, callback?)` | Delivery receipt |
| `markAsReadAll(callback?)`, `markAsSeen(timestamp?, callback?)` | Account-wide receipt effects; use intentionally |

Remove-for-me may make a later unsend unavailable. Deleted IDs can remain as
tombstones. An empty history page alone does not prove global deletion.

## Thread management

| Method | Arguments / behavior |
| --- | --- |
| `muteThread(threadID, seconds, cb?)` | -1 indefinitely; 0 unmute; positive duration |
| `changeAdminStatus(threadID, IDs, isAdmin, cb?)` | Experimental MQTT; requires group privileges |
| `removeUserFromGroup(userID, threadID, cb?)` | Experimental MQTT; verify membership separately |
| `addUserToGroup(IDs, threadID, cb?)` | Existing HTTP adapter |
| `changeNickname(text, threadID, participantID, cb?)` | Empty resets; MQTT preferred when connected |
| `changeThreadColor(themeID, threadID, cb?)`, `setTheme(themeID, threadID, cb?)` | Numeric theme ID, MQTT required; `threadColors` contains known IDs |
| `changeThreadEmoji(emoji, threadID, cb?)`, `setTitle(title, threadID, cb?)` | Existing HTTP adapters |
| `changeGroupImage(stream, threadID, cb?)` | Upload and group image change |
| `createNewGroup(participants, title?, cb?)` | At least two participant IDs |
| `createPoll(title, threadID, options?, cb?)` | Options map label to selected boolean; deployment-sensitive |
| `changeArchivedStatus(IDs, archived, cb?)` | Account inbox organization |
| `handleMessageRequest(IDs, accept, cb?)` | Inbox/other request handling |
| `deleteThread(IDs, cb?)` | Removes current account's thread view |

## Facebook posts and discovery

```js
const page = await api.searchPosts({ query: "gardening", limit: 10 });
const post = page.items[0];
if (post) await api.engagePost({ action: "comment", postID: post.postID, text: "Useful guide!" });
```

Configure a persistent `actionLedgerPath` before engagement. Use exact target
identities and required actor/feedback context from reads. APIs include
`getPost`, `getPostComments`, `getCommentReplies`, `getFeedPosts`, `getProfilePosts`,
`getGroupPosts`, `getPagePosts`, `filterPosts`, `scanPosts`, `reconcileAction`,
`createPost`, `createCommentPost`, `sharePost`, `editPost`, `deletePost`,
`editCommentPost`, `deleteCommentPost`, `setPostAudience`, `setPostReaction`.

See the detailed social API sections below and `index.d.ts` for structured options.
`uploadVideo` stages media; `publishVideoPost` uses the profile composer with
Public default. `publishPostVerified` and `verifyPublication` perform bounded
readback. Dedicated Reel/Story and generic video publishing remain experimental.

## Notifications

`getNotifications({ limit?, cursor? }, callback?)` returns `{ items, pageInfo }`.
`listenNotifications(options?, callback?)` provides bounded polling, not durable
push. Stop its handle on shutdown. `getContent`/`analyzeContent` offer limited
metadata parsing, not image/video understanding.

## Errors and lifecycle

`setOptions(options)` changes runtime settings; configure identity/login settings
before login. `getAppState`/`saveSession` expose credentials to trusted host code.
`refreshSession()` is single-flight and flushes configured cookie files.
`disposeApi(api)` closes local resources without logout.

`HTTP_OUTCOME_UNKNOWN`, `MQTT_RESPONSE_TIMEOUT`, `MQTT_DISCONNECTED` and
`MQTT_TASK_FAILED` require outcome-aware handling. A local timeout/cancellation
does not cancel Facebook's action. Utility/debug HTTP/context methods in the
source index are trusted-host APIs and are not exposed as arbitrary MCP tools.

## Social API details

### Targets and discovery

`getPost(target, options?, callback?)` accepts `{ postID, actorID }`, `{ storyID }`,
or a supported encoded story identity. Numeric post IDs require the post owner's
ID; it does not switch the acting account. Do not decode arbitrary pfbid URLs.

Discovery returns one connection page with `items`, `pageInfo`, `coverage`,
`partial`, `scannedCount` and `filterScope: "returned-page-only"`.
`getProfilePosts`, `getPagePosts`, `getGroupPosts` take a target ID then options;
`getFeedPosts` and `searchPosts` take options directly.

| Option | Contract |
| --- | --- |
| `query`, `hashtag` | Search requires at least one; hashtag is one tag |
| `limit` | 1–50, default 5; server may return more, bounded to 100 source edges |
| `cursor`, `sessionID` | Genuine returned continuation values; reuse search session and filters |
| `types` | `all`, `text`, `photo`, `video`, `reel`, `mixed`, `share` |
| `keywords`, `keywordMode` | Root-text substring matching, Unicode-normalized; `any` or `all` |
| `authorID`, `groupID` | Local filters on returned pages |
| `since`, `until` | Inclusive Unix seconds or ISO date/time with timezone; not millisecond timestamps |

```js
const options = { query: "gardening", limit: 10, types: ["photo", "video"] };
const first = await api.searchPosts(options);
if (first.pageInfo.hasNextPage) {
  const next = await api.searchPosts({ ...options,
    cursor: first.pageInfo.endCursor, sessionID: first.sessionID });
}
```

Empty filtered pages can have a next cursor. Retain the full returned page;
deduplicate across pages and stop repeated cursors. Page identity must be validated
as a Page or supported profile-plus Page. Group reads cover regular discussion,
not announcements. Shared originals stay separate from root text/identity/privacy.
These readers are not complete historical exports.

`getPostComments(postID, { limit, cursor })` and
`getCommentReplies(feedbackID, { limit, cursor, expansionToken, clientKey })`
request 1–100 items (default 20). Reply reads need the parent comment's feedback
ID, not the post's feedback ID; forward returned continuation tokens.

### Ledger-backed engagement

Configure `actionLedgerPath` at login to an existing persistent directory.
`engagePost` requires durable history; direct compatibility mutations do not
automatically use this ledger.

| Action | Required fields beyond `action`, `postID` |
| --- | --- |
| `comment` | Nonblank `text` |
| `reply` | `text`, `parentCommentID`; parent feedback/token may be supplied |
| `reaction` | `reaction` and `actorID` or `storyID` |
| `share` | HTTPS Facebook `url`; optional text/destination/audience |

```js
await api.engagePost({ action: "comment", postID, text: "Thanks for the guide!", maxScanPages: 3 });
const state = await api.reconcileAction(ledgerKey, { inspectOnly: true });
const reconciled = await api.reconcileAction(ledgerKey, { actorID, maxScanPages: 3 });
```

Comment/reply scans use `maxScanPages` 1–10 (default 3). Unknown/partial state
does not establish absence. Reactions accept `unlike`, `like`, `heart`, `love`,
`care`, `haha`, `wow`, `sad`, `angry`; historical mapping is heart=2, love/care=16.
Shares default Public (`baseState: 1`; Friends=2, Self=3).

Results distinguish ledger duplicates (`duplicate`, `provenance: "ledger"`),
existing remote effects (`result.skipped`, `provenance: "server"`) and new
mutations. Reservations precede effects. Recovered pending/unknown actions never
automatically replay. Reconciliation requires positive matching evidence; negative
reads do not authorize retries. Historical share checks may be local-ledger-only.
`engagePosts` validates a bounded selection and executes sequentially.

### Publishing and management

```js
const url = await api.createPost({ body: "Hello", baseState: 3 });
const staged = await api.uploadVideo("clip.mp4", { source: "composer", sourceType: "composer" });
const accepted = await api.publishVideoPost({ videoID: staged.videoID, description: "Caption" });
const verified = await api.verifyPublication({ videoID: staged.videoID }, { expectedText: "Caption" });

const target = { postID, actorID };
await api.editPost(target, "Updated text");
await api.setPostAudience(target, "PUBLIC");
await api.editCommentPost(commentID, "Updated comment", { postID });
// Destructive actions are explicit:
await api.deleteCommentPost(commentID, { postID });
await api.deletePost(target);
```

Numeric comment IDs need post context; reply checks may need `parentFeedbackID`
and `expansionToken`. A missing item in a partial page is not verified deletion.
Profile video publication defaults Public. Generic `publishVideo`, dedicated
`publishReel` and `createStory` remain experimental; do not use them as automatic
fallbacks. `publishReel` sends `actor_id` and the web composer's full input with `placements` defaulting to `["FACEBOOK_REEL"]`; Facebook accepts it, but videos staged by `uploadVideo` stay `UPLOADING` (live check 2026-11-08). For a Reel, publish a vertical video with `publishVideoPost`. `publishVideo` fails `1675030` for personal profiles. Stories require
`privacy: "current"`, and text Stories need current `fontID`/`textPresetID`.
Stage separate media for separate publications; upload does not publish.

`publishPostVerified(content, options?)` creates once and checks the resulting
identity. `getVideoStatus(videoID)` requires status OK, a linked story and playback
URL evidence before reporting published; it does not download playback bytes.
`verifyPublication` accepts `{ videoID }`, `{ storyID }`, or `{ postID, actorID }`.

| Verification option | Default / bounds |
| --- | --- |
| `maxAttempts` | 3 / 1–20 |
| `intervalMs` | 1000 / 100–30000 |
| `timeoutMs` | 30000 / 1–600000 |
| `expectedText`, `expectedMediaType`, `expectedAudience` | Exact exposed field comparisons |
| `signal` | AbortSignal; cannot undo an in-flight remote request |

Results preserve `verified`, `status`, `attempts`, `evidence` and bounded history.
Statuses include verified, pending, mismatch, unavailable, timeout and cancelled.
Audience cannot be inferred from readability. Verification failure never republishes.
Signed playback URLs and raw errors are omitted from verification evidence.

### Resumable scans

```js
const job = api.scanPosts({ source: "group", targetID: groupID,
  checkpointPath: "/persistent/group-scan.json", limit: 10, maxPages: 20 });
for await (const page of job) {
  await consumePage(page.items);
  await job.ack(page.token);
}
```

Sources: search, feed, profile, page, group. Checkpoints bind account, target,
filters and limits. Pending pages persist before delivery and replay after a crash
until acknowledged. This is at-least-once delivery; consumers must be idempotent.
`status()` inspects progress, `return()` stops, `clear()` explicitly resets.

## Capability limits

Selected-account live checks cover cookie rotation, reads, text sends/replies,
reactions, nicknames/themes, mute/unmute, remove-for-me, text/photo/profile-video
publishing, notifications, selected discovery and social management. They are
not universal platform certification.

- Message edit: acknowledged, independent legacy-history readback unresolved.
- Admin/removal, pin/contact sharing: incomplete independent live verification.
- Media variants, group creation/polls and remaining HTTP adapters: deployment-sensitive.
- Native E2EE: not implemented; general encrypted-DM coverage unestablished.
- Generic video/Reels/Stories: experimental; upload acceptance is not publication.
- Content analysis: limited metadata/text parsing, no vision or transcription.
- Remove-for-me may prevent later unsend; tombstones can retain IDs.
- Discovery/notification polling can be partial; no complete-archive guarantee.

Web protocol overrides use `facebookOperations` with a matching web-cookie doc ID,
variables and response shape. Native OAuth/APK identifiers are not interchangeable.

<!-- generated:api-index:start -->
## Complete source API index

Generated from active top-level modules. Export presence is not live certification; see the capability limits above.

| Method | Source signature (callback optional unless noted) |
| --- | --- |
| [`addExternalModule`](../src/addExternalModule.js) | `moduleObj` |
| [`addUserToGroup`](../src/addUserToGroup.js) | `userID, threadID, callback` |
| [`analyzeContent`](../src/analyzeContent.js) | `See source / typed declarations` |
| [`changeAdminStatus`](../src/changeAdminStatus.js) | `threadID, adminIDs, adminStatus, callback` |
| [`changeArchivedStatus`](../src/changeArchivedStatus.js) | `threadOrThreads, archive, callback` |
| [`changeAvatar`](../src/changeAvatar.js) | `image, caption = "", timestamp = null, callback` |
| [`changeBio`](../src/changeBio.js) | `bio, publish, callback` |
| [`changeBlockedStatus`](../src/changeBlockedStatus.js) | `userID, block, callback` |
| [`changeBlockedStatusMqtt`](../src/changeBlockedStatusMqtt.js) | `userID, status, type, callback` |
| [`changeCover`](../src/changeCover.js) | `image, callback` |
| [`changeGroupImage`](../src/changeGroupImage.js) | `image, threadID, callback` |
| [`changeName`](../src/changeName.js) | `input, format, callback` |
| [`changeNickname`](../src/changeNickname.js) | `nickname, threadID, participantID, callback` |
| [`changeNicknameMqtt`](../src/changeNicknameMqtt.js) | `nickname, threadID, participantID, callback` |
| [`changeThreadColor`](../src/changeThreadColor.js) | `color, threadID, callback` |
| [`changeThreadEmoji`](../src/changeThreadEmoji.js) | `emoji, threadID, callback` |
| [`changeUsername`](../src/changeUsername.js) | `username, callback` |
| [`createCommentPost`](../src/createCommentPost.js) | `msg, postID, callback, replyCommentID` |
| [`createNewGroup`](../src/createNewGroup.js) | `participantIDs, groupTitle, callback` |
| [`createPoll`](../src/createPoll.js) | `title, threadID, options, callback` |
| [`createPost`](../src/createPost.js) | `msg, callback` |
| [`createStory`](../src/createStory.js) | `See source / typed declarations` |
| [`deleteCommentPost`](../src/deleteCommentPost.js) | `See source / typed declarations` |
| [`deleteMessage`](../src/deleteMessage.js) | `messageIDs, threadID, callback` |
| [`deletePost`](../src/deletePost.js) | `See source / typed declarations` |
| [`deleteThread`](../src/deleteThread.js) | `threadOrThreads, callback` |
| [`editCommentPost`](../src/editCommentPost.js) | `See source / typed declarations` |
| [`editMessage`](../src/editMessage.js) | `text, messageID, callback` |
| [`editPost`](../src/editPost.js) | `See source / typed declarations` |
| [`engagePost`](../src/engagePost.js) | `options, callback` |
| [`engagePosts`](../src/engagePosts.js) | `See source / typed declarations` |
| [`filterPosts`](../src/filterPosts.js) | `See source / typed declarations` |
| [`follow`](../src/follow.js) | `senderID, boolean, callback` |
| [`forwardAttachment`](../src/forwardAttachment.js) | `attachmentID, userOrUsers, callback` |
| [`getAvatarUser`](../src/getAvatarUser.js) | `userIDs, size = [1500, 1500], callback` |
| [`getBotInitialData`](../src/getBotInitialData.js) | `See source / typed declarations` |
| [`getCommentReplies`](../src/getCommentReplies.js) | `target, options = {}, callback` |
| [`getContent`](../src/getContent.js) | `See source / typed declarations` |
| [`getCtx`](../src/getCtx.js) | `See source / typed declarations` |
| [`getCurrentUserID`](../src/getCurrentUserID.js) | `` |
| [`getEmojiUrl`](../src/getEmojiUrl.js) | `c, size, pixelRatio` |
| [`getFacebookCapabilities`](../src/getFacebookCapabilities.js) | `See source / typed declarations` |
| [`getFeedPosts`](../src/getFeedPosts.js) | `See source / typed declarations` |
| [`getFriendsList`](../src/getFriendsList.js) | `callback` |
| [`getGroupPosts`](../src/getGroupPosts.js) | `See source / typed declarations` |
| [`getMessage`](../src/getMessage.js) | `threadID, messageID, callback` |
| [`getNotifications`](../src/getNotifications.js) | `See source / typed declarations` |
| [`getOptions`](../src/getOptions.js) | `See source / typed declarations` |
| [`getPagePosts`](../src/getPagePosts.js) | `See source / typed declarations` |
| [`getPost`](../src/getPost.js) | `target, options = {}, callback` |
| [`getPostComments`](../src/getPostComments.js) | `target, options = {}, callback` |
| [`getProfilePosts`](../src/getProfilePosts.js) | `See source / typed declarations` |
| [`getRegion`](../src/getRegion.js) | `` |
| [`getThreadHistory`](../src/getThreadHistory.js) | `threadID, amount, timestamp, callback` |
| [`getThreadInfo`](../src/getThreadInfo.js) | `threadID, callback` |
| [`getThreadList`](../src/getThreadList.js) | `limit, timestamp, tags, callback` |
| [`getUserID`](../src/getUserID.js) | `name, callback` |
| [`getUserInfo`](../src/getUserInfo.js) | `id, callback` |
| [`getVideoStatus`](../src/getVideoStatus.js) | `target, options = {}, callback` |
| [`handleMessageRequest`](../src/handleMessageRequest.js) | `threadID, accept, callback` |
| [`httpGet`](../src/httpGet.js) | `url, form, customHeader, callback, notAPI` |
| [`httpPost`](../src/httpPost.js) | `url, form, customHeader, callback, notAPI` |
| [`httpPostFormData`](../src/httpPostFormData.js) | `url, form, customHeader, callback, notAPI` |
| [`listenMqtt`](../src/listenMqtt.js) | `callback` |
| [`listenNotifications`](../src/listenNotifications.js) | `See source / typed declarations` |
| [`logout`](../src/logout.js) | `callback` |
| [`markAsDelivered`](../src/markAsDelivered.js) | `threadID, messageID, callback` |
| [`markAsRead`](../src/markAsRead.js) | `threadID, read = true, callback` |
| [`markAsReadAll`](../src/markAsReadAll.js) | `callback` |
| [`markAsSeen`](../src/markAsSeen.js) | `seen_timestamp, callback` |
| [`muteThread`](../src/muteThread.js) | `threadID, muteSeconds, callback` |
| [`pinMessage`](../src/pinMessage.js) | `pinMode, messageID, threadID, callback` |
| [`postFormData`](../src/postFormData.js) | `url, form, callback` |
| [`publishPostVerified`](../src/publishPostVerified.js) | `See source / typed declarations` |
| [`publishReel`](../src/publishReel.js) | `options, callback` |
| [`publishVideo`](../src/publishVideo.js) | `options, callback` |
| [`publishVideoPost`](../src/publishVideoPost.js) | `See source / typed declarations` |
| [`reconcileAction`](../src/reconcileAction.js) | `actionOrKey, options = {}, callback` |
| [`refreshFb_dtsg`](../src/refreshFb_dtsg.js) | `obj, callback` |
| [`removeUserFromGroup`](../src/removeUserFromGroup.js) | `userID, threadID, callback` |
| [`replyMessage`](../src/replyMessage.js) | `msg, threadID, replyToMessageID, callback` |
| [`resolvePhotoUrl`](../src/resolvePhotoUrl.js) | `photoID, callback` |
| [`scanPosts`](../src/scanPosts.js) | `options` |
| [`searchPosts`](../src/searchPosts.js) | `See source / typed declarations` |
| [`searchStickers`](../src/searchStickers.js) | `query = '', callback` |
| [`sendFriendRequest`](../src/sendFriendRequest.js) | `userID, callback` |
| [`sendMessage`](../src/sendMessage.js) | `msg, threadID, callback, replyToMessage, isGroup` |
| [`sendMessageMqtt`](../src/sendMessageMqtt.js) | `msg, threadID, callback, replyToMessage` |
| [`sendTypingIndicator`](../src/sendTypingIndicator.js) | `threadID, callback, isGroup` |
| [`setCommentReaction`](../src/setCommentReaction.js) | `commentID, reactionType, callback` |
| [`setMessageReaction`](../src/setMessageReaction.js) | `reaction, messageID, threadID, callback` |
| [`setMessageReactionMqtt`](../src/setMessageReactionMqtt.js) | `reaction, messageID, threadID, callback` |
| [`setPostAudience`](../src/setPostAudience.js) | `See source / typed declarations` |
| [`setPostReaction`](../src/setPostReaction.js) | `postID, type, callback` |
| [`setProfileGuard`](../src/setProfileGuard.js) | `See source / typed declarations` |
| [`setStoryReaction`](../src/setStoryReaction.js) | `storyID, react, callback` |
| [`setTheme`](../src/setTheme.js) | `See source / typed declarations` |
| [`setTitle`](../src/setTitle.js) | `newTitle, threadID, callback` |
| [`shareContact`](../src/shareContact.js) | `text, contactID, threadID, callback` |
| [`shareLink`](../src/shareLink.js) | `text, url, threadID, callback` |
| [`sharePost`](../src/sharePost.js) | `See source / typed declarations` |
| [`stopListenMqtt`](../src/stopListenMqtt.js) | `` |
| [`threadColors`](../src/threadColors.js) | `See source / typed declarations` |
| [`unfollow`](../src/unfollow.js) | `senderID, callback` |
| [`unsendMessage`](../src/unsendMessage.js) | `messageID, callback` |
| [`uploadAttachment`](../src/uploadAttachment.js) | `attachments, callback` |
| [`uploadPhoto`](../src/uploadPhoto.js) | `See source / typed declarations` |
| [`uploadVideo`](../src/uploadVideo.js) | `filePath, options, callback` |
| [`verifyPublication`](../src/verifyPublication.js) | `target, options = {}, callback` |

Base lifecycle methods include `setOptions`, `getAppState`, `getCurrentUserID`, `saveSession`, `refreshSession`, listener stop methods and `__chikaDispose` (legacy host compatibility hook). Prefer `disposeApi(api)` for application cleanup.

<!-- generated:api-index:end -->
