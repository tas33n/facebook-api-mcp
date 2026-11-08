# Changelog

## Unreleased

- Fix a listener that stays "ready" but stops receiving messages after a
  reconnect: the MQTT device id is now kept for the whole process even when
  `FACEBOOK_DEVICE_FILE` cannot be written (a write failure is logged instead of
  silently generating a new device id on every reconnect), and `/t_ms` sync
  errors (`errorCode`) recreate the sync queue via a fresh sequence id instead
  of emitting `ready`. Repeated sync failures report `stop_listen` to the host.
- `npm run typecheck` passes `--ignoreConfig`, so a checkout nested inside
  another TypeScript project (for example as a host-application submodule)
  no longer fails with TS5112 because of the parent `tsconfig.json`.

## 3.5.0-rc.2 — unreleased

- Facebook API MCP identity, with preserved Nexus-FCA
  and foundational facebook-chat-api MIT notices and contribution attribution.
- Remove obsolete quarantined implementations and incomplete external UID lookup;
  move private audit/live scripts outside source. Keep maintained offline tests.
- Repair messaging completion, edit/pin correlation, sharing, attachment validation,
  pagination and optional send queues; stop ambiguous write replays.
- Restore MQTT mute/remove-for-me/admin/participant operations with explicit
  verification limits. Add seven curated messaging MCP tools.
- Add method-oriented reference, generated API/tool indexes, setup/migration,
  command/agent prompts and embedded/standalone MCP examples.
- Replace legacy runtime environment names with FACEBOOK_* settings.

## 3.5.0-rc.1 — unpublished predecessor

- Add curated stdio MCP, publishing/discovery/notifications, durable engagement
  reconciliation and acknowledged scan checkpoints, publication verification,
  cookie persistence, MQTT 5 compatibility and release contract tests.

Inherited implementations retain original credit; see ATTRIBUTION.md.
