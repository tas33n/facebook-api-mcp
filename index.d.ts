/// <reference types="node" />
declare namespace FacebookApiMcp {
  interface AppStateCookie {
    key?: string;
    name?: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number | string;
    expirationDate?: number | string;
    [field: string]: unknown;
  }

  interface LoginCredentials {
    appState?: AppStateCookie[] | string;
    appstate?: AppStateCookie[] | string;
    appStatePath?: string;
    email?: string;
    username?: string;
    password?: string;
    twoFactorCode?: string | number | (() => Promise<string | number> | string | number);
    twoFactorCodeProvider?: () => Promise<string | number> | string | number;
    [field: string]: unknown;
  }

  interface LoginOptions {
    appStatePath?: string;
    sessionSavePath?: string;
    /** Durable engagement ledger file; its parent directory must already exist. */
    actionLedgerPath?: string;
    pruneCookies?: boolean;
    cookieRefreshIntervalMs?: number;
    mqttResponseTimeoutMs?: number;
    autoMarkDelivery?: boolean;
    autoMarkRead?: boolean;
    autoReconnect?: boolean;
    emitReady?: boolean;
    forceLogin?: boolean;
    listenEvents?: boolean;
    listenTyping?: boolean;
    online?: boolean;
    proxy?: string;
    requestTimeoutMs?: number;
    selfListen?: boolean;
    updatePresence?: boolean;
    userAgent?: string;
    verboseMqtt?: boolean;
    mqttUseMessengerDomain?: boolean;
    facebookOperations?: Record<string, string | { docId: string; transport?: "web-cookie"; source?: string }>;
    [option: string]: unknown;
  }

  interface MessageContent {
    body?: string;
    attachment?: unknown;
    mentions?: Array<{ tag: string; id: string; fromIndex?: number }>;
    emoji?: string;
    emojiSize?: "small" | "medium" | "large" | number;
    sticker?: string;
    location?: { latitude: number; longitude: number; current?: boolean; live?: boolean };
    url?: string;
    [field: string]: unknown;
  }

  interface NativeEvent {
    type?: string;
    threadID?: string;
    messageID?: string;
    senderID?: string;
    body?: string;
    attachments?: unknown[];
    mentions?: Record<string, string>;
    timestamp?: number | string;
    isGroup?: boolean;
    [field: string]: unknown;
  }

  type Callback<T = unknown> = (error: unknown, value?: T) => void;

  interface FacebookContent {
    id: string | null;
    url: string;
    kind: "post" | "photo" | "video" | "reel" | "story";
    text: string | null;
    title: string | null;
    media: Array<{ type: "image" | "video"; url: string }>;
    counts: { reactions: number | null; comments: number | null; shares: number | null };
    source: "embedded-page-data" | "open-graph-metadata";
    coverage: string;
  }

  interface FacebookNotification {
    id: string;
    text: string | null;
    url: string | null;
    timestamp: string | number | null;
    unread: boolean | null;
  }

  interface NotificationPage {
    items: FacebookNotification[];
    pageInfo: { hasMore: boolean; endCursor: string | null; coverage: string };
  }

  interface ContentAnalysis {
    content: FacebookContent;
    analysis: { kind: "deterministic-text-metadata"; characters: number; words: number;
      hashtags: string[]; links: string[]; mediaCount: number; limitations: string[] };
  }

  interface PostPageInfo {
    hasNextPage: boolean;
    endCursor: string | null;
  }

  interface PostMedia {
    id: string | null;
    type: "photo" | "video" | "reel";
    url: string | null;
    previewURL: string | null;
    playableURL: string | null;
  }

  interface FacebookPost {
    id: string | null;
    storyID: string | null;
    postID: string | null;
    url: string | null;
    text: string | null;
    authorID: string | null;
    feedbackID: string | null;
    kind: "text" | "photo" | "video" | "reel" | "mixed" | "share" | "unknown";
    createdTime: number | null;
    /** Normalized root-post audience; null when unavailable or ambiguous. */
    audience: PostAudience | null;
    sharedPostID: string | null;
    sharedStoryID: string | null;
    sharedURL: string | null;
    sharedMediaTypes: Array<"photo" | "video" | "reel">;
    media: PostMedia[];
    viewerReaction: { id: string | null; name: string | null } | null;
    viewerReactionKnown: boolean;
    viewerHasCommented: boolean | null;
    viewerHasShared: boolean | null;
    coverage: string;
  }

