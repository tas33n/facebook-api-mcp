"use strict";

// Generated inventories supplement the hand-written contract guide.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = fs.readdirSync(path.join(root, "src")).filter(name => name.endsWith(".js")).sort();
const api = Object.fromEntries(files.map(name => [name.slice(0, -3), () => {}]));
const { createRegistry } = require("../lib/mcp");
const registry = createRegistry(api);
const lines = ["# MCP tool catalog", "", "Generated from the actual registry. Configure the stdio server using [MCP.md](MCP.md).", "Tools appear only when the underlying method is present. Inputs are strict; unknown fields reject.", "For argument types/defaults, your MCP client's `tools/list` exposes the authoritative JSON Schema.", "", "| Tool | Provider method | Input fields | Read only |", "| --- | --- | --- | --- |"];
for (const tool of registry.tools) {
  const shape = tool.schema.shape || {};
  lines.push(`| \`${tool.name}\` | \`${tool.method}\` | ${Object.keys(shape).map(key => `\`${key}${shape[key].isOptional() ? '?' : ''}\``).join(', ') || 'none'} | ${tool.annotations.readOnlyHint ? 'yes' : 'no'} |`);
}
for (const tool of registry.tools) lines.push("", `## ${tool.name}`, "", tool.description);
lines.push("", "## Events and resources", "", "With a host event buffer, `facebook_get_events({ after?, limit? })` reads bounded non-consuming events and reports overflow. `facebook://capabilities` reports local tools/status, not a live health certificate.", "", "Errors carry `code`, `retryable` and `outcomeUnknown`. Never turn an unknown mutation into an automatic retry. Cancellation stops local waiting, not necessarily the remote action.", "");
replaceGenerated("MCP.md", "tool-catalog", lines.join("\n").replace(/^# MCP tool catalog/, "## Complete tool catalog"));
registry.close();
const index = ["## Complete source API index", "", "Generated from active top-level modules. Export presence is not live certification; see the capability limits above.", "", "| Method | Source signature (callback optional unless noted) |", "| --- | --- |"];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, "src", file), "utf8");
  const match = source.match(/return\s+(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/) || source.match(/=>\s*(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/);
  index.push(`| [\`${file.slice(0, -3)}\`](../src/${file}) | \`${match ? match[1].replace(/\s+/g, ' ').trim() : 'See source / typed declarations'}\` |`);
}
index.push("", "Base lifecycle methods include `setOptions`, `getAppState`, `getCurrentUserID`, `saveSession`, `refreshSession`, listener stop methods and `__chikaDispose` (legacy host compatibility hook). Prefer `disposeApi(api)` for application cleanup.", "");
replaceGenerated("API_REFERENCE.md", "api-index", index.join("\n"));

function replaceGenerated(file, name, content) {
  const destination = path.join(root, "docs", file);
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const source = fs.readFileSync(destination, "utf8");
  const section = `${start}\n${content}\n${end}`;
  const first = source.indexOf(start), last = source.indexOf(end);
  if ((first < 0) !== (last < 0)) throw new Error(`Incomplete generated section in ${file}`);
  fs.writeFileSync(destination, first < 0 ? `${source.trimEnd()}\n\n${section}\n`
    : source.slice(0, first) + section + source.slice(last + end.length));
}
