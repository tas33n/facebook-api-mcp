# Attribution

**Facebook API MCP** is maintained by [Tas33n](https://github.com/tas33n).
Upstream authorship is preserved below.

## Code lineage

- **Nexus-FCA**, by **Al Amin / Nexus-016**: inherited Facebook/Messenger client,
  authentication, utilities, transport and API modules. Original copyright and
  MIT terms are retained in [LICENSE](LICENSE).
- **facebook-chat-api**, by **Avery, Benjamin, David, Maude** and contributors:
  foundational FCA request, message and callback conventions and inherited code.
  Its copyright and MIT terms are retained in [LICENSE](LICENSE).
- **ntkhang03 / fb-chat-api-temp** and the FCA community: inherited module author
  notices are preserved. Its method-oriented documentation is credited as the
  organizational reference for this project's newly written API guide.

## Project additions

This project adds the MCP server and typed tool schemas,
Facebook publishing/discovery/engagement adapters, action reconciliation and scan
checkpoints, cookie persistence improvements, messaging completion and transport
repairs, validation, packaging, examples and integration guides. Development has
included AI-assisted implementation and review. This is maintenance and extension
of the credited codebase, not a claim to have authored all inherited code.

## Protocol references and dependencies

Selected cookie-web LightSpeed payloads were corroborated against the public
`mautrix/meta` protocol implementation; no source modules from that project were
incorporated. Android bytecode and observed web modules informed protocol research.
Native IDs are not treated as interchangeable web operation IDs.

The MCP integration uses the official `@modelcontextprotocol/sdk`. Dependencies
retain their own licenses. No endorsement by Meta or the upstream authors is implied.