  interface GetPostResult extends FacebookPost {
    id: string;
    storyID: string;
    postID: string;
  }

  interface GetPostOptions {
    /** Post owner's decimal-string ID, required when looking up a numeric post ID. */
    actorID?: string;
  }

  /** A decimal-string post ID or base64 S:_I<actor>:<post> (also :<post> suffix alias). */
  type PostTarget = string | { postID: string; actorID?: string } | { storyID: string };
  type ExactPostTarget = { storyID: string; postID?: never; actorID?: never } | { postID: string; actorID: string; storyID?: never };
  type PostAudience = "PUBLIC" | "FRIENDS" | "SELF";
  interface DeletePostResult { deletedStoryID: string; verified: boolean }
  interface EditPostResult { storyID: string; text: string; verified: boolean }
  interface DeleteCommentResult { deletedCommentID: string; verified: boolean }
  interface EditCommentResult { commentID: string; text: string; verified: boolean }
  interface CommentManagementOptions { postID?: string; parentFeedbackID?: string; expansionToken?: string }
  interface SetPostAudienceResult { storyID: string; audience: PostAudience; verified: boolean }
  interface PublicationReadOptions { timeoutMs?: number; signal?: AbortSignal }
  interface VideoStatus {
    videoID: string;
    ownerID: string | null;
    status: string | null;
    videoStatusType: string | null;
    publishTime: number | null;
    creationStoryID: string | null;
    containerStoryID: string | null;
    storyID: string | null;
    playable: boolean;
    playback: { dash: boolean; sd: boolean; hd: boolean };
    hasStory: boolean;
    published: boolean;
    coverage: string;
  }
  interface VerifyPublicationOptions extends PublicationReadOptions {
    /** 1..20, default 3. */
    maxAttempts?: number;
    /** 100..30000, default 1000. */
    intervalMs?: number;
    expectedText?: string;
    expectedMediaType?: "text" | "photo" | "video" | "reel" | "mixed" | "share";
    expectedAudience?: string;
  }
  type PublicationStatus = "verified" | "pending" | "mismatch" | "unavailable" | "cancelled" | "timeout";
  interface PostPublicationEvidence {
    storyID: string;
    postID: string | null;
    authorID: string | null;
    kind: FacebookPost["kind"];
    audience: string | null;
    readable: true;
    checks: { text?: boolean | null; mediaType?: boolean | null; audience?: boolean | null };
  }
  interface VerifyPublicationResult {
    verified: boolean;
    status: PublicationStatus;
    attempts: number;
    target: { videoID: string } | { storyID: string; postID: string; actorID: string };
    evidence: PostPublicationEvidence | { video: VideoStatus; post?: PostPublicationEvidence } | null;
    history: Array<{ attempt: number; status: PublicationStatus; errorCode?: string }>;
    errorCode?: string;
  }
  interface PublishPostVerifiedResult {
    url: string;
    verification: VerifyPublicationResult | { verified: false; status: "unavailable"; reason: string; code?: string };
  }

  interface CommentPageOptions {
    limit?: number;
    cursor?: string | null;
  }

  interface CommentRepliesOptions extends CommentPageOptions {
    expansionToken?: string | null;
    clientKey?: string | null;
  }

  type PostCommentsTarget = string | (CommentPageOptions & ({ postID: string } | { feedbackID: string }));
  /** A comment feedback ID, not a comment ID. */
  type CommentRepliesTarget = string | (CommentRepliesOptions & { commentFeedbackID: string });

  interface PostComment {
    id: string;
    text: string | null;
    authorID: string | null;
    feedbackID: string | null;
    url: string | null;
    expansionToken: string | null;
    replyCount: number | null;
    repliesPageInfo: PostPageInfo | null;
  }

  interface PostCommentPage {
    items: PostComment[];
    pageInfo: PostPageInfo;
    coverage: string;
  }

  interface PostFilterOptions {
    types?: Array<"all" | "text" | "photo" | "video" | "reel" | "mixed" | "share">;
    keywords?: string[];
    keywordMode?: "any" | "all";
    authorID?: string | null;
    groupID?: string | null;
    /** Inclusive Unix seconds or ISO date/date-time with explicit timezone. Unknown dates are excluded. */
    since?: number | string | null;
    until?: number | string | null;
  }

  interface PostDiscoveryOptions extends PostFilterOptions {
    limit?: number;
    cursor?: string | null;
  }

