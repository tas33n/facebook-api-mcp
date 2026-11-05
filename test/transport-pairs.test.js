"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { dispatch } = require("../lib/mqtt/LightSpeedRequest");

function fixture(options = {}) {
  const published = [], posted = [];
  const client = new EventEmitter();
  client.connected = true;
  client.publish = (topic, data, _options, cb) => {
    published.push({ topic, content: JSON.parse(data) });
    cb(null);
  };
  const ctx = {
    userID: "10001", clientID: "test", jar: { setCookie: () => {} },
    globalOptions: { mqttResponseTimeoutMs: 1000, ...options },
    mqttClient: client, wsReqNumber: 50, wsTaskNumber: 90,
  };
  const response = (url, form) => ({
    body: JSON.stringify({ payload: { actions: [{ message_id: "mid.http", thread_fbid: "20002" }] } }),
    headers: {}, statusCode: 200, request: { options: { url, method: "POST", form } },
  });
  const defaults = {
    post: async (url, _jar, form) => { posted.push({ url, form }); return response(url, form); },
    postFormData: async (url, _jar, form, qs) => { posted.push({ url, form, qs }); return response(url, form); },
  };
  const api = {};
  for (const name of ["sendMessage", "sendMessageMqtt", "changeNickname", "changeNicknameMqtt", "setMessageReaction", "setMessageReactionMqtt", "changeBlockedStatus", "changeBlockedStatusMqtt", "changeThreadColor", "setTheme", "replyMessage"]) {
    api[name] = require(`../src/${name}`)(defaults, api, ctx);
  }
  const ack = (payload = { step: [] }) => dispatch(ctx, {
    request_id: String(published.at(-1).content.request_id), payload: JSON.stringify(payload),
  });
  return { ctx, api, client, defaults, published, posted, ack };
}

test("all MQTT pairs correlate by request ID and settle callback + promise once", async () => {
  for (const [method, args, label] of [
    ["sendMessageMqtt", ["hello", "20002"], "46"],
    ["changeNicknameMqtt", ["nickname", "20002", "30003"], "44"],
    ["setMessageReactionMqtt", ["👍", "mid.test", "20002"], "29"],
    ["changeBlockedStatusMqtt", ["30003", false, "messenger"], "334"],
    ["setTheme", ["196241301102133", "20002"], "43"],
  ]) {
    const { api, ctx, published, ack, client } = fixture();
    let calls = 0;
    const promise = api[method](...args, error => { assert.ifError(error); calls++; });
    assert.equal(calls, 0, "publish callback is not a server response");
    const content = published[0].content;
    const task = JSON.parse(content.payload).tasks[0];
    assert.equal(task.label, label);
    assert.notEqual(content.request_id, task.task_id);
    assert.ok(ctx.tasks.has(content.request_id));
    ack();
    await promise;
    ack();
    assert.equal(calls, 1);
    assert.equal(ctx.tasks.size, 0);
    assert.deepEqual(Object.keys(ctx.reqCallbacks), []);
    assert.equal(client.listenerCount("close"), 0);
  }
});

test("MQTT timeout reports unknown outcome, clears state, and never retries over HTTP", async () => {
  const { api, ctx, posted } = fixture({ mqttResponseTimeoutMs: 10 });
  await assert.rejects(api.replyMessage("hello", "20002", "mid.original"), { code: "MQTT_RESPONSE_TIMEOUT", outcome: "unknown" });
  assert.equal(posted.length, 0);
  assert.equal(ctx.tasks.size, 0);
  assert.equal(ctx._pendingOutbound.size, 0);
});

test("MQTT errors, disconnects, and malformed responses reject and release correlation", async () => {
  for (const mode of ["remote", "close", "malformed", "publish"]) {
    const { api, ctx, client, published } = fixture();
    if (mode === "publish") client.publish = () => { throw new Error("publish failed"); };
    const result = api.changeNicknameMqtt("nick", "20002", "30003");
    const rejected = assert.rejects(result);
    if (mode === "remote") dispatch(ctx, { request_id: published[0].content.request_id, payload: { error: "denied" } });
    if (mode === "malformed") dispatch(ctx, { request_id: published[0].content.request_id, payload: "not JSON" });
    if (mode === "close") client.emit("close");
    await rejected;
    assert.equal(ctx.tasks.size, 0);
    assert.equal(client.listenerCount("close"), 0);
  }
});

