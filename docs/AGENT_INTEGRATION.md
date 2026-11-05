# Agent, command and skill integration

Use one authenticated API per account. The host owns startup, readiness,
persistence, tool execution and shutdown. The model receives selected content
and typed results, not cookies or raw client context.

```text
Messenger event -> host normalizer -> agent -> typed tool request
                                      -> host validation -> API -> result/readback
```

## Command pattern

```js
async function ping(api, event) {
  if (!["message", "message_reply"].includes(event.type)) return;
  if (event.body !== "/ping") return;
  return api.sendMessage("Pong!", event.threadID, undefined, event.messageID);
}
```

Queue by thread when ordering matters and deduplicate inbound message identities.
See `examples/command-bot.js`. Do not rely on edits as the only success UI while
their independent readback is unresolved.

## Typed tool pattern

```js
async function inspectCurrentThread(_input, context) {
  const info = await context.api.getThreadInfo(context.threadID);
  return { threadID: info.threadID, name: info.threadName,
    participantCount: info.participantIDs.length };
}
async function findPosts({ query }, context) {
  if (typeof query !== "string" || !query.trim()) throw new TypeError("query required");
  return context.api.searchPosts({ query, limit: 10 });
}
```

Bind the account/current chat in trusted context. Cross-thread/post actions use
explicit targets and the host's existing authorization. Use real cursors. Keep
`acknowledged`, `verified`, `outcomeUnknown` and partial coverage in model results.

## Durable effects

Configure `actionLedgerPath` for `engagePost`/`engagePosts`; use `reconcileAction`
after uncertainty. `scanPosts` has separate pending-page acknowledgement: ack
only after processing. Messenger sends are not protected by the social ledger.
Hold uncertain sends in your outbox; a lost response is not permission to resend.

## Embedded MCP

```js
const { createMcpServer } = require("facebook-api-mcp/lib/mcp");
const host = createMcpServer({ api });
await host.connect(yourSdkTransport);
// Close host before disposing the application-owned API.
await host.close();
```

Use the standalone CLI for stdio isolation. Embedded hosts must keep diagnostic
logs off JSON-RPC stdout. Tools are discovered dynamically from implemented
provider methods. See [MCP tool catalog](MCP.md#complete-tool-catalog).

## Reusable prompts

- [Runtime agent instructions](../prompts/facebook-agent.md)
- [Coding-agent integration task](../prompts/integrate-chatbot.md)

These are plain Markdown templates, not automatically installed executable skills.
Adapt them to host tool names and policies.

## Chika integration

Chika installs the runtime under `vendor/facebook-api-mcp` and defaults to
`FACEBOOK_CLIENT_MODULE=facebook-api-mcp`. Upgrade by extracting a tested tarball,
updating the dependency/lockfile, and running Chika's checks. Old clients are not
installed alongside it.

Chika owns cookie checkpoints and passes `cookieRefreshIntervalMs: 0` to avoid
duplicate refresh scheduling. Preserve unknown outcomes across the transport and
outbox. Read normalized reactions from `event.metadata.reaction`. Missing history
support must throw rather than return a false empty page. Edits cannot be the
only final-result UI while verification is unresolved. New Facebook skills need
explicit Chika tool definitions using its existing authorization model.

Trusted code uses the same API through `ctx.fca`/`ctx.api`; embedded MCP should
share it rather than start another login. Stop listeners before disposal.
