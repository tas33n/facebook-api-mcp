"use strict";

const { McpToolError } = require("./safety");

// Explicit descriptors choose where FCA's callback belongs. A single settlement
// also handles methods which call the callback AND return a rejecting promise.
function invoke(api, method, args, { timeoutMs = 30000, signal, callbackIndex = args.length, synchronous = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new McpToolError("CANCELLED"));
    if (signal?.aborted) return abort();
    if (signal) signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(new McpToolError("TIMEOUT")), timeoutMs);
    try {
      const parameters = args.slice();
      if (!synchronous) parameters.splice(callbackIndex, 0, finish);
      const returned = api[method].apply(api, parameters);
      if (returned && typeof returned.then === "function") returned.then(value => finish(null, value), finish);
      else if (synchronous) finish(null, returned);
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = { invoke };
