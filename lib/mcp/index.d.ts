import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ZodTypeAny } from "zod";

/** An existing authenticated FCA login result or an injected test double. */
export type FacebookApi = object;
export type EventSource = "mqtt" | "notifications" | "host";
export interface EventBufferOptions {
  capacity?: number;
  maxBytes?: number;
  secretValues?: string[];
}
export interface BufferedEvent {
  cursor: number;
  source: EventSource;
  receivedAt: number;
  event: unknown;
}
export interface EventPage {
  items: BufferedEvent[];
  nextCursor: number;
  latestCursor: number;
  oldestCursor: number;
  hasMore: boolean;
  overflow: boolean;
  missed: number;
  droppedTotal: number;
}
export interface EventBufferStatus {
  state: "open" | "closed";
  capacity: number;
  maxBytes: number;
  size: number;
  bytes: number;
  latestCursor: number;
  droppedTotal: number;
  errorCount: number;
}
export interface EventBuffer {
  publish(event: unknown, source?: EventSource): number;
  publishError(error: unknown, source?: EventSource): number;
  read(options?: { after?: number; limit?: number }): EventPage;
  status(): EventBufferStatus;
  close(): void;
}
export interface RegistryOptions {
  timeoutMs?: number;
  maxConcurrent?: number;
  secretValues?: string[];
  eventBuffer?: EventBuffer;
}
export interface ToolDescriptor {
  name: string;
  method: string | null;
  description: string;
  schema: ZodTypeAny;
  discoverySchema?: ZodTypeAny;
  annotations: ToolAnnotations;
}
export interface RegistryStatus {
  protocol: "mcp";
  state: "closed" | "ready";
  authenticatedApiProvided: true;
  connectionHealth: "not-probed";
  pendingRequests: number;
  limits: { pageSize: number; userIDs: number; responseBytes: number; timeoutMs: number; maxConcurrent: number };
  tools: Array<Pick<ToolDescriptor, "name" | "method" | "annotations">>;
  featureNamespacePresent: boolean;
  events: EventBufferStatus | null;
}
export type ToolErrorCode = "INVALID_INPUT" | "UNKNOWN_TOOL" | "API_ERROR" | "INVALID_RESPONSE"
  | "RESULT_TOO_LARGE" | "TIMEOUT" | "CANCELLED" | "SERVER_CLOSED" | "BUSY"
  | "NOTIFICATIONS_UNAVAILABLE" | "CONTENT_UNAVAILABLE" | "GRAPHQL_ERROR" | "SESSION_EXPIRED" | "OPERATION_UNAVAILABLE";
export type ToolEnvelope = { ok: true; data: unknown } | {
  ok: false;
  error: { code: ToolErrorCode; message: string; retryable: boolean; outcomeUnknown: boolean };
};
export type StructuredToolResult = CallToolResult & { structuredContent: ToolEnvelope };
export interface Registry {
  tools: ToolDescriptor[];
  call(name: string, input?: object, context?: { signal?: AbortSignal }): Promise<StructuredToolResult>;
  status(): RegistryStatus;
  close(): void;
}
export interface McpServerOptions extends RegistryOptions {
  api: FacebookApi;
  /** Omit when the parent owns the shared API lifetime. */
  dispose?: (api: FacebookApi) => void | Promise<void>;
}
export interface McpServerHandle {
  server: McpServer;
  registry: Registry;
  eventBuffer: EventBuffer | undefined;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}
