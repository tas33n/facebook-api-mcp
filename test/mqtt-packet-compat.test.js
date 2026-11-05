"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once, EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const mqttPacket = require("mqtt-packet");
const FacebookPacketNormalizer = require("../lib/mqtt/FacebookPacketNormalizer");

async function normalize(chunks, options) {
  const stream = new FacebookPacketNormalizer(options);
  const output = [];
  stream.on("data", chunk => output.push(chunk));
  const finished = once(stream, "end");
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await finished;
  return Buffer.concat(output);
}

function parse(buffer) {
  const packets = [], errors = [];
  const parser = mqttPacket.parser({ protocolVersion: 3 });
  parser.on("packet", packet => packets.push(packet));
  parser.on("error", error => errors.push(error));
  parser.parse(buffer);
  return { packets, errors };
}

test("observed Facebook 0x42 PUBACK is normalized without changing message ID or input", async () => {
  const input = Buffer.from([0x42, 2, 0x12, 0x34]);
  const metadata = [];
  const output = await normalize([input], { onPacketHeader: info => metadata.push(info) });
  assert.deepEqual(output, Buffer.from([0x40, 2, 0x12, 0x34]));
  assert.equal(input[0], 0x42);
  assert.match(parse(input).errors[0].message, /Invalid header flag bits/);
  const { packets, errors } = parse(output);
  assert.deepEqual(errors, []);
  assert.equal(packets[0].cmd, "puback");
  assert.equal(packets[0].messageId, 0x1234);
  assert.deepEqual(metadata, [{ header: 0x42, remainingLength: 2, normalized: true }]);
});

test("coalesced frames and every split boundary preserve PUBLISH flags and payload bytes", async () => {
  const publish = mqttPacket.generate({ cmd: "publish", topic: "/test", payload: Buffer.alloc(180, 0x42), qos: 1, retain: true, dup: true, messageId: 7 });
  const ack = Buffer.from([0x42, 2, 0x42, 0x42]);
  const input = Buffer.concat([Buffer.from([0x20, 2, 0, 0]), publish, ack, Buffer.from([0xd0, 0])]);
  const expected = Buffer.from(input);
  expected[4 + publish.length] = 0x40;
  for (let split = 0; split <= input.length; split++) {
    assert.deepEqual(await normalize([input.subarray(0, split), input.subarray(split)]), expected);
  }
  assert.deepEqual(await normalize([...input].map(b => Buffer.from([b]))), expected);
  const { packets, errors } = parse(expected);
  assert.deepEqual(errors, []);
  assert.equal(packets[1].retain, true);
  assert.equal(packets[1].dup, true);
  assert.deepEqual(packets[1].payload, Buffer.alloc(180, 0x42));
});

test("unobserved PUBACK flags and invalid flags on other packet types remain strict", async () => {
  for (const header of [0x41, 0x43, 0x48, 0x4f, 0x92, 0xd2]) {
    const input = Buffer.from([header, 2, 0, 1]);
    const output = await normalize([input]);
    assert.deepEqual(output, input);
    assert.equal(parse(output).errors.length, 1);
  }
  const unusualLength = Buffer.from([0x42, 3, 0, 1, 0]);
  assert.deepEqual(await normalize([unusualLength]), unusualLength);
  const canonical = Buffer.from([0x40, 2, 0, 1]);
  assert.deepEqual(await normalize([canonical]), canonical);
});

test("remaining-length supports four bytes, bounded size and truncated/malformed rejection", async () => {
  // Payload is streamed, so even a four-byte length retains only five header bytes.
  const stream = new FacebookPacketNormalizer({ maxPacketSize: 2097157 });
  stream.resume();
  stream.write(Buffer.from([0x30, 0x80, 0x80, 0x80, 1]));
  assert.equal(stream.payloadRemaining, 2097152);
  assert.equal(stream.header.length, 5);
  stream.destroy();
  await assert.rejects(normalize([Buffer.from([0x30, 0x80, 0x80, 0x80, 0x80])]), /Invalid MQTT remaining length/);
  await assert.rejects(normalize([Buffer.from([0x30, 0x80, 1])], { maxPacketSize: 128 }), /maximum packet size/);
  for (const bytes of [[0x42], [0x42, 2, 0], [0x30, 0x80]]) {
    await assert.rejects(normalize([Buffer.from(bytes)]), /Truncated MQTT packet/);
  }
  assert.deepEqual(await normalize([Buffer.from([0xd0, 0])], { onPacketHeader() { throw new Error("diagnostic failed"); } }), Buffer.from([0xd0, 0]));
});

