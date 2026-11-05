# Setup

## Install

Use Node.js 22 or 24 LTS and npm (library minimum: 20.18.1). From the source
checkout run `npm ci`, `npm test`, `npm run typecheck`, then `npm pack`.
Install the resulting artifact in your application:

```powershell
npm install 'D:\packages\facebook-api-mcp-3.5.0-rc.2.tgz'
$env:FACEBOOK_APP_STATE_PATH = 'D:\private\facebook-appstate.json'
node bot.cjs
```

Linux/macOS:

```sh
npm install /packages/facebook-api-mcp-3.5.0-rc.2.tgz
export FACEBOOK_APP_STATE_PATH=/private/facebook-appstate.json
node bot.cjs
```

Alternatively unpack the tarball into `vendor/facebook-api-mcp` and use
`"facebook-api-mcp": "file:vendor/facebook-api-mcp"`. Commit that runtime snapshot,
licenses and application lockfile together. Tests stay in the source checkout;
the npm allowlist excludes tests, private state and research artifacts.

## Account state

Supply an existing authenticated Facebook cookie array exported by a tool you
trust. Records contain `key`, `value`, `domain`, `path` and available security/
expiry attributes. Keep this credential file outside source/vendor directories.

```js
const login = require("facebook-api-mcp");
const api = await login({ appStatePath: process.env.FACEBOOK_APP_STATE_PATH }, {
  listenEvents: true, autoMarkRead: false, autoMarkDelivery: false,
  online: false, cookieRefreshIntervalMs: 1800000
});
```

`appStatePath` loads and atomically saves server-issued rotations. `sessionSavePath`
optionally adds another destination. `getAppState()` returns a cookie snapshot;
`saveSession()` flushes configured files. Do not run independent sessions writing
the same checkpoint. A host owning persistence can pass `{ appState: cookies }`
and `cookieRefreshIntervalMs: 0`, then checkpoint snapshots itself.
Credential login remains an advanced, deployment-sensitive native adapter.

## Listener and shutdown

`listenMqtt(callback)` returns a handle, not a Promise or stop function. With
`emitReady: true`, wait for `{ type: "ready" }` before MQTT-only operations.
No general native E2EE implementation is included.

```js
const listener = api.listenMqtt((error, event) => {
  if (error) return console.error(error.code || "LISTENER_FAILED");
  // Route event to your bot's handlers.
});
// On shutdown:
await listener.stopListeningAsync();
await require("facebook-api-mcp/lib/mcp").disposeApi(api);
```

`disposeApi` stops listeners, saves state and disposes maintenance. `logout()` is
a remote account logout, not ordinary process shutdown.

## Configuration

Prefer login options such as `requestTimeoutMs`, `mqttResponseTimeoutMs`,
`autoReconnect`, `emitReady`, `listenEvents`, `selfListen`, `autoMarkRead`,
`autoMarkDelivery`, `cookieRefreshIntervalMs` and `actionLedgerPath`.
See `index.d.ts` and specialized guides for complete option shapes.

Environment overrides: `FACEBOOK_DEVICE_FILE`, `FACEBOOK_DEVICE_ID`,
`FACEBOOK_REGION`, `FACEBOOK_PROXY`, `FACEBOOK_USER_AGENT`,
`FACEBOOK_VERBOSE_MQTT`, `FACEBOOK_MQTT_BACKOFF_BASE`,
`FACEBOOK_MQTT_BACKOFF_MAX`, `FACEBOOK_MQTT_BACKOFF_FACTOR`,
`FACEBOOK_DISABLE_PREFLIGHT`. Device storage defaults to
`config/facebook-device.json` beneath the host working directory. Preserve an
existing device identity during migration.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `SESSION_EXPIRED` | Sign in normally and refresh the designated cookie file |
| `MQTT_NOT_CONNECTED` | Start listener and wait for ready; inspect proxy/network |
| Timeout / unknown outcome | Reconcile state; do not blindly resend |
| Edit ACK but old text | Known readback limitation; use a separate final status message |
| Missing retired method | Read migration guide; do not assume a replacement is equivalent |
| MCP invalid JSON | Use the CLI; keep application logs off protocol stdout |
| Stale vendor code | Update snapshot/version and lockfile, reinstall, restart |

## Migration

Import `facebook-api-mcp` instead of older FCA package names. Remove old vendor
dependencies and update the application lockfile. Environment overrides use
`FACEBOOK_*` rather than `NEXUS_*`; the old `NEXUS_FCA_*` pacing names become
`FACEBOOK_SAFE_MODE`, `FACEBOOK_ULTRA_SAFE_MODE`, `FACEBOOK_ALLOW_LIST` and
`FACEBOOK_BLOCK_LIST`. Preserve an existing private device identity.

- `deleteMessage(messageIDs, threadID, callback?)` now requires thread context.
- Edits wait for LS response and report `verified: false`; no automatic resend.
- Themes require numeric IDs and MQTT. Listener returns a stop handle; typing
  returns a stop function with `.started` Promise.
- External cookie POST/environment mirroring was removed.
- Removed obsolete names: `cancelFriendRequest`, `deleteComment`,
  `getThreadPictures`, `handleFriendRequest`, `searchForThread`, `sendComment`,
  `unfriend`, `listenNotification`, `listenRealtime`, `listenSpeed`, and incomplete
  `getUID`/`getAccess`. Use documented comment/notification/listener methods where
  semantics match. Thread-search/shared-photo enumeration has no certified equivalent.

## Development and release

Preserve [upstream notices](../ATTRIBUTION.md). Keep callback/Promise contracts,
validate before effects, and distinguish protocol evidence from inference.
Add focused offline regressions for changed behavior. Private live captures stay
outside the source tree.

```sh
npm ci
npm run docs:generate
npm test
npm run typecheck
npm audit --audit-level=low
npm pack
```

The generator updates sections inside API_REFERENCE.md and MCP.md. Package tests
check the runtime manifest, API assembly and MCP cleanup. Install the tarball in a
clean consumer and run its checks. CI targets Linux Node 20/22/24 and Windows 22;
remote CI and publishing need the actual repository/publisher configuration.
Local packing does not publish or reserve a name. Version each vendor snapshot
and retain LICENSE and ATTRIBUTION.md.

### GitHub npm publishing

`.github/workflows/publish.yml` validates the package on pushes to `main`, `v*`
tags, or manual dispatch. It publishes only when that version is absent on npm.
Increment `package.json` and its lockfile together before a release. Tags must
match `v<package-version>`. Prereleases such as `3.5.0-rc.2` use npm's `next`
dist-tag; stable releases use `latest`.

Configure either npm trusted publishing for your actual GitHub owner/repository
and workflow filename `publish.yml` (allow direct `npm publish`), or a GitHub
Actions secret `NPM_TOKEN` with package publishing permission. An initial package
may require token/manual publication before configuring its trusted publisher.
The workflow uses Node 24/npm 11, sets the actual repository URL from
`GITHUB_REPOSITORY`, and publishes with provenance from a public GitHub repository.
It never retries by dropping provenance. A publish failure needs investigation.
After publication it creates a GitHub release at the tested commit, marking
prereleases appropriately. Repository and npm authorization must be configured
by the owner; local checks cannot verify those remote permissions.
