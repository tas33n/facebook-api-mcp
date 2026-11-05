"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { dispatch } = require("../lib/mqtt/LightSpeedRequest");
const utils = require("../utils");

function fixture() {
  const published = [], posted = [];
  const client = new EventEmitter();
  client.connected = true;
  client.publish = (topic, data, _options, cb) => { published.push({ topic, data: JSON.parse(data) }); cb?.(null); };
  const ctx = { userID: "10001", clientID: "audit", jar: { setCookie() {} }, mqttClient: client,
    globalOptions: { mqttResponseTimeoutMs: 25, editSettings: { maxPendingEdits: 2 } } };
  let body = { payload: { status: "success", metadata: [{ image_id: "12" }], actions: [{ message_id: "mid.sent", thread_fbid: "20002" }] } };
  const post = async (url, jar, form) => {
    posted.push({ url, jar, form });
    return { statusCode: 200, body: JSON.stringify(body), headers: {}, request: { options: { url, method: "POST", form } } };
  };
  const defaults = { post, postFormData: post, get: post };
  const api = {};
  for (const name of ["editMessage", "pinMessage", "shareContact", "shareLink", "markAsRead", "sendMessage", "sendMessageMqtt", "uploadAttachment", "sendTypingIndicator"]) {
    api[name] = require(`../src/${name}`)(defaults, api, ctx);
  }
  return { ctx, api, published, posted, defaults, setBody(value) { body = value; },
    ack(payload = { step: [] }) { dispatch(ctx, { request_id: published.at(-1).data.request_id, payload }); } };
}

test("edit, pin, contact and read wait for correlated responses and settle callback plus promise once", async () => {
  for (const [name, args] of [["editMessage", ["updated", "mid.edit"]], ["pinMessage", [false, "mid.pin", "20002"]],
    ["shareContact", ["hello", "10001", "20002"]], ["markAsRead", ["20002", true]]]) {
    const f = fixture();
    let calls = 0;
    const result = f.api[name](...args, error => { assert.ifError(error); calls++; });
    assert.equal(calls, 0);
    f.ack();
    await result;
    f.ack();
    assert.equal(calls, 1);
    assert.equal(f.ctx.tasks.size, 0);
    assert.equal(f.ctx.mqttClient.listenerCount("close"), 0);
    assert.equal(f.ctx.pendingEdits?.size || 0, 0);
  }
});

test("lost edit response never resends and remote errors and disconnects release pending edits", async () => {
  for (const mode of ["timeout", "remote", "disconnect"]) {
    const f = fixture();
    const result = f.api.editMessage("updated", "mid.edit");
    const rejected = assert.rejects(result);
    if (mode === "remote") f.ack({ error: "denied" });
    if (mode === "disconnect") f.ctx.mqttClient.emit("close");
    await rejected;
    assert.equal(f.published.length, 1);
    assert.equal(f.ctx.pendingEdits.size, 0);
    assert.equal(f.ctx.tasks.size, 0);
  }
});

test("same-message concurrent edits are rejected without dropping the original request", async () => {
  const f = fixture();
  const first = f.api.editMessage("first", "mid.edit");
  await assert.rejects(f.api.editMessage("second", "mid.edit"), { code: "EDIT_PENDING" });
  assert.equal(f.ctx.pendingEdits.get("mid.edit").text, "first");
  f.ack();
  await first;
});

test("contact shorthand and link signatures match declarations without orphan callback registries", async () => {
  const f = fixture();
  const contact = f.api.shareContact("10001", "20002");
  const task = JSON.parse(f.published[0].data.payload).tasks[0];
  assert.equal(JSON.parse(task.payload).contact_id, "10001");
  f.ack();
  await contact;
  const calls = [];
  f.api.sendMessage = (msg, id, cb) => { calls.push({ msg, id }); cb(null, { messageID: "mid.link" }); return Promise.resolve({ messageID: "mid.link" }); };
  assert.equal((await f.api.shareLink("https://example.com", "20002")).messageID, "mid.link");
  await f.api.shareLink("caption", "https://example.com", "20002");
  assert.equal(calls[1].msg.body, "caption");
  await assert.rejects(f.api.shareLink("file:///secret", "20002"));
  assert.equal(calls.length, 2);
});

test("mark unread uses explicit HTTP state, and transport failure rejects rather than resolves an error", async () => {
  const f = fixture();
  await f.api.markAsRead("20002", false);
  assert.equal(f.posted[0].form["ids[20002]"], false);
  assert.equal(f.published.length, 0);
  f.defaults.post = async () => { throw new Error("offline"); };
  await assert.rejects(f.api.markAsRead("20002", false), /offline/);
  await assert.rejects(f.api.pinMessage("false", "mid.pin", "20002"));
  await assert.rejects(f.api.shareContact("10001", undefined));
});

