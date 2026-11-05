# Runnable examples

Run from the package directory after `npm ci`. Set `FACEBOOK_APP_STATE_PATH` to
an existing absolute private app-state file path. Cookie values are never command
arguments. These examples contact Facebook only when executed directly; importing
their helper functions does not log in.

```sh
node examples/cookie-login.js
node examples/discover-posts.js community gardening
node examples/command-bot.js
node examples/send-attachment.js THREAD_ID photo.jpg
```

PowerShell environment setup:

```powershell
$env:FACEBOOK_APP_STATE_PATH = 'C:\private\facebook\appstate.json'
```

POSIX environment setup:

```sh
export FACEBOOK_APP_STATE_PATH=/private/facebook/appstate.json
```

`cookie-login.js` displays capability metadata and disposes the local API.
`discover-posts.js` reads up to three search pages and displays counts/coverage.
Its exported `discover(api, query, maxPages)` returns the deduplicated pages to
application code, retains the provider cursor/search session, stops on repeated
cursors, and follows empty locally filtered pages. Filters apply only to returned
pages; this is not an exhaustive search export. Both examples disable automatic
read/delivery marking, presence updates and typing. Session cookie rotations may
still be persisted during login and cleanup.

For MCP, merge `mcp-client.json` into your client's configuration and replace the
placeholder paths. JSON Windows paths need doubled backslashes or forward slashes.
The action-ledger directory must exist; retain its file across restarts when using
`facebook_engage_post`. Add `--listen` or `--notifications` to `args` only when you
want event collection. The server offers mutation tools as well as reads.

Suggested read-only client sequence:

1. Read `facebook://capabilities` and list the currently registered tools.
2. Call `facebook_search_posts` with `{ "query": "community gardening", "limit": 5 }`.
3. Inspect `items`, `coverage`, `partial`, and `pageInfo`.
4. If needed, request another page with the exact returned `sessionID` and
   `pageInfo.endCursor`, keeping the query/filters and a caller-chosen page budget.

Copy examples into another project by changing `require("..")` to
`require("facebook-api-mcp")` and `require("../lib/mcp")` to `require("facebook-api-mcp/lib/mcp")`.

For an installed package, use its actual
`node_modules/facebook-api-mcp/bin/facebook-api-mcp.js` path.
The command bot replies only to `/ping`; the attachment example sends to the
explicit thread argument. See [API reference](../docs/API_REFERENCE.md).
