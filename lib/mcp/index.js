"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");
const { createRegistry } = require("./registry");
const { createEventBuffer } = require("./events");

const STATUS_URI = "facebook://capabilities";

function createMcpServer({ api, dispose, ...options } = {}) {
  const registry = createRegistry(api, options);
  const server = new McpServer({ name: "facebook-api", version: "1.0.0" }, {
    capabilities: { tools: { listChanged: true } },
    instructions: "Facebook tools act on the configured cookie session. Read tools return bounded data. Mutations act immediately. Do not automatically retry a mutation whose outcome is unknown."
  });
  for (const tool of registry.tools) {
    server.registerTool(tool.name, {
      title: tool.name.replace(/^facebook_/, "").replace(/_/g, " "),
      description: tool.description,
      inputSchema: tool.discoverySchema || tool.schema,
      outputSchema: z.object({
        ok: z.boolean(), data: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), outcomeUnknown: z.boolean() }).optional()
      }),
      annotations: tool.annotations
    }, (input, context) => registry.call(tool.name, input, context));
  }
  // Keep SDK transport/protocol validation and schema discovery, but validate
  // tool arguments in the registry so all argument failures use the same safe,
  // structured envelope (SDK Zod error strings can include rejected keys).
  server.server.setRequestHandler(CallToolRequestSchema, (request, context) =>
    registry.call(request.params.name, request.params.arguments, context));
  server.registerResource("facebook-capabilities", STATUS_URI, {
    title: "Facebook API capabilities and MCP status",
    description: "Available curated tools, read/mutation semantics, bounds and local server status. Does not make a network health probe or reveal session secrets.",
    mimeType: "application/json"
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(registry.status()) }] }));

  let closePromise;
  function close() {
    if (!closePromise) {
      registry.close();
      closePromise = Promise.resolve().then(async () => {
        try { await server.close(); }
        finally { if (dispose) await dispose(api); }
      });
    }
    return closePromise;
  }
  server.server.onclose = () => { void close().catch(() => {}); };
  return { server, registry, eventBuffer: options.eventBuffer, close, connect: transport => server.connect(transport) };
}

async function disposeApi(api) {
  // Do not call logout: shutdown must not revoke the user's cookie session.
  try {
    if (typeof api.stopListeningAsync === "function") await api.stopListeningAsync();
    else if (typeof api.stopListenMqtt === "function") await api.stopListenMqtt();
  } finally {
    try { if (typeof api.saveSession === "function") await api.saveSession(); }
    finally { if (typeof api.__chikaDispose === "function") await api.__chikaDispose(); }
  }
}

async function startStdioServer({ input = process.stdin, output = process.stdout, signals = true, processObject = process, ...options } = {}) {
  const instance = createMcpServer(options);
  const transport = new StdioServerTransport(input, output, { maxBufferSize: 1048576 });
  let stopping;
  const cleanup = () => {
    input.removeListener("end", onEnd);
    input.removeListener("error", onError);
    output.removeListener("error", onError);
    if (signals) {
      processObject.removeListener("SIGINT", onSignal);
      processObject.removeListener("SIGTERM", onSignal);
    }
  };
  function stop() {
    if (!stopping) {
      cleanup();
      stopping = instance.close();
    }
    return stopping;
  }
  function onEnd() { void stop().catch(() => { processObject.exitCode = 1; }); }
  function onError() { processObject.exitCode = 1; onEnd(); }
  function onSignal() { onEnd(); }
  input.once("end", onEnd);
  input.once("error", onError);
  output.once("error", onError);
  if (signals) {
    processObject.once("SIGINT", onSignal);
    processObject.once("SIGTERM", onSignal);
  }
  try {
    await instance.connect(transport);
    const onTransportClose = transport.onclose;
    transport.onclose = () => {
      if (onTransportClose) onTransportClose();
      onEnd();
    };
  }
  catch (error) { await stop(); throw error; }
  return { ...instance, transport, close: stop };
}

module.exports = { createMcpServer, startStdioServer, createRegistry, createEventBuffer, disposeApi, STATUS_URI };