  type SearchPostsOptions = PostDiscoveryOptions & {
    sessionID?: string;
  } & ({ query: string; hashtag?: string } | { query?: string; hashtag: string });

  interface DiscoveredPost extends FacebookPost {
    groupID: string | null;
  }

  interface PostDiscoveryPage {
    items: DiscoveredPost[];
    pageInfo: PostPageInfo;
    filterScope: "returned-page-only";
    scannedCount: number;
    requestedLimit: number;
    sourceEdgeCount: number;
    skippedCount: number;
    partial: boolean;
    unknownDateCount: number;
    dateFilter: { since: number | null; until: number | null; unknownDatePolicy: "exclude"; excludedUnknownDateCount: number };
    coverage: string;
  }

  interface SearchPostsPage extends PostDiscoveryPage {
    sessionID: string;
  }
  interface PagePostsPage extends PostDiscoveryPage {
    pageID: string;
    /** Validated delegate_page ID for a profile-plus User node; null for a direct Page node. */
    delegatePageID: string | null;
  }

  type ScanSource = "search" | "feed" | "profile" | "page" | "group";
  /** Host-owned durable checkpoint path; not an MCP tool argument. */
  type ScanPostsOptions = { checkpointPath: string; maxPages?: number; signal?: AbortSignal } & (
    ({ source: "search" } & SearchPostsOptions) |
    ({ source: "feed" } & PostDiscoveryOptions) |
    ({ source: "profile" | "page" | "group"; targetID: string } & PostDiscoveryOptions)
  );
  interface ScanPostPage extends PostDiscoveryPage {
    source: ScanSource;
    token: string;
    pageNumber: number;
    cursor: string | null;
    sessionID: string | null;
  }
  interface ScanPostsState {
    kind: "scan-checkpoint";
    accountID: string;
    fingerprint: string;
    generation: string;
    cursor: string | null;
    sessionID: string | null;
    pagesFetched: number;
    pagesAcknowledged: number;
    exhausted: boolean;
    seenCursors: string[];
    pending: ScanPostPage | null;
    lastAcknowledgedToken?: string;
  }
  /** next() redelivers pending pages until ack(token). clear() resets only this scan checkpoint. */
  interface ScanPostsJob extends AsyncIterableIterator<ScanPostPage> {
    next(): Promise<IteratorResult<ScanPostPage, undefined>>;
    ack(token: string): Promise<ScanPostsState>;
    status(): Promise<ScanPostsState>;
    clear(): Promise<ScanPostsState>;
    return(): Promise<IteratorReturnResult<undefined>>;
    [Symbol.asyncIterator](): ScanPostsJob;
  }

  type ActionStatus = "pending" | "completed" | "unknown" | "safe_retry";
  interface LedgerAction {
    type: "post" | "comment" | "reply" | "reaction" | "share";
    target?: string | number;
    targetID?: string | number;
    actor?: string | number;
    actorID?: string | number;
    text?: string;
    parent?: string | number;
    parentID?: string | number;
    reaction?: string | number;
    destination?: string | number;
    destinationID?: string | number;
  }
  interface NormalizedLedgerAction {
    accountID: string; actor: string; type: LedgerAction["type"]; target: string;
    text: string; parent: string; reaction: string; destination: string;
  }
  interface ActionReconciliationEvidence<T = unknown> {
    source: "server";
    matched: boolean;
    result?: T;
    coverage?: unknown;
  }
  interface ActionRecord<T = unknown> {
    action: NormalizedLedgerAction;
    status: ActionStatus;
    createdAt: string;
    updatedAt: string;
    revision?: number;
    result?: T;
    reconciliation?: ActionReconciliationEvidence<T>;
    history?: Array<{ status: ActionStatus; revision: number; updatedAt: string; result?: T }>;
  }
  interface ActionInspection<T = unknown> {
    key: string;
    durable: boolean;
    status: ActionStatus | "absent";
    revision: number;
    record?: ActionRecord<T>;
  }
  interface ActionReconciliation<T = unknown> extends ActionInspection<T> {
    reconciled: boolean;
    evidence?: ActionReconciliationEvidence<T>;
  }
  interface ActionLedger {
    accountID: string;
    path: string | null;
    durable: boolean;
    key(action: LedgerAction): string;
    inspect<T = unknown>(actionOrKey: LedgerAction | string): Promise<ActionInspection<T>>;
    status<T = unknown>(actionOrKey: LedgerAction | string): Promise<ActionInspection<T>>;
    /** Resolver must only read server state; negative/partial evidence never permits replay. */
    reconcile<T = unknown>(actionOrKey: LedgerAction | string,
      resolver: (action: NormalizedLedgerAction, view: ActionInspection<T>) => ActionReconciliationEvidence<T> | Promise<ActionReconciliationEvidence<T>>): Promise<ActionReconciliation<T>>;
    run<T>(action: LedgerAction, executor: () => T | Promise<T>, options?: {
      retrySafe?: boolean;
      expectedRevision?: number;
      refreshCompleted?: (record: ActionRecord<T>) => Promise<{ source: "server"; known: boolean; matches: boolean }>;
    }): Promise<{ duplicate: boolean; status: ActionStatus; key: string; revision?: number; result?: T }>;
  }
  interface ReconcileActionOptions {
    actorID?: string;
    storyID?: string;
    parentFeedbackID?: string;
    expansionToken?: string;
    maxScanPages?: number;
    inspectOnly?: boolean;
  }