test("HTTP 5xx does not replay sends, uploads or other POST operations", async () => {
  const f = fixture();
  await assert.rejects(utils.parseAndCheckLogin(f.ctx, f.defaults)({ statusCode: 503, body: "unavailable", request: {
    options: { method: "POST", url: "https://www.facebook.com/messaging/send/", form: {} },
  } }), { code: "HTTP_OUTCOME_UNKNOWN", outcome: "unknown" });
  assert.equal(f.posted.length, 0);
});

test("attachment validation is all-before-upload and callback callers receive settled promises", async () => {
  const f = fixture();
  await assert.rejects(f.api.uploadAttachment([]));
  await assert.rejects(f.api.uploadAttachment([Readable.from("ok"), null]));
  assert.equal(f.posted.length, 0);
  let calls = 0;
  const value = await f.api.uploadAttachment(Readable.from("ok"), error => { assert.ifError(error); calls++; });
  assert.equal(value[0].image_id, "12");
  assert.equal(calls, 1);
  const end = f.api.sendTypingIndicator("20002");
  await end.started;
  await end(error => assert.ifError(error));
  assert.deepEqual(f.published.map(p => p.data.state), [1, 0]);
});

test("legacy messaging callbacks settle returned promises on success and failures", async () => {
  const cases = [
    ["addUserToGroup", ["30003", "20002"]], ["changeThreadEmoji", ["👍", "20002"]],
    ["setTitle", ["test", "20002"]], ["unsendMessage", ["mid.owned"]],
    ["deleteThread", ["20002"]], ["forwardAttachment", ["12", "20002"]],
    ["markAsReadAll", []], ["markAsSeen", []], ["markAsDelivered", ["20002", "mid.owned"]],
    ["handleMessageRequest", ["20002", true]], ["changeArchivedStatus", ["20002", true]],
    ["createPoll", ["question", "20002", { yes: false }]],
  ];
  for (const [name, args] of cases) {
    const f = fixture();
    const method = require(`../src/${name}`)(f.defaults, f.api, f.ctx);
    let calls = 0;
    const result = method(...args, error => { assert.ifError(error); calls++; });
    await Promise.race([result, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`${name} did not settle`)), 250); t.unref(); })]);
    assert.equal(calls, 1, name);
    f.setBody({ error: 1 });
    await assert.rejects(method(...args, error => assert.ok(error)), undefined, name);
  }
});

test("restored management validates entire selection, correlates responses and stops on ambiguous failure", async () => {
  for (const [name, args, label] of [
    ["muteThread", ["20002", 60], "144"], ["changeAdminStatus", ["20002", ["30003", "40004"], true], "25"],
    ["removeUserFromGroup", ["30003", "20002"], "140"], ["deleteMessage", [["mid.one", "mid.two"], "20002"], "155"],
  ]) {
    const f = fixture();
    const method = require(`../src/${name}`)(f.defaults, f.api, f.ctx);
    const pending = method(...args);
    assert.equal(JSON.parse(f.published[0].data.payload).tasks[0].label, label);
    const rejected = assert.rejects(pending, { code: "MQTT_REMOTE_ERROR" });
    f.ack({ error: "denied" });
    await rejected;
    assert.equal(f.published.length, 1);
    assert.equal(f.ctx.tasks.size, 0);
  }
  const f = fixture();
  const method = require("../src/changeAdminStatus")(f.defaults, f.api, f.ctx);
  await assert.rejects(method("20002", ["30003", null], true));
  assert.equal(f.published.length, 0);
});

test("send prevalidates mentions and every attachment before any upload or publish", async () => {
  const f = fixture();
  for (const method of [f.api.sendMessage, f.api.sendMessageMqtt]) {
    await assert.rejects(method({ body: "hello", mentions: [{ id: "10001", tag: "missing" }], attachment: Readable.from("file") }, "20002"));
    await assert.rejects(method({ attachment: [Readable.from("file"), null] }, "20002"));
    await assert.rejects(method({ location: { latitude: 200, longitude: 0 } }, "20002"));
    await assert.rejects(method({ emojiSize: "large", attachment: Readable.from("file") }, "20002"));
  }
  assert.equal(f.posted.length, 0);
  assert.equal(f.published.length, 0);
});

