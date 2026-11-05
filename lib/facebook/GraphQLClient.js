"use strict";

const utils = require("../../utils");
const { getRegistry, operationError } = require("./OperationRegistry");

function parseResponse(response) {
  if (!response || typeof response !== "object") throw operationError("INVALID_RESPONSE", "Missing HTTP response");
  if (response.statusCode && response.statusCode !== 200) {
    const status = response.statusCode;
    const error = operationError(status === 401 || status === 403 ? "SESSION_EXPIRED" : "HTTP_ERROR", `Facebook returned HTTP ${status}`);
    error.statusCode = status;
    throw error;
  }
  let body = response.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body !== "string") {
    if (body && typeof body === "object") return Array.isArray(body) ? body : [body];
    throw operationError("INVALID_RESPONSE", "Facebook returned no JSON body");
  }
  if (/^\s*</.test(body)) {
    throw operationError(/login_form|checkpoint|name=["']pass["']/.test(body) ? "SESSION_EXPIRED" : "INVALID_RESPONSE", "Expected JSON, received HTML");
  }
  const text = body.replace(/^\s*for\s*\(;;\);\s*/, "");
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    try { return text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line.replace(/^for\s*\(;;\);/, ""))); }
    catch (_) { throw operationError("INVALID_RESPONSE", "Facebook returned malformed JSON"); }
  }
}

function mergeData(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) mergeData(target[key], value);
    else target[key] = value;
  }
  return target;
}

function combineData(records, options = {}) {
  const data = {};
  let hasData = false;
  for (const record of records) {
    if (!record || typeof record !== "object") throw operationError("INVALID_RESPONSE", "Invalid GraphQL record");
    if (record.errors != null && !Array.isArray(record.errors)) {
      throw operationError("INVALID_RESPONSE", "Malformed GraphQL errors field");
    }
    if (record.error || record.errors?.length) {
      const errors = record.errors || [record.error];
      const error = operationError("GRAPHQL_ERROR", "Facebook rejected the GraphQL operation");
      error.graphqlCodes = errors.map(item => item?.code ?? item?.extensions?.code).filter(value => value !== undefined);
      error.partialData = Boolean(record.data || hasData);
      throw error;
    }
    if (record.path && options.allowIncremental === true && !record.incremental) {
      if (!Array.isArray(record.path) || record.path.length > 100 || !record.data || typeof record.data !== "object") throw operationError("INVALID_RESPONSE", "Invalid GraphQL patch");
      let target = data;
      for (const [index, key] of record.path.entries()) {
        if (Array.isArray(target) && Number.isSafeInteger(key) && key === target.length && index === record.path.length - 1) {
          target.push({});
        }
        if ((typeof key !== "string" && !Number.isSafeInteger(key)) || ["__proto__", "prototype", "constructor"].includes(key) || !Object.prototype.hasOwnProperty.call(target, key) || !target[key] || typeof target[key] !== "object") throw operationError("INVALID_RESPONSE", "GraphQL patch targets an absent or unsafe path");
        target = target[key];
      }
      mergeData(target, record.data);
      continue;
    }
    if (record.path || record.incremental) {
      throw operationError("INCREMENTAL_RESPONSE", "Incremental GraphQL patches require an operation-specific decoder");
    }
    if (record.data && typeof record.data === "object") {
      hasData = true;
      mergeData(data, record.data);
    }
  }
  if (!hasData) throw operationError("INVALID_RESPONSE", "GraphQL response contains no data");
  return data;
}

function createGraphQLClient(defaultFuncs, ctx) {
  const registry = getRegistry(ctx);
  return {
    registry,
    async request(name, variables, options = {}) {
      const operation = registry.resolve(name);
      if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw operationError("INVALID_ARGUMENT", "GraphQL variables must be an object");
      const form = { fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: name,
        doc_id: operation.docId, variables: JSON.stringify(variables), server_timestamps: true };
      try {
        // The shared legacy parser retries 5xx POSTs. Parsing here deliberately
        // avoids replaying a mutation whose server outcome is unknown.
        const response = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form);
        const records = parseResponse(response);
        const data = combineData(records, options);
        // Process server-issued Cookie/DTSG metadata only after a successful parse.
        for (const record of records) if (record.jsmods) {
          await utils.parseAndCheckLogin(ctx, defaultFuncs, 5)({ ...response, body: JSON.stringify(record), statusCode: 200 });
        }
        return data;
      } catch (error) {
        if (!error || typeof error !== "object") error = operationError("REQUEST_FAILED", "GraphQL transport failed");
        if (options.mutation) error.outcome = "unknown";
        throw error;
      }
    },
  };
}

module.exports = createGraphQLClient;
module.exports.createGraphQLClient = createGraphQLClient;
module.exports.parseResponse = parseResponse;
module.exports.combineData = combineData;
