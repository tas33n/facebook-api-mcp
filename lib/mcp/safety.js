"use strict";

const SECRET_KEY = /^(?:app_?state|cookies?|cookiejar|jar|headers?|authorization|password|passwd|secret|access_?token|refresh_?token|token|fb_dtsg|jazoest|lsd|session|sessionid|xs|datr|sb|fr|spin|syncToken|credentials|ctx|context|defaultFuncs)$/i;
const SECRET_FRAGMENT = /cookie|token|password|secret|credential|app_?state/i;
const ASSIGNMENT = /\b(authorization|cookie|set-cookie|password|access_token|refresh_token|fb_dtsg|jazoest|lsd|xs|datr|sb|fr)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi;

function createSanitizer(secretValues = []) {
  const secrets = [...new Set(secretValues.filter(value => typeof value === "string" && value.length >= 6))]
    .sort((a, b) => b.length - a.length);
  function text(value) {
    let result = String(value);
    for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
    return result.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
      .replace(ASSIGNMENT, "$1=[REDACTED]");
  }
  function sanitize(value) {
    const seen = new WeakSet();
    let nodes = 0;
    function visit(item, depth) {
      if (++nodes > 20000 || depth > 16) throw new McpToolError("RESULT_TOO_LARGE");
      if (item === null || item === undefined) return null;
      if (typeof item === "string") {
        if (item.length > 262144) throw new McpToolError("RESULT_TOO_LARGE");
        return text(item);
      }
      if (typeof item === "number") return Number.isFinite(item) ? item : null;
      if (typeof item === "boolean") return item;
      if (typeof item === "bigint") return String(item);
      if (typeof item !== "object") return null;
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      try {
        if (Buffer.isBuffer(item) || item instanceof Error) return "[REDACTED]";
        if (item instanceof Date) return item.toISOString();
        // Cookie records carry secrets under otherwise ordinary key/value names.
        const cookieKey = item.key ?? item.name;
        if (typeof cookieKey === "string" && "value" in item && ("domain" in item || SECRET_KEY.test(cookieKey))) {
          return { key: text(cookieKey), value: "[REDACTED]" };
        }
        if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
        const result = Object.create(null);
        for (const [key, child] of Object.entries(item)) {
          if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
          result[text(key)] = SECRET_KEY.test(key) || SECRET_FRAGMENT.test(key) ? "[REDACTED]" : visit(child, depth + 1);
        }
        return result;
      } finally {
        seen.delete(item);
      }
    }
    return visit(value, 0);
  }
  return { text, sanitize };
}

const MESSAGES = Object.freeze({
  INVALID_INPUT: "The tool arguments do not match the declared schema.",
  UNKNOWN_TOOL: "This tool is not available in this session.",
  API_ERROR: "The Facebook API request failed.",
  NOTIFICATIONS_UNAVAILABLE: "Notifications are unavailable for this session or response format.",
  CONTENT_UNAVAILABLE: "The requested Facebook content is unavailable for this session or response format.",
  GRAPHQL_ERROR: "Facebook reported a GraphQL operation error.",
  SESSION_EXPIRED: "The Facebook session requires login or checkpoint verification.",
  OPERATION_UNAVAILABLE: "This Facebook web operation is unavailable in the provider's operation registry.",
  INVALID_RESPONSE: "The Facebook API returned an unexpected response.",
  RESULT_TOO_LARGE: "The response exceeds the MCP size limit. Request a smaller page.",
  TIMEOUT: "The operation exceeded its time limit; its remote outcome may be unknown.",
  CANCELLED: "The operation was cancelled; its remote outcome may be unknown.",
  SERVER_CLOSED: "The MCP server is shutting down.",
  BUSY: "The MCP server has reached its concurrent request limit."
});
const PROVIDER_CODES = new Set([
  "NOTIFICATIONS_UNAVAILABLE", "CONTENT_UNAVAILABLE", "GRAPHQL_ERROR", "SESSION_EXPIRED", "OPERATION_UNAVAILABLE", "INVALID_RESPONSE"
]);

class McpToolError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.API_ERROR);
    this.code = Object.hasOwn(MESSAGES, code) ? code : "API_ERROR";
  }
}

function errorResult(error, mutation = false) {
  // Never forward provider messages/stacks/request bodies: they may contain credentials.
  const code = error instanceof McpToolError ? error.code
    : error && PROVIDER_CODES.has(error.code) ? error.code : "API_ERROR";
  const result = {
    ok: false,
    error: {
      code,
      message: MESSAGES[code],
      retryable: code === "BUSY",
      outcomeUnknown: mutation && (["TIMEOUT", "CANCELLED", "API_ERROR", "RESULT_TOO_LARGE", "INVALID_RESPONSE", "GRAPHQL_ERROR"].includes(code) || error?.outcome === "unknown")
    }
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

module.exports = { createSanitizer, McpToolError, errorResult };
