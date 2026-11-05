"use strict";

const { generateOfflineThreadingID } = require("../../utils");
const { request } = require("./LightSpeedRequest");

function identifier(value, name) {
  if ((typeof value !== "string" || !value.trim()) &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a non-empty string or a positive safe integer`);
  }
  return String(value);
}

function task(ctx, { label, payload, queue, type, version }, callback, transform) {
  ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
  ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
  return request(ctx, {
    app_id: "2220391788200892",
    request_id: ctx.wsReqNumber,
    type: 3,
    payload: JSON.stringify({
      data_trace_id: null,
      epoch_id: generateOfflineThreadingID(),
      version_id: version,
      tasks: [{ label: String(label), payload: JSON.stringify(payload),
        queue_name: queue, task_id: ctx.wsTaskNumber, failure_count: null }],
    }),
  }, type, callback, transform);
}

module.exports = { task, identifier };