test("standard wrappers prefer connected MQTT and return promises that settle", async () => {
  for (const [name, args, label] of [
    ["changeNickname", ["nick", "20002", "30003"], "44"],
    ["changeThreadColor", ["196241301102133", "20002"], "43"],
    ["setMessageReaction", ["👍", "mid.test", "20002"], "29"],
    ["replyMessage", ["hello", "20002", "mid.original"], "46"],
  ]) {
    const { api, published, posted, ack } = fixture();
    const result = api[name](...args);
    assert.ok(result instanceof Promise);
    assert.equal(JSON.parse(published[0].content.payload).tasks[0].label, label);
    ack();
    await result;
    assert.equal(posted.length, 0);
  }
});

test("HTTP pairs work without MQTT and historical reaction callback form remains valid", async () => {
  const { api, client, posted } = fixture();
  client.connected = false;
  assert.equal((await api.sendMessage("hello", "20002")).messageID, "mid.http");
  await api.changeNickname("nick", "20002", "30003");
  await api.changeBlockedStatus("30003", false);
  await api.replyMessage("reply", "20002", "mid.original");
  let calls = 0;
  await api.setMessageReaction("👍", "mid.http", err => { assert.ifError(err); calls++; }, true);
  assert.equal(calls, 1);
  assert.ok(posted.some(p => p.url.includes("webgraphql/mutation")));
  assert.ok(posted.some(p => p.form.replied_to_message_id === "mid.original"));
  assert.ok(posted.some(p => p.url.includes("unblock_messages")));
  await assert.rejects(api.changeThreadColor("196241301102133", "20002"), { code: "MQTT_NOT_CONNECTED" });
});

test("MQTT send uses full-width offline IDs, preserves caller input, and does not invent a message ID", async () => {
  const { api, published, ack } = fixture();
  const message = { emoji: "👍" };
  const result = api.sendMessageMqtt(message, "20002");
  const payload = JSON.parse(JSON.parse(published[0].content.payload).tasks[0].payload);
  assert.match(payload.otid, /^\d{18,}$/);
  assert.ok(BigInt(payload.otid) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(message, { emoji: "👍" });
  ack();
  const data = await result;
  assert.equal(data.messageID, null);
  assert.equal(data.otid, payload.otid);
  assert.equal(data.acknowledged, true);
});

test("invalid arguments reject before publishing and block type shorthand defaults to Messenger", async () => {
  const { api, published, ack } = fixture();
  await assert.rejects(api.sendMessageMqtt("hello", undefined));
  await assert.rejects(api.sendMessageMqtt({ url: "https://example.com" }, "20002"));
  await assert.rejects(api.setMessageReactionMqtt("👍", "mid.test", undefined));
  await assert.rejects(api.changeBlockedStatusMqtt("30003", "false"));
  await assert.rejects(api.changeThreadColor("#ff0000", "20002"));
  await assert.rejects(api.sendMessage(null, "20002"));
  assert.equal(published.length, 0);
  let called = false;
  const result = api.changeBlockedStatusMqtt("30003", false, error => { assert.ifError(error); called = true; });
  assert.equal(JSON.parse(JSON.parse(published[0].content.payload).tasks[0].payload).user_block_action, 0);
  ack();
  await result;
  assert.equal(called, true);
});

test("block task actions distinguish Messenger from Facebook and use unique request UUIDs", async () => {
  const { api, published, ack } = fixture();
  const ids = new Set();
  for (const [type, status, action] of [["messenger", true, 1], ["messenger", false, 0], ["facebook", true, 3], ["facebook", false, 2]]) {
    const result = api.changeBlockedStatusMqtt("30003", status, type);
    const task = JSON.parse(JSON.parse(published.at(-1).content.payload).tasks[0].payload);
    assert.equal(task.user_block_action, action);
    ids.add(task.request_id);
    ack();
    await result;
  }
  assert.equal(ids.size, 4);
});