function listenerFixture({ autoReconnect = false, firstListen = true } = {}) {
  const timers = new Map(), clients = [], events = [];
  let nextTimer = 0;
  const setTimer = (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; };
  const clearTimer = id => timers.delete(id);
  class Client extends EventEmitter {
    constructor(builder, options) {
      super(); this.options = options; this.connected = false; this.ends = [];
      this.stream = { destroy: () => { this.destroyed = true; }, socket: { terminate: () => { this.terminated = true; } } };
      clients.push(this);
    }
    subscribe() {}
    unsubscribe() {}
    publish() {}
    end(force, cb) { this.ends.push(force); this.endCallback = cb; }
  }
  const filename = require.resolve("../src/listenMqtt");
  const realRequire = createRequire(filename);
  const utils = { getGUID: () => "guid", generateClientID: () => "client", formatID: value => String(value), parseAndCheckLogin: () => value => value, getType: value => Array.isArray(value) ? "Array" : "Object" };
  const quiet = new Proxy({}, { get: () => () => {} });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, Buffer, process, console, URL, global: {}, setImmediate,
    setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setTimer, clearInterval: clearTimer,
    require: name => name === "mqtt" ? { Client } : name === "ws" ? class extends EventEmitter {} : name === "../utils" ? utils : name === "npmlog" ? quiet : realRequire(name),
  }, { filename });
  const ctx = {
    userID: "test", loggedIn: true, firstListen, lastSeqId: "1", jar: { getCookieStringSync: () => "" },
    globalOptions: { autoReconnect, disablePreflight: true, foregroundRefreshEnabled: false, emitReady: true },
  };
  let resolveFetch;
  const defaults = { post: () => new Promise(resolve => { resolveFetch = resolve; }) };
  const api = {};
  const listener = module.exports(defaults, api, ctx)((error, event) => events.push({ error, event }));
  function fire(ms) {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
  }
  return { ctx, listener, clients, timers, events, fire, resolveFetch: value => resolveFetch(value) };
}

test("autoReconnect false disables MQTT retry and /t_ms timeout reconnect", async () => {
  const f = listenerFixture();
  const client = f.clients[0];
  assert.equal(client.options.reconnectPeriod, 0);
  client.connected = true;
  client.emit("connect");
  f.fire(5000);
  assert.equal(f.clients.length, 1);
  assert.equal(f.ctx._adaptiveReconnectTimer, undefined);
  assert.equal(f.ctx._reconnectTimer, undefined);
  assert.equal(f.events[0].error.type, "stop_listen");
  client.connected = false;
  await f.listener.stopListeningAsync();
  assert.equal(f.timers.size, 0);
});

test("intentional stop bounds a hung graceful end and cancels pending callbacks/retries", async () => {
  const f = listenerFixture({ autoReconnect: true });
  const client = f.clients[0];
  client.connected = true;
  client.emit("connect");
  const pending = [...f.timers.values()].map(timer => timer.fn);
  const stopped = f.listener.stopListeningAsync();
  assert.equal(client.ends[0], false);
  f.fire(1500);
  await stopped;
  assert.equal(client.ends[1], true);
  assert.equal(client.destroyed, true);
  assert.equal(client.terminated, true);
  for (const callback of pending) callback();
  client.emit("close");
  client.emit("error", new Error("late close"));
  assert.equal(f.clients.length, 1);
  assert.equal(f.ctx.mqttClient, undefined);
  assert.equal(f.timers.size, 0);
  await f.listener.stopListeningAsync();
});

test("stop after parser error settles immediately and cancels the t_ms watchdog", async () => {
  const f = listenerFixture();
  const client = f.clients[0];
  client.emit("connect");
  client.emit("error", new Error("Invalid header flag bits"));
  await f.listener.stopListeningAsync();
  assert.equal(f.timers.size, 0);
  assert.equal(f.events[0].error.error, "Invalid header flag bits");
});

test("stop while SeqID fetch is in flight prevents a later connection", async () => {
  const f = listenerFixture({ firstListen: false });
  await f.listener.stopListeningAsync();
  f.resolveFetch([{ o0: { data: { viewer: { message_threads: { sync_sequence_id: "2" } } } } }, { successful_results: 1, error_results: 0 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.clients.length, 0);
  assert.equal(f.timers.size, 0);
});

test("real listener routes notifications, typing, presence and exactly one LS callback", async () => {
  const f = listenerFixture();
  const client = f.clients[0];
  const emit = (topic, payload) => client.emit("message", topic, Buffer.from(JSON.stringify(payload)));
  emit("/delete_messages_notification", { thread_fbid: "20002", message_ids: ["mid.one"] });
  emit("/delete_thread_notification", { thread_fbid: "20002" });
  emit("/orca_typing_notifications", { sender_fbid: "10001", thread: "20002", state: 1 });
  emit("/t_p", { list: [{ u: "10001", l: 1700000000, p: 2 }] });
  assert.deepEqual(f.events.map(value => value.event.type), ["message_deleted", "thread_deleted", "typ", "presence"]);
  assert.equal(f.events[0].event.messageIDs[0], "mid.one");
  assert.equal(f.events[2].event.isTyping, true);
  assert.equal(f.events[3].event.timestamp, 1700000000000);
  let count = 0;
  const callback = error => { assert.ifError(error); count++; };
  f.ctx.tasks = new Map([[42, { type: "edit_message", callback }]]);
  f.ctx.reqCallbacks = { 42: callback };
  emit("/ls_resp", { request_id: 42, payload: JSON.stringify({ step: [] }) });
  emit("/ls_resp", { request_id: 42, payload: JSON.stringify({ step: [] }) });
  assert.equal(count, 1);
  assert.equal(f.ctx.tasks.size, 0);
  assert.equal(f.ctx.reqCallbacks[42], undefined);
  await f.listener.stopListeningAsync();
});
