"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "../src");
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));

function createMockContext() {
  const published = [];
  const posted = [];
  const jar = {
    getCookies: () => [
      { key: "c_user", value: "100012345678", cookieString: () => "c_user=100012345678" },
      { key: "xs", value: "test_xs_token", cookieString: () => "xs=test_xs_token" },
    ],
    setCookie: () => {},
  };

  const ctx = {
    userID: "100012345678",
    i_userID: null,
    clientID: "mock_client_id_123",
    jar,
    globalOptions: {
      online: true,
      selfListen: false,
      listenEvents: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    loggedIn: true,
    wsReqNumber: 0,
    wsTaskNumber: 0,
    tasks: new Map(),
    reqCallbacks: {},
    pendingEdits: new Map(),
    mqttClient: {
      connected: true,
      publish: (topic, data, options, cb) => {
        if (typeof options === "function") cb = options;
        published.push({ topic, data });
        if (typeof cb === "function") cb(null);
      },
      subscribe: () => {},
      unsubscribe: () => {},
      end: (force, cb) => {
        if (typeof cb === "function") cb();
      },
      on: () => {},
    },
  };

  const defaultFuncs = {
    get: async (url, _jar, _qs, _opts) => {
      posted.push({ method: "GET", url });
      return {
        body: JSON.stringify({ payload: { entries: [] } }),
        headers: {},
        statusCode: 200,
        request: { options: { url, method: "GET" } },
      };
    },
    post: async (url, _jar, form) => {
      posted.push({ method: "POST", url, form });
      return {
        body: JSON.stringify([{ o0: { data: { viewer: { message_threads: { sync_sequence_id: "12345" } } } } }]),
        headers: {},
        payload: { actions: [{ thread_fbid: "100012345678", message_id: "mid.123" }] },
        statusCode: 200,
        request: { options: { url, method: "POST", form } },
      };
    },
    postFormData: async (url, _jar, form) => {
      posted.push({ method: "POST_FORM", url, form });
      return {
        payload: { metadata: [{ photoID: "pid_123", fbid: "fbid_123" }] },
        headers: {},
        statusCode: 200,
        request: { options: { url, method: "POST", form } },
      };
    },
  };

  const api = {
    getCurrentUserID: () => ctx.userID,
    getUserInfo: (id, cb) => {
      const res = { [id]: { name: "Test User", id } };
      if (typeof cb === "function") cb(null, res);
      return Promise.resolve(res);
    },
    getAppState: () => [],
    setOptions: () => {},
  };

  return { ctx, defaultFuncs, api, published, posted };
}

test("All src/*.js modules should export a valid factory function returning a callable method", () => {
  assert.ok(files.length >= 60, `Expected at least 60 active src modules, found ${files.length}`);

  for (const file of files) {
    const filePath = path.join(srcDir, file);
    const modFactory = require(filePath);

    assert.equal(
      typeof modFactory,
      "function",
      `Module ${file} must export a factory function`
    );

    const { ctx, defaultFuncs, api } = createMockContext();
    const fn = modFactory(defaultFuncs, api, ctx);

    assert.ok(
      typeof fn === "function" || typeof fn === "object",
      `Module ${file} factory must return a function or handler object`
    );
  }
});

test("ApiFactory keeps successful APIs available and excludes quarantined modules", async () => {
  const ApiFactory = require("../lib/factory/ApiFactory");
  const { ctx, defaultFuncs, api, posted } = createMockContext();
  new ApiFactory().attachSrcMethods(api, defaultFuncs, ctx);

  for (const name of [
    "markAsDelivered", "markAsReadAll", "markAsSeen", "handleMessageRequest",
    "changeArchivedStatus", "changeBlockedStatus",
  ]) {
    assert.equal(typeof api[name], "function", `${name} must remain available`);
  }
  assert.equal(api.listen, api.listenMqtt);

  assert.equal(fs.existsSync(path.join(srcDir, "deprecated")), false);
  for (const name of ["muteThread", "changeAdminStatus", "removeUserFromGroup", "deleteMessage"]) assert.equal(typeof api[name], "function");

  // The listener uses this callback path when autoMarkDelivery is enabled.
  await new Promise((resolve, reject) => {
    api.markAsDelivered("1000999999", "mid.receipt.123", (err) => err ? reject(err) : resolve());
  });
  const receipt = posted.find((p) => p.url.endsWith("/delivery_receipts.php"));
  assert.ok(receipt);
  assert.equal(receipt.form["message_ids[0]"], "mid.receipt.123");
  assert.equal(receipt.form["thread_ids[1000999999][0]"], "mid.receipt.123");
});

test("sendMessageMqtt constructs valid LightSpeed task 46 and registers in ctx.tasks", async () => {
  const { ctx, defaultFuncs, api, published } = createMockContext();
  const sendMessageMqtt = require("../src/sendMessageMqtt")(defaultFuncs, api, ctx);

  const resPromise = sendMessageMqtt("Hello world", "1000999999");
  assert.ok(published.length > 0);
  assert.equal(published[0].topic, "/ls_req");

  const parsed = JSON.parse(published[0].data);
  assert.equal(parsed.app_id, "2220391788200892");
  assert.equal(parsed.type, 3);
  assert.ok(parsed.request_id > 0);

  const taskPayload = typeof parsed.payload === "string" ? JSON.parse(parsed.payload) : parsed.payload;
  assert.ok(taskPayload.tasks.length >= 1);
  assert.equal(taskPayload.tasks[0].label, "46");
  assert.ok(ctx.tasks.has(parsed.request_id));
  ctx.tasks.get(parsed.request_id).callback(null, { messageID: "mid.server.123" });
  await resPromise;
});

test("changeNicknameMqtt constructs valid LightSpeed task 44", async () => {
  const { ctx, defaultFuncs, api, published } = createMockContext();
  const changeNicknameMqtt = require("../src/changeNicknameMqtt")(defaultFuncs, api, ctx);

  const result = changeNicknameMqtt("CoolNick", "1000999999", "1000888888");
  assert.ok(published.length > 0);
  assert.equal(published[0].topic, "/ls_req");

  const parsed = JSON.parse(published[0].data);
  const taskPayload = typeof parsed.payload === "string" ? JSON.parse(parsed.payload) : parsed.payload;
  assert.equal(taskPayload.tasks[0].label, "44");
  assert.equal(taskPayload.tasks[0].queue_name, "thread_participant_nickname");
  ctx.tasks.get(parsed.request_id).callback(null, {});
  await result;
});

test("setTheme constructs valid LightSpeed task 43", async () => {
  const { ctx, defaultFuncs, api, published } = createMockContext();
  const setTheme = require("../src/setTheme")(defaultFuncs, api, ctx);

  const result = setTheme("3650637715209675", "1000999999");
  assert.ok(published.length > 0);
  assert.equal(published[0].topic, "/ls_req");

  const parsed = JSON.parse(published[0].data);
  const taskPayload = typeof parsed.payload === "string" ? JSON.parse(parsed.payload) : parsed.payload;
  assert.equal(taskPayload.tasks[0].label, "43");
  assert.equal(taskPayload.tasks[0].queue_name, "thread_theme");
  ctx.tasks.get(parsed.request_id).callback(null, {});
  await result;
});

test("sendTypingIndicator publishes directly to /thread_typing when MQTT is connected", async () => {
  const { ctx, defaultFuncs, api, published } = createMockContext();
  const sendTypingIndicator = require("../src/sendTypingIndicator")(defaultFuncs, api, ctx);

  sendTypingIndicator("1000999999");
  assert.ok(published.some((p) => p.topic === "/thread_typing"));
});

test("sendFriendRequest calls GraphQL friending endpoint", async () => {
  const { ctx, defaultFuncs, api, posted } = createMockContext();
  const sendFriendRequest = require("../src/sendFriendRequest")(defaultFuncs, api, ctx);

  await sendFriendRequest("1000777777");
  assert.ok(posted.some((p) => p.url.includes("/api/graphql/")));
});


test("replyMessage routes to sendMessage or sendMessageMqtt with replyToMessageID", async () => {
  const { ctx, defaultFuncs, api } = createMockContext();
  let calledReply = null;
  api.sendMessageMqtt = (msg, tid, cb, replyTo) => {
    calledReply = { msg, tid, replyTo };
    cb(null, { messageID: "mid.reply.123" });
  };

  const replyMessage = require("../src/replyMessage")(defaultFuncs, api, ctx);
  await replyMessage("This is a reply", "1000999999", "mid.original.111");

  assert.ok(calledReply);
  assert.equal(calledReply.replyTo, "mid.original.111");
  assert.equal(calledReply.msg, "This is a reply");
});

test("setCommentReaction formats web reaction request and returns operation data", async () => {
  const { ctx, defaultFuncs, api, posted } = createMockContext();
  const data = { feedback_react: { feedback: { id: "feedback-comment-12345", viewer_feedback_reaction_info: { id: "16" } } } };
  defaultFuncs.post = async (url, jar, form) => {
    assert.equal(jar, ctx.jar);
    posted.push({ url, form });
    return { statusCode: 200, body: JSON.stringify([{ data }]) };
  };
  const setCommentReaction = require("../src/setCommentReaction")(defaultFuncs, api, ctx);

  assert.deepEqual(await setCommentReaction("comment_12345", "love"), { data });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://www.facebook.com/api/graphql/");
  assert.equal(posted[0].form.fb_api_req_friendly_name, "CometUFIFeedbackReactMutation");
  assert.equal(posted[0].form.doc_id, "27646120298312844");
  const variables = JSON.parse(posted[0].form.variables);
  assert.equal(variables.input.feedback_reaction, 16);
  assert.equal(variables.input.actor_id, ctx.userID);
  assert.equal(Buffer.from(variables.input.feedback_id, "base64").toString(), "feedback:comment_12345");
});


test("setStoryReaction pairs web schema with historical web ID (not live-verified)", async () => {
  const { ctx, defaultFuncs, api, posted } = createMockContext();
  const data = { story_reply: { id: "story-reply-12345" } };
  defaultFuncs.post = async (url, jar, form) => {
    assert.equal(jar, ctx.jar);
    posted.push({ url, form });
    return { statusCode: 200, body: JSON.stringify({ data }) };
  };
  const setStoryReaction = require("../src/setStoryReaction")(defaultFuncs, api, ctx);

  assert.deepEqual(await setStoryReaction("story_12345", 2), { data });
  assert.equal(posted.length, 1);
  const graphqlCall = posted[0];
  assert.equal(graphqlCall.url, "https://www.facebook.com/api/graphql/");
  assert.equal(graphqlCall.form.fb_api_req_friendly_name, "useStoriesSendReplyMutation");
  assert.equal(graphqlCall.form.doc_id, "4826141330837571");
  assert.notEqual(graphqlCall.form.doc_id, "6034020023291008");
  const input = JSON.parse(graphqlCall.form.variables).input;
  assert.equal(input.story_id, "story_12345");
  assert.equal(input.story_reply_type, "LIGHT_WEIGHT");
  assert.equal(input.message, "❤️");
  assert.deepEqual(input.lightweight_reaction_actions, { offsets: [0], reaction: "❤️" });
  assert.equal(input.actor_id, ctx.userID);
  assert.ok(input.client_mutation_id);
});

for (const [name, args] of [["setCommentReaction", ["comment_12345", "love"]], ["setStoryReaction", ["story_12345", 2]]]) {
  test(name + " never falls back after HTTP, transport, or GraphQL failures", async () => {
    for (const failure of ["transport", "http", "graphql"]) {
      const { ctx, defaultFuncs, api, posted } = createMockContext();
      defaultFuncs.post = async (url, jar, form) => {
        posted.push({ url, form });
        if (failure === "transport") throw new Error("Connection lost after send");
        return {
          statusCode: failure === "http" ? 503 : 200,
          body: JSON.stringify([{ data: { mutation: { id: "possible-success" } } }, { errors: [{ message: "Mutation outcome uncertain" }] }])
        };
      };
      const method = require("../src/" + name)(defaultFuncs, api, ctx);
      let callbacks = 0;
      let callbackError;
      await assert.rejects(method(...args, error => { callbacks++; callbackError = error; }), error => {
        assert.equal(error, callbackError);
        assert.equal(error.outcome, "unknown");
        if (failure === "graphql") {
          assert.equal(error.code, "GRAPHQL_ERROR");
          assert.equal(error.partialData, true);
        }
        return true;
      });
      assert.equal(callbacks, 1);
      assert.equal(posted.length, 1);
      assert.equal(posted[0].url, "https://www.facebook.com/api/graphql/");
    }
  });
}

test("setStoryReaction honors the configured web operation ID", async () => {
  const { ctx, defaultFuncs, api, posted } = createMockContext();
  ctx.globalOptions.facebookOperations = { useStoriesSendReplyMutation: "999000111222" };
  defaultFuncs.post = async (url, jar, form) => {
    posted.push({ url, form });
    return { statusCode: 200, body: JSON.stringify({ data: { story_reply: { id: "reply" } } }) };
  };
  await require("../src/setStoryReaction")(defaultFuncs, api, ctx)("story_12345", 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].form.doc_id, "999000111222");
});