export interface StdioOptions extends McpServerOptions {
  input?: Readable;
  output?: Writable;
  signals?: boolean;
  processObject?: EventEmitter & { exitCode?: number | string };
}
export interface StdioServerHandle extends McpServerHandle {
  transport: StdioServerTransport;
}
export interface NotificationInput { limit?: number; cursor?: string }
export type PostTypeFilter = "all" | "text" | "photo" | "video" | "reel" | "mixed" | "share";
/** Local filters apply only to posts on the returned provider page. */
export interface PostFiltersInput {
  types?: PostTypeFilter[];
  keywords?: string[];
  keywordMode?: "any" | "all";
  authorID?: string;
  groupID?: string;
  /** Inclusive Unix seconds or ISO date/date-time with explicit timezone. Unknown dates are excluded. */
  since?: number | string;
  until?: number | string;
}
export interface PostPageInput extends PostFiltersInput {
  /** Requested count, 1..50 (default 5); a provider page may contain up to 100. */
  limit?: number;
  cursor?: string;
}
export type SearchPostsInput = PostPageInput & ({ query: string; hashtag?: string } | { query?: string; hashtag: string }) & {
  /** Search pagination context returned by the preceding page, not a login session. */
  sessionID?: string;
};
export type GetFeedPostsInput = PostPageInput;
export interface GetProfilePostsInput extends PostPageInput { profileID: string }
export interface GetGroupPostsInput extends PostPageInput { groupID: string }
export interface GetPagePostsInput extends PostPageInput { pageID: string }
/** Management tools require an exact identity, never a URL or a bare numeric ID. */
export type ExactPostTarget = { storyID: string; postID?: never; actorID?: never } | { postID: string; actorID: string; storyID?: never };
export interface DeletePostInput { target: ExactPostTarget }
export interface EditPostInput { target: ExactPostTarget; text: string }
export interface DeleteCommentInput { commentID: string; postID?: string; parentFeedbackID?: string; expansionToken?: string }
export interface EditCommentInput extends DeleteCommentInput { text: string }
export interface SetPostAudienceInput { target: ExactPostTarget; audience: "PUBLIC" | "FRIENDS" | "SELF" }
export interface GetVideoStatusInput { videoID: string }
export interface VerifyPublicationInput {
  target: ExactPostTarget | { videoID: string };
  maxAttempts?: number;
  intervalMs?: number;
  /** 1..30000, default 25000; the host request timeout also applies. */
  timeoutMs?: number;
  expectedText?: string;
  expectedMediaType?: Exclude<PostTypeFilter, "all">;
  expectedAudience?: "PUBLIC" | "FRIENDS" | "SELF";
}
/** Supply nonempty text or an already staged videoID. Creates one post; verification never republishes it. */
export type PublishPostVerifiedInput = ({ text: string; videoID?: string } | { text?: string; videoID: string }) & {
  /** Defaults to PUBLIC; also checked during verification. */
  audience?: "PUBLIC" | "FRIENDS" | "SELF";
  maxAttempts?: number;
  intervalMs?: number;
  /** Verification budget, 1..30000 (default 25000); host timeout includes publication and identity lookup too. */
  timeoutMs?: number;
  expectedMediaType?: Exclude<PostTypeFilter, "all">;
};
/** Lowercase SHA-256 action key; ledger path is configured by the embedding login only. */
export interface InspectActionInput { key: string }
export interface ReconcileActionInput extends InspectActionInput {
  actorID?: string;
  storyID?: string;
  parentFeedbackID?: string;
  expansionToken?: string;
  maxScanPages?: number;
}
export interface GetPostInput {
  /** Numeric postID requires actorID; encoded story IDs carry their own identity. */
  target: string | { postID: string; actorID?: string } | { storyID: string };
  actorID?: string;
}
export interface GetPostCommentsInput { postID: string; limit?: number; cursor?: string }
export interface GetCommentRepliesInput {
  feedbackID: string;
  limit?: number;
  cursor?: string;
  expansionToken?: string;
  clientKey?: string;
}
export type PostReactionInput = "unlike" | "like" | "heart" | "love" | "care" | "haha" | "wow" | "sad" | "angry";
/** Requires actionLedgerPath on the authenticated login; no tool-level path or bypass. */
export type EngagePostInput = {
  postID: string;
  /** Post owner, not an override for the acting account. */
  actorID?: string;
  storyID?: string;
  /** 1..10, default 3. */
  maxScanPages?: number;
} & (
  { action: "comment"; text: string }
  | { action: "reply"; text: string; parentCommentID: string; parentFeedbackID?: string; expansionToken?: string }
  | ({ action: "reaction"; reaction: PostReactionInput } & ({ actorID: string } | { storyID: string }))
  | { action: "share"; url: string; text?: string; groupID?: string; baseState?: 1 | 2 | 3 }
);
/** IDs are decimal strings, preserving Facebook identifier precision. */
export type CreateStoryInput = { privacy: "current" } & (
  { photoID: string; videoID?: never; text?: never; textPresetID?: never; fontID?: never }
  | { videoID: string; photoID?: never; text?: never; textPresetID?: never; fontID?: never }
  | { text: string; textPresetID: string; fontID: string; photoID?: never; videoID?: never }
);
export interface PublishVideoInput { videoID: string; title?: string; description?: string; targetID?: string }
export interface PublishReelInput {
  videoID: string;
  caption?: string;
  placements: string[];
  draft?: boolean;
  enableRemix?: boolean;
  embeddable?: boolean;
}
export const STATUS_URI: "facebook://capabilities";
export function createEventBuffer(options?: EventBufferOptions): EventBuffer;
export function createRegistry(api: FacebookApi, options?: RegistryOptions): Registry;
export function createMcpServer(options: McpServerOptions): McpServerHandle;
export function startStdioServer(options: StdioOptions): Promise<StdioServerHandle>;
export function disposeApi(api: FacebookApi): Promise<void>;