  interface SharePostOptions {
    text?: string;
    baseState?: 1 | 2 | 3;
    groupID?: string;
  }

  interface CreateCommentResult {
    id: string;
    url: string;
    count: number | null;
  }

  interface PostReactionResult {
    viewer_feedback_reaction_info: unknown;
    supported_reactions: unknown;
    top_reactions: unknown[];
    reaction_count: unknown;
  }

  type EngagementReactionName = "unlike" | "like" | "heart" | "love" | "care" | "haha" | "wow" | "sad" | "angry";
  /** Reaction names are case-insensitive at runtime. */
  type EngagementReaction = EngagementReactionName | Uppercase<EngagementReactionName> | Capitalize<EngagementReactionName> | 0 | 1 | 2 | 16 | 4 | 3 | 7 | 8;

  interface EngagePostBaseOptions {
    postID: string;
    /** Owner of the post, not the acting account. */
    actorID?: string;
    storyID?: string;
    maxScanPages?: number;
  }

  type EngagePostOptions = EngagePostBaseOptions & (
    { action: "comment"; text: string } |
    { action: "reply"; text: string; parentCommentID: string; parentFeedbackID?: string; expansionToken?: string } |
    { action: "reaction"; reaction: EngagementReaction } |
    ({ action: "share"; url: string } & SharePostOptions)
  );

  interface EngagementScanCoverage {
    source: "server";
    scope: "parent-comments" | "comments" | "depth-1-replies";
    pagesScanned: number;
    maxScanPages: number;
    exhausted: boolean;
    note: string;
    parent?: EngagementScanCoverage;
  }

  type EngagementCoverage = EngagementScanCoverage |
    { source: "server"; scope: "viewer-reaction"; known: boolean; matches: boolean } |
    { source: "server" | "local-only"; scope: "share-deduplication"; viewerHasShared: boolean | null; note: string;
      historical: "unknown" | "matched"; pagesScanned: number; maxScanPages: number; exhausted: boolean; readError?: string };

  type EngagementEffect = {
    skipped: true;
    reason: "already-commented" | "already-replied" | "already-reacted" | "already-shared" | "reconciled";
    existingID?: string;
    provenance: "server";
    coverage: EngagementCoverage;
  } | {
    skipped: false;
    provenance: "mutation";
    coverage: EngagementCoverage;
    /** The underlying comment, reaction, or share API's mutation result. */
    mutation: CreateCommentResult | PostReactionResult | string;
  };

  type EngagePostResult = {
    duplicate: false;
    status: "completed";
    key: string;
    provenance: "server" | "mutation";
    result: EngagementEffect;
  } | {
    duplicate: true;
    status: "pending" | "completed" | "unknown" | "safe_retry";
    key: string;
    revision?: number;
    provenance: "ledger";
    result: EngagementEffect | undefined;
  };

  interface SelectedEngagementPost {
    postID: string;
    authorID?: string | null;
    storyID?: string | null;
    url?: string | null;
  }

  type EngagePostsAction = { maxScanPages?: number } & (
    { action: "comment"; text: string } |
    { action: "reaction"; reaction: EngagementReaction } |
    ({ action: "share" } & SharePostOptions)
  );

  type EngagePostsItemResult = ({ postID: string } & EngagePostResult) | {
    postID: string;
    status: "error";
    error: { code: string; outcome: string | null };
  };

