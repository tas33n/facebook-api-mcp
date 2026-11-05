"use strict";

function completion(callback) {
  let resolve, reject, settled = false;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Callback callers may ignore the returned promise; awaiting it still rejects.
  if (typeof callback === "function") promise.catch(() => {});
  return {
    promise,
    done(error, value) {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
      if (typeof callback === "function") callback(error || null, value);
    },
  };
}

function request(ctx, content, type, callback, transform = value => value) {
  const operation = completion(callback);
  const client = ctx.mqttClient;
  if (!client || !client.connected) {
    operation.done(Object.assign(new Error("Not connected to MQTT broker"), { code: "MQTT_NOT_CONNECTED" }));
    return operation.promise;
  }
  const id = content.request_id;
  if (!ctx.tasks) ctx.tasks = new Map();
  if (!ctx.reqCallbacks) ctx.reqCallbacks = {};
  let settled = false;
  let timer;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ctx.tasks.delete(id);
    delete ctx.reqCallbacks[id];
    if (typeof client.removeListener === "function") client.removeListener("close", onClose);
    if (!error) {
      try { value = transform(value); } catch (err) { error = err; }
    }
    operation.done(error, value);
  };
  const onClose = () => finish(Object.assign(new Error("MQTT disconnected before the response; outcome is unknown"), {
    code: "MQTT_DISCONNECTED", outcome: "unknown", requestID: id,
  }));
  const configured = Number(ctx.globalOptions?.mqttResponseTimeoutMs ?? 15000);
  const timeout = Number.isFinite(configured) && configured > 0 ? configured : 15000;
  timer = setTimeout(() => finish(Object.assign(new Error("Timed out waiting for LightSpeed response; outcome is unknown"), {
    code: "MQTT_RESPONSE_TIMEOUT", outcome: "unknown", requestID: id,
  })), timeout);
  if (typeof client.once === "function") client.once("close", onClose);
  ctx.tasks.set(id, { type, callback: finish });
  ctx.reqCallbacks[id] = finish;
  try {
    client.publish("/ls_req", JSON.stringify(content), { qos: 1, retain: false }, error => {
      if (error) finish(error);
    });
  } catch (error) { finish(error); }
  return operation.promise;
}

function responseError(message, payload) {
  const error = message.error || payload?.error || payload?.errors?.[0];
  if (error) return Object.assign(new Error(typeof error === "string" ? error : error.message || "LightSpeed request failed"), {
    code: "MQTT_REMOTE_ERROR", details: error,
  });
  // LS expresses some failures as procedure calls rather than JSON error fields.
  // Inspect the response program as data; never execute its instructions.
  const pending = [payload?.step];
  let visited = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!Array.isArray(node)) continue;
    if (++visited > 10000) return Object.assign(new Error("LightSpeed response exceeds inspection limit"), { code: "MQTT_INVALID_RESPONSE", outcome: "unknown" });
    if (node[0] === 5 && node[1] === "mailboxTaskCompletionApiOnTaskCompletion" && node[3] === false) {
      return Object.assign(new Error("Facebook reported unsuccessful task completion"), { code: "MQTT_TASK_FAILED", outcome: "unknown" });
    }
    for (const child of node) if (Array.isArray(child)) pending.push(child);
  }
  return null;
}

function dispatch(ctx, message, format = (_type, payload) => ({ payload })) {
  const id = Number(message.request_id);
  let payload, error;
  try {
    payload = typeof message.payload === "string" ? JSON.parse(message.payload) : message.payload;
    if (!payload || typeof payload !== "object") throw new Error("Missing LightSpeed response payload");
    error = responseError(message, payload);
  } catch (err) {
    error = Object.assign(new Error("Invalid LightSpeed response payload"), { code: "MQTT_INVALID_RESPONSE", cause: err });
  }
  const task = ctx.tasks?.get(id);
  const callback = task?.callback || ctx.reqCallbacks?.[id];
  ctx.tasks?.delete(id);
  if (ctx.reqCallbacks) delete ctx.reqCallbacks[id];
  if (typeof callback !== "function") return false;
  let data = payload;
  if (!error && task) {
    try { data = { type: task.type, reqID: id, ...format(task.type, payload) }; }
    catch (cause) { error = Object.assign(new Error("Invalid LightSpeed task response"), { code: "MQTT_INVALID_RESPONSE", cause, outcome: "unknown" }); }
  }
  callback(error || null, data);
  return true;
}

module.exports = { completion, request, dispatch };