test("optional group queue returns promises and rejects overflow without abandoning earlier sends", async () => {
  const ApiFactory = require("../lib/factory/ApiFactory");
  const callbacks = [];
  const api = { sendMessage: (_message, _thread, cb) => { callbacks.push(cb); } };
  const options = { groupQueueEnabled: true, groupQueueMax: 1, parallelSendMax: 1 };
  new ApiFactory().initializeGroupQueue(api, {}, options);
  try {
    const first = api.sendMessage("one", "2000000000000000");
    const second = api.sendMessage("two", "2000000000000000");
    await assert.rejects(api.sendMessage("overflow", "2000000000000000"), { code: "SEND_QUEUE_FULL", outcome: "not-sent" });
    callbacks[0](null, { messageID: "mid.one" });
    assert.equal((await first).messageID, "mid.one");
    await new Promise(resolve => setImmediate(resolve));
    callbacks[1](null, { messageID: "mid.two" });
    assert.equal((await second).messageID, "mid.two");
  } finally { clearInterval(options._groupQueueSweeper); }
});


test("single-message reader handles attachment arrays and missing text without crashing", async () => {
  const f = fixture();
  f.setBody([{ o0: { data: { message: { __typename: "UserMessage", message_id: "mid.photo", message_sender: { id: "10001" },
    message: null, blob_attachments: [{ __typename: "UnknownAttachment" }], timestamp_precise: "1234" } } } }, { successful_results: 1, error_results: 0 }]);
  const method = require("../src/getMessage")(f.defaults, f.api, f.ctx);
  let calls = 0;
  const result = await method("20002", "mid.photo", error => { assert.ifError(error); calls++; });
  assert.equal(result.body, "");
  assert.equal(result.attachments.length, 1);
  assert.equal(calls, 1);
  f.setBody([{ o0: { data: { message: null } } }, { successful_results: 1, error_results: 0 }]);
  await assert.rejects(method("20002", "mid.absent"), { code: "MESSAGE_NOT_FOUND" });
});

test("thread pagination retains the first genuinely older item and handles an inclusive boundary", async () => {
  const f = fixture();
  const thread = (id, time) => ({ thread_key: { thread_fbid: id }, name: "test", updated_time_precise: String(time),
    thread_type: "GROUP", all_participants: { edges: [] }, thread_admins: [] });
  const body = nodes => [{ o0: { data: { viewer: { message_threads: { nodes } } } } }, { successful_results: 1, error_results: 0 }];
  const method = require("../src/getThreadList")(f.defaults, f.api, f.ctx);
  f.setBody(body([thread("20002", 900), thread("30003", 800)]));
  assert.deepEqual((await method(2, 1000, ["INBOX"])).map(t => t.threadID), ["20002", "30003"]);
  f.setBody(body([thread("10001", 1000), thread("20002", 900), thread("30003", 800)]));
  assert.deepEqual((await method(2, 1000, ["INBOX"])).map(t => t.threadID), ["20002", "30003"]);
});

test("thread-info maps out-of-order batch responses by query identity and rejects partial errors", async () => {
  const f = fixture();
  const node = id => ({ thread_key: { thread_fbid: id }, name: "test", thread_type: "GROUP", all_participants: { edges: [] } });
  f.setBody([{ o1: { data: { message_thread: node("30003") } } }, { o0: { data: { message_thread: node("20002") } } }, { successful_results: 2, error_results: 0 }]);
  const method = require("../src/getThreadInfo")(f.defaults, f.api, f.ctx);
  const result = await method(["20002", "30003"], error => assert.ifError(error));
  assert.equal(result["20002"].threadID, "20002");
  assert.equal(result["30003"].threadID, "30003");
  f.setBody([{ o0: { errors: [{ message: "denied" }] } }, { successful_results: 0, error_results: 1 }]);
  await assert.rejects(method("20002"), { code: "THREAD_QUERY_FAILED" });
});

test("observed LS completion-false response rejects instead of reporting mutation success", async () => {
  const f = fixture();
  const result = f.api.editMessage("updated", "mid.edit");
  const rejected = assert.rejects(result, { code: "MQTT_TASK_FAILED", outcome: "unknown" });
  f.ack({ step: [1, [1, [23, [2, 0], [1, [5, "mailboxTaskCompletionApiOnTaskCompletion", [19, "1"], false]]]]] });
  await rejected;
  assert.equal(f.ctx.pendingEdits.size, 0);
  assert.equal(f.ctx.tasks.size, 0);
});

test("thread-info rejects empty batches and user search settles callback and promise together", async () => {
  const f = fixture();
  f.setBody([]);
  await assert.rejects(require("../src/getThreadInfo")(f.defaults, f.api, f.ctx)("20002"), /Missing thread/);
  f.setBody({ payload: { entries: [{ uid: "30003", text: "test" }] } });
  const search = require("../src/getUserID")(f.defaults, f.api, f.ctx);
  let calls = 0;
  assert.equal((await search("test", error => { assert.ifError(error); calls++; }))[0].userID, "30003");
  assert.equal(calls, 1);
  await assert.rejects(search(null), TypeError);
});