  interface EngagePostsResult {
    results: EngagePostsItemResult[];
    complete: boolean;
    remaining: number;
    stoppedReason: "unknown-outcome" | "action-error" | null;
  }

  interface MessageEmitter {
    on(event: "message" | "error" | string, listener: (...args: unknown[]) => void): this;
    stopListening(callback?: Callback): void;
    stopListeningAsync(): Promise<void>;
  }

  interface Api {
    publishPostVerified(content: string | Record<string, unknown>, options?: VerifyPublicationOptions, callback?: Callback<PublishPostVerifiedResult>): Promise<PublishPostVerifiedResult>;
    publishPostVerified(content: string | Record<string, unknown>, callback: Callback<PublishPostVerifiedResult>): Promise<PublishPostVerifiedResult>;
    deletePost(target: PostTarget, options?: GetPostOptions, callback?: Callback<DeletePostResult>): Promise<DeletePostResult>;
    deletePost(target: PostTarget, callback: Callback<DeletePostResult>): Promise<DeletePostResult>;
    editPost(target: PostTarget, text: string, options?: GetPostOptions, callback?: Callback<EditPostResult>): Promise<EditPostResult>;
    editPost(target: PostTarget, text: string, callback: Callback<EditPostResult>): Promise<EditPostResult>;
    deleteCommentPost(commentID: string, options?: CommentManagementOptions, callback?: Callback<DeleteCommentResult>): Promise<DeleteCommentResult>;
    deleteCommentPost(commentID: string, callback: Callback<DeleteCommentResult>): Promise<DeleteCommentResult>;
    editCommentPost(commentID: string, text: string, options?: CommentManagementOptions, callback?: Callback<EditCommentResult>): Promise<EditCommentResult>;
    editCommentPost(commentID: string, text: string, callback: Callback<EditCommentResult>): Promise<EditCommentResult>;
    setPostAudience(target: PostTarget, audience: PostAudience, options?: GetPostOptions, callback?: Callback<SetPostAudienceResult>): Promise<SetPostAudienceResult>;
    setPostAudience(target: PostTarget, audience: PostAudience, callback: Callback<SetPostAudienceResult>): Promise<SetPostAudienceResult>;
    getVideoStatus(target: string | { videoID: string }, options?: PublicationReadOptions, callback?: Callback<VideoStatus>): Promise<VideoStatus>;
    getVideoStatus(target: string | { videoID: string }, callback: Callback<VideoStatus>): Promise<VideoStatus>;
    verifyPublication(target: ExactPostTarget | { videoID: string }, options?: VerifyPublicationOptions, callback?: Callback<VerifyPublicationResult>): Promise<VerifyPublicationResult>;
    verifyPublication(target: ExactPostTarget | { videoID: string }, callback: Callback<VerifyPublicationResult>): Promise<VerifyPublicationResult>;
    scanPosts(options: ScanPostsOptions): ScanPostsJob;
    reconcileAction(actionOrKey: LedgerAction | string, options: ReconcileActionOptions & { inspectOnly: true }, callback?: Callback<ActionInspection>): Promise<ActionInspection>;
    reconcileAction(actionOrKey: LedgerAction | string, options?: ReconcileActionOptions & { inspectOnly?: false }, callback?: Callback<ActionReconciliation>): Promise<ActionReconciliation>;
    reconcileAction(actionOrKey: LedgerAction | string, options: ReconcileActionOptions, callback?: Callback<ActionInspection | ActionReconciliation>): Promise<ActionInspection | ActionReconciliation>;
    reconcileAction(actionOrKey: LedgerAction | string, callback: Callback<ActionReconciliation>): Promise<ActionReconciliation>;
    publishVideoPost(options: { videoID: string; description?: string; baseState?: 1 | 2 | 3 }, callback?: Callback<{ videoID: string; url: string; status: "accepted"; published: null }>): Promise<{ videoID: string; url: string; status: "accepted"; published: null }>;
    __chikaDispose(): void;
    uploadPhoto(stream: import("node:stream").Readable, callback?: Callback<{ photoID: string; published: false }>): Promise<{ photoID: string; published: false }>;
    uploadVideo(filePath: string, options: { source: string | number; sourceType: string; targetID?: string }, callback?: Callback<{ videoID: string; uploadSessionID: string; bytesUploaded: number; published: false }>): Promise<{ videoID: string; uploadSessionID: string; bytesUploaded: number; published: false }>;
    publishVideo(options: { videoID: string; title?: string; description?: string; targetID?: string }, callback?: Callback<{ videoID: string; published: true }>): Promise<{ videoID: string; published: true }>;
    publishReel(options: { videoID: string; placements?: string[]; caption?: string; draft?: boolean; enableRemix?: boolean; embeddable?: boolean; durationSeconds?: number; targetID?: string }, callback?: Callback<{ videoID: string; published: boolean; draft: boolean }>): Promise<{ videoID: string; published: boolean; draft: boolean }>;
    createStory(options: { photoID?: string; videoID?: string; text?: string; textPresetID?: string; fontID?: string; privacy: "current" }, callback?: Callback<{ storyID: string; status: "accepted"; published: null; verification: string }>): Promise<{ storyID: string; status: "accepted"; published: null; verification: string }>;
    getFacebookCapabilities(): { authentication: "web-cookie"; features: Record<string, { status: string; verification?: string; reason?: string }>; operations: Array<{ name: string; docId: string; transport: "web-cookie"; source: string; verified: boolean }> };
    getContent(url: string, callback?: Callback<FacebookContent>): Promise<FacebookContent>;
    getPost(target: PostTarget, options?: GetPostOptions, callback?: Callback<GetPostResult>): Promise<GetPostResult>;
    getPost(target: PostTarget, callback: Callback<GetPostResult>): Promise<GetPostResult>;
    getPostComments(target: PostCommentsTarget, options?: CommentPageOptions, callback?: Callback<PostCommentPage>): Promise<PostCommentPage>;
    getPostComments(target: PostCommentsTarget, callback: Callback<PostCommentPage>): Promise<PostCommentPage>;
    getCommentReplies(target: CommentRepliesTarget, options?: CommentRepliesOptions, callback?: Callback<PostCommentPage>): Promise<PostCommentPage>;
    getCommentReplies(target: CommentRepliesTarget, callback: Callback<PostCommentPage>): Promise<PostCommentPage>;
    searchPosts(options: SearchPostsOptions, callback?: Callback<SearchPostsPage>): Promise<SearchPostsPage>;
    getFeedPosts(options?: PostDiscoveryOptions, callback?: Callback<PostDiscoveryPage>): Promise<PostDiscoveryPage>;
    getFeedPosts(callback: Callback<PostDiscoveryPage>): Promise<PostDiscoveryPage>;
    getProfilePosts(profileID: string, options?: PostDiscoveryOptions, callback?: Callback<PostDiscoveryPage>): Promise<PostDiscoveryPage>;
    getProfilePosts(profileID: string, callback: Callback<PostDiscoveryPage>): Promise<PostDiscoveryPage>;
    getGroupPosts(groupID: string, options?: PostDiscoveryOptions, callback?: Callback<PostDiscoveryPage>): Promise<PostDiscoveryPage>;
    getGroupPosts(groupID: string, callback: Callback<PostDiscoveryPage>): Promise<PostDiscoveryPage>;
    getPagePosts(pageID: string, options?: PostDiscoveryOptions, callback?: Callback<PagePostsPage>): Promise<PagePostsPage>;
    getPagePosts(pageID: string, callback: Callback<PagePostsPage>): Promise<PagePostsPage>;
    filterPosts<T extends FacebookPost>(items: T[], options?: PostFilterOptions): T[];
    sharePost(url: string, options?: SharePostOptions, callback?: Callback<string>): Promise<string>;
    sharePost(url: string, callback: Callback<string>): Promise<string>;
    engagePost(options: EngagePostOptions, callback?: Callback<EngagePostResult>): Promise<EngagePostResult>;
    engagePosts(posts: SelectedEngagementPost[], action: EngagePostsAction, callback?: Callback<EngagePostsResult>): Promise<EngagePostsResult>;
    analyzeContent(url: string, callback?: Callback<ContentAnalysis>): Promise<ContentAnalysis>;
    getNotifications(options?: { limit?: number; cursor?: string }, callback?: Callback<NotificationPage>): Promise<NotificationPage>;
    listenNotifications(options?: { intervalMs?: number; maxSeen?: number; emitExisting?: boolean }, callback?: Callback<FacebookNotification & { type: "notification" }>): MessageEmitter;
    getAppState(): AppStateCookie[];
    saveSession(): AppStateCookie[];
    refreshSession(callback?: Callback<{ refreshed: boolean; savedAt?: string; refreshedAt: string }>): Promise<{ refreshed: boolean; savedAt?: string; refreshedAt: string }>;
    getCurrentUserID(): string;
    getThreadInfo(threadId: string | string[], callback?: Callback<Record<string, unknown>>): Promise<unknown>;
    getThreadHistory(threadId: string, amount: number, timestamp?: number | null, callback?: Callback<unknown[]>): Promise<unknown[]>;
    getThreadHistory(threadId: string, amount: number, callback: Callback<unknown[]>): Promise<unknown[]>;
    getMessage(threadId: string, messageId: string, callback?: Callback<Record<string, unknown>>): Promise<Record<string, unknown>>;
    getThreadList(limit: number, timestamp: number | null, tags: string[], callback?: Callback<unknown[]>): Promise<unknown>;
    getUserInfo(userId: string | string[], callback?: Callback<Record<string, unknown>>): Promise<unknown>;
    getUserID(name: string, callback?: Callback<unknown[]>): Promise<unknown[]>;
    getFriendsList(callback?: Callback<unknown[]>): Promise<unknown>;
    listenMqtt(callback?: Callback<NativeEvent>): MessageEmitter;
    listen(callback?: Callback<NativeEvent>): MessageEmitter;
    stopListening?: (callback?: Callback) => void;
    stopListeningAsync?: () => Promise<void>;
    stopListenMqtt(): Promise<void>;
    sendMessage(
      message: string | MessageContent,
      threadId: string,
      callback?: Callback<{ messageID?: string; messageId?: string; threadID?: string }>,
      replyToMessageId?: string
    ): Promise<unknown>;
    sendMessageMqtt(
      message: string | MessageContent,
      threadId: string,
      callback?: Callback<{ messageID?: string | null; threadID?: string; otid?: string; acknowledged?: boolean }>,
      replyToMessageId?: string
    ): Promise<unknown>;
    editMessage(text: string, messageId: string, callback?: Callback): Promise<unknown>;
    unsendMessage(messageId: string, callback?: Callback): Promise<unknown>;
    deleteThread(threadOrList: string | string[], callback?: Callback): Promise<unknown>;
    /** MQTT remove-for-me; distinct from unsendMessage. Acknowledgement is not readback. */
    deleteMessage(messageIds: string | string[], threadId: string, callback?: Callback): Promise<unknown>;
    /** MQTT: -1 indefinitely, 0 unmute, positive integer duration in seconds. */
    muteThread(threadId: string, muteSeconds: number, callback?: Callback): Promise<unknown>;
    /** Experimental MQTT group administration; requires server-granted privileges. */
    changeAdminStatus(threadId: string, adminIds: string | string[], adminStatus: boolean, callback?: Callback): Promise<unknown>;
    removeUserFromGroup(userId: string, threadId: string, callback?: Callback): Promise<unknown>;
    sendTypingIndicator(threadId: string, callback?: Callback, isGroup?: boolean): ((endCallback?: Callback) => Promise<unknown>) & { started: Promise<unknown> };
    markAsRead(threadId: string, read?: boolean, callback?: Callback): Promise<unknown>;
    markAsRead(threadId: string, callback?: Callback): Promise<unknown>;
    markAsDelivered(threadId: string, messageId: string, callback?: Callback): Promise<unknown>;
    markAsReadAll(callback?: Callback): Promise<unknown>;
    markAsSeen(timestamp?: number, callback?: Callback): Promise<unknown>;
    markAsSeen(callback: Callback): Promise<unknown>;
    setTitle(title: string, threadId: string, callback?: Callback): Promise<unknown>;
    addUserToGroup(userIds: string | string[], threadId: string, callback?: Callback): Promise<unknown>;
    createNewGroup(participantIds: string[], title?: string, callback?: Callback<string>): Promise<string>;
    createPoll(title: string, threadId: string, options?: Record<string, boolean>, callback?: Callback): Promise<unknown>;
    changeGroupImage(image: unknown, threadId: string, callback?: Callback): Promise<unknown>;
    changeArchivedStatus(threadIds: string | string[], archived: boolean, callback?: Callback): Promise<unknown>;
    handleMessageRequest(threadIds: string | string[], accept: boolean, callback?: Callback): Promise<unknown>;
    forwardAttachment(attachmentId: string, recipients: string | string[], callback?: Callback): Promise<unknown>;
    resolvePhotoUrl(photoId: string, callback?: Callback<string>): Promise<string>;
    searchStickers(query?: string, callback?: Callback<unknown[]>): Promise<unknown[]>;
    setMessageReaction(
      reaction: string,
      messageId: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    setMessageReaction(
      reaction: string,
      messageId: string,
      callback?: Callback,
      forceCustom?: boolean
    ): Promise<unknown>;
    setMessageReactionMqtt(
      reaction: string,
      messageId: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    changeNickname(
      nickname: string,
      threadId: string,
      participantId: string,
      callback?: Callback
    ): Promise<unknown>;
    changeNicknameMqtt(
      nickname: string,
      threadId: string,
      participantId: string,
      callback?: Callback
    ): Promise<unknown>;
    setTheme(
      themeId: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    changeThreadColor(
      color: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    changeThreadEmoji(
      emoji: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    pinMessage(
      pinMode: boolean,
      messageId: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    changeBlockedStatus(
      userId: string,
      blocked: boolean,
      callback?: Callback
    ): Promise<unknown>;
    changeBlockedStatusMqtt(
      userId: string,
      blocked: boolean,
      callback?: Callback
    ): Promise<unknown>;
    changeBlockedStatusMqtt(
      userId: string,
      blocked: boolean,
      type: "messenger" | "facebook",
      callback?: Callback
    ): Promise<unknown>;
    setStoryReaction(
      storyId: string,
      reaction: number | string,
      callback?: Callback
    ): Promise<unknown>;
    setProfileGuard(
      shieldStatus: boolean,
      callback?: Callback
    ): Promise<unknown>;
    replyMessage(
      message: string | MessageContent,
      threadId: string,
      replyToMessageId: string,
      callback?: Callback
    ): Promise<unknown>;
    sendFriendRequest(
      userId: string,
      callback?: Callback
    ): Promise<unknown>;
    follow(
      userId: string,
      followStatus?: boolean,
      callback?: Callback
    ): Promise<unknown>;
    unfollow(
      userId: string,
      callback?: Callback
    ): Promise<unknown>;
    createPost(
      content: string | Record<string, unknown>,
      callback?: Callback<string>
    ): Promise<string>;
    createCommentPost(
      comment: string | Record<string, unknown>,
      postId: string,
      callback?: Callback<CreateCommentResult>,
      replyCommentId?: string
    ): Promise<CreateCommentResult>;
    /** Reply shorthand accepts a decimal-string ID or an encoded comment identity. */
    createCommentPost(
      comment: string | Record<string, unknown>,
      postId: string,
      replyCommentId: string
    ): Promise<CreateCommentResult>;
    setPostReaction(postId: string, reaction: string | number, callback?: Callback): Promise<unknown>;
    setCommentReaction(
      commentId: string,
      reactionType: string | number,
      callback?: Callback
    ): Promise<unknown>;
    shareContact(
      contactId: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    shareContact(text: string, contactId: string, threadId: string, callback?: Callback): Promise<unknown>;
    shareLink(
      url: string,
      threadId: string,
      callback?: Callback
    ): Promise<unknown>;
    shareLink(text: string, url: string, threadId: string, callback?: Callback): Promise<unknown>;
    uploadAttachment(
      attachments: unknown | unknown[],
      callback?: Callback<unknown[]>
    ): Promise<unknown>;
    setOptions(options: LoginOptions): void;
    [method: string]: unknown;
  }

  interface Login {
    (credentials: LoginCredentials | AppStateCookie[] | string, callback: Callback<Api>): void;
    (
      credentials: LoginCredentials | AppStateCookie[] | string,
      options?: LoginOptions
    ): Promise<Api>;
    (
      credentials: LoginCredentials | AppStateCookie[] | string,
      options: LoginOptions,
      callback: Callback<Api>
    ): void;
    login: Login;
    buildAPI: (...arguments_: unknown[]) => unknown;
    setOptions: (globalOptions: LoginOptions, options: LoginOptions) => void;
    utils: Record<string, unknown>;
    logger: (...arguments_: unknown[]) => unknown;
    FacebookSafety: new (...arguments_: any[]) => any;
    LoginManager: new (...arguments_: any[]) => any;
    ApiFactory: new (...arguments_: any[]) => any;
  }
}

declare const login: FacebookApiMcp.Login;
export = login;
