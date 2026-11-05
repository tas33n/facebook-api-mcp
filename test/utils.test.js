"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../utils");

test("utils.getType should accurately detect JavaScript types", () => {
  assert.equal(utils.getType("hello"), "String");
  assert.equal(utils.getType(123), "Number");
  assert.equal(utils.getType([]), "Array");
  assert.equal(utils.getType({}), "Object");
  assert.equal(utils.getType(true), "Boolean");
  assert.equal(utils.getType(() => {}), "Function");
  assert.equal(utils.getType(null), "Null");
  assert.equal(utils.getType(undefined), "Undefined");
});

test("utils.formatID should format Facebook IDs cleanly", () => {
  assert.equal(utils.formatID("100012345678"), "100012345678");
  assert.equal(utils.formatID(100012345678), "100012345678");
  assert.equal(utils.formatID(""), "");
});

test("utils.generateOfflineThreadingID should return a numeric timestamp-based ID", () => {
  const id1 = utils.generateOfflineThreadingID();
  const id2 = utils.generateOfflineThreadingID();
  assert.ok(typeof id1 === "string" && id1.length > 10);
  assert.ok(typeof id2 === "string" && id2.length > 10);
  assert.notEqual(id1, id2);
});

test("utils.getGUID should generate valid RFC4122 v4 UUID format", () => {
  const guid = utils.getGUID();
  assert.match(
    guid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test("utils.getJar should initialize CookieJar with sync and async helpers", () => {
  const jar = utils.getJar();
  assert.ok(jar);
  jar.setCookie("test_key=test_val; domain=.facebook.com; path=/", "https://facebook.com");
  const cookies = jar.getCookies("https://facebook.com");
  assert.ok(Array.isArray(cookies));
  assert.ok(cookies.some((c) => (c.key || c.name) === "test_key" && c.value === "test_val"));
});

test("utils.getLatestDocIDs exposes legacy static native references, not verified web operations", async () => {
  const docIds = await utils.getLatestDocIDs();
  assert.ok(docIds);
  assert.equal(docIds.setStoryReaction, "6034020023291008");
  assert.equal(docIds.montageMarkRead, "5364678523649693");
  assert.equal(docIds.montageHighlight, "5337590146334078");
  assert.equal(docIds.montageList, "3159018617747123");
  assert.ok(docIds.sendMessage);
  assert.ok(docIds.getThreadList);
  // This legacy utility is a static reference table, despite its name. Native
  // IDs must never be substituted into the web-cookie operation's variables.
  const { OperationRegistry } = require("../lib/facebook/OperationRegistry");
  const registry = new OperationRegistry();
  const web = registry.resolve("useStoriesSendReplyMutation");
  assert.equal(web.docId, "4826141330837571");
  assert.notEqual(web.docId, docIds.setStoryReaction);
  assert.equal(web.transport, "web-cookie");
  assert.equal(web.source, "historical-web");
  assert.equal(web.verified, false);
  assert.throws(() => registry.register("FBMontageReactionMutation", {
    docId: docIds.setStoryReaction, transport: "native-orca"
  }), { code: "TRANSPORT_MISMATCH" });
});

test("utils.cleanHTML should strip tags and decode entities", () => {
  const html = "<div>Hello &amp; <b>World</b>!</div>";
  const cleaned = utils.cleanHTML(html);
  assert.ok(!cleaned.includes("<div>"));
  assert.ok(!cleaned.includes("<b>"));
  assert.ok(cleaned.includes("Hello"));
  assert.ok(cleaned.includes("World"));
});

test("utils.makeParsable should strip Facebook JSON anti-hijack prefix", () => {
  const raw1 = 'for (;;);{"key":"value"}';
  const raw2 = ')]}\'{"key":"value"}';
  assert.equal(utils.makeParsable(raw1), '{"key":"value"}');
  assert.equal(utils.makeParsable(raw2), '{"key":"value"}');
});

test("utils.decodeClientPayload decodes valid byte buffers and payloads", () => {
  const sample = { test: 123 };
  const str = JSON.stringify(sample);
  const buf = Buffer.from(str, "utf8");
  const decoded = utils.decodeClientPayload(buf);
  assert.ok(decoded);
});
