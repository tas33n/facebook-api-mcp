# Facebook API MCP

Facebook and Messenger APIs for Node.js bots, plus a typed **Model Context
Protocol server** for AI agents.

**3.5.0-rc.2 · MIT · Node.js 22+ recommended (minimum 20.18.1)**

This unofficial client uses cookie-authenticated web protocols. Core messaging,
selected publishing and discovery flows have selected-account live checks;
experimental features are identified in the [API reference](docs/API_REFERENCE.md#capability-limits).

## Installation

### From npm

Install a published stable release:

```sh
npm install facebook-api-mcp
```

For published release candidates:

```sh
npm install facebook-api-mcp@next
```

Registry commands require a successful publication to the corresponding dist-tag.
If no release is available yet, install directly from GitHub.

### Directly from GitHub

```sh
npm install github:tas33n/facebook-api-mcp
```

This installs the default branch of
[tas33n/facebook-api-mcp](https://github.com/tas33n/facebook-api-mcp).
For reproducible deployments, pin a published Git tag or full commit SHA using
`github:tas33n/facebook-api-mcp#<tag-or-commit>`.

Both options use the same import: `require("facebook-api-mcp")`.
See [setup](docs/SETUP.md) for cookies, environment settings and lifecycle guidance.

## Simple bot

```js
const login = require("facebook-api-mcp");
const { disposeApi } = require("facebook-api-mcp/lib/mcp");

async function main() {
  const api = await login({ appStatePath: process.env.FACEBOOK_APP_STATE_PATH }, {
    listenEvents: true, selfListen: false, autoMarkRead: false,
    autoMarkDelivery: false, online: false
  });
  api.listenMqtt((error, event) => {
    if (error) return console.error("Listener error:", error.code || "FAILED");
    if (["message", "message_reply"].includes(event.type) && event.body === "/ping") {
      api.sendMessage("Pong!", event.threadID, undefined, event.messageID)
        .catch(error => console.error("Send failed:", error.code || "FAILED"));
    }
  });
  process.once("SIGINT", () => void disposeApi(api));
  process.once("SIGTERM", () => void disposeApi(api));
}
main().catch(error => { console.error(error.code || "LOGIN_FAILED"); process.exitCode = 1; });
```

## Use with an MCP client

Install the package locally and configure any stdio-capable MCP host:

```json
{
  "mcpServers": {
    "facebook": {
      "command": "node",
      "args": ["/absolute/path/node_modules/facebook-api-mcp/bin/facebook-api-mcp.js", "--listen", "--notifications"],
      "env": { "FACEBOOK_APP_STATE_PATH": "/private/facebook-appstate.json" }
    }
  }
}
```

Tools execute under the cookie account. The server exposes curated schemas,
sanitized results and bounded event polling. See [MCP setup](docs/MCP.md),
[tool reference](docs/MCP.md#complete-tool-catalog) and [agent integration](docs/AGENT_INTEGRATION.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [DOCS.md](DOCS.md) | Documentation entry point |
| [API reference](docs/API_REFERENCE.md) | Method index, signatures, arguments, returns and examples |
| [Setup](docs/SETUP.md) | Install, cookies, lifecycle and troubleshooting |
| [MCP](docs/MCP.md) | Client configuration and complete tool catalog |
| [Bot/agent integration](docs/AGENT_INTEGRATION.md) | Host contracts, command examples and prompts |
| [Examples](examples/README.md) | Executable Node.js examples |

## Current boundaries

Message editing is acknowledged but independent legacy-history readback remains
unresolved. Admin/removal, pinning and contact sharing have incomplete live
verification. Native E2EE support is not implemented. Cookie sessions may expire.
Mutations with unknown outcomes must not be blindly replayed. Remove-for-me is
different from unsend-for-everyone. See [capability limits](docs/API_REFERENCE.md#capability-limits).

## Contribute and credits

Offline regression tests live in `test/`; live research artifacts are outside the
source tree and npm package. See [development and release](docs/SETUP.md#development-and-release).

Derived from **Nexus-FCA (Al Amin / Nexus-016)** and the **facebook-chat-api**
lineage, with contributions from **ntkhang03** and the FCA community.
Full provenance and preserved licenses: [ATTRIBUTION.md](ATTRIBUTION.md),
[LICENSE](LICENSE).
