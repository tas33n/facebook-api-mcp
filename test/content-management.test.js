"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const identity = { postID: "456", actorID: "123" };
const storyID = Buffer.from("S:_I123:456").toString("base64");
const ctx = () => ({ userID: "123", globalOptions: {}, jar: {} });
const response = data => ({ statusCode: 200, body: JSON.stringify({ data }) });

test("post editing verifies new text and never retries failed mutations", async () => {
  let calls = 0, captured;
  const edit = require("../src/editPost")({ post: async (url, jar, form) => {
    calls++; captured = JSON.parse(form.variables); return response({ story_edit: { story: { id: storyID } } });
  } }, { getPost: async () => ({ text: "updated" }) }, ctx());
  assert.equal((await edit(identity, "updated")).verified, true);
  assert.equal(captured.input.story_id, storyID);
  assert.equal(captured.input.attachments, undefined, "text edit must not clear media");
  const broken = require("../src/editPost")({ post: async () => { calls++; throw new Error("timeout"); } }, {}, ctx());
  await assert.rejects(broken(identity, "new"), { outcome: "unknown" });
  assert.equal(calls, 2);
});

test("deletion requires server identity and separate absent-node evidence", async () => {
  let calls = 0;
  const del = require("../src/deletePost")({ post: async () => ++calls === 1 ? response({ story_delete: { deleted_story_id: storyID } }) : response({ node: null }) }, {}, ctx());
  assert.deepEqual(await del(identity), { deletedStoryID: storyID, verified: true });
  const wrong = require("../src/deletePost")({ post: async () => response({ story_delete: null }) }, {}, ctx());
  await assert.rejects(wrong(identity), { outcome: "unknown" });
});

test("comment deletion cannot claim complete verification from a partial comment page", async () => {
  const id = Buffer.from("comment:456_789").toString("base64");
  const del = require("../src/deleteCommentPost")({ post: async () => response({ comment_delete: { deleted_comment_id: id } }) },
    { getPostComments: async () => ({ items: [], pageInfo: { hasNextPage: true } }) }, ctx());
  assert.equal((await del("789", { postID: "456" })).verified, false);
});

test("audience update obtains editable scope and verifies current row", async () => {
  let calls = 0;
  const method = require("../src/setPostAudience")({ post: async (url, jar, form) => {
    calls++;
    if (calls === 1) return response({ node: { scope: { privacy_write_id: "scope-id", can_viewer_edit: true } } });
    if (calls === 2) {
      const input = JSON.parse(form.variables).input;
      assert.equal(input.privacy_write_id, "scope-id"); assert.equal(input.privacy_row_input.base_state, "EVERYONE");
      return response({ privacy_selector_save: {} });
    }
    return response({ node: { privacy_row_input: { base_state: "EVERYONE" } } });
  } }, {}, ctx());
  assert.equal((await method(identity, "PUBLIC")).verified, true);
});

test("verified publication never replays creation when URL cannot be resolved", async () => {
  let creates = 0, reads = 0;
  const fn = require("../src/publishPostVerified")({}, {
    createPost: async () => { creates++; return "https://www.facebook.com/me/posts/pfbidX"; },
    getProfilePosts: async () => { reads++; return { items: [], pageInfo: { hasNextPage: false } }; },
  }, ctx());
  const result = await fn("hello");
  assert.equal(result.verification.verified, false); assert.equal(creates, 1); assert.equal(reads, 1);
});

test("comment edit preserves attachments and verifies returned text independently", async () => {
  const id = Buffer.from("comment:456_789").toString("base64");
  const edit = require("../src/editCommentPost")({ post: async (url, jar, form) => {
    const variables = JSON.parse(form.variables);
    assert.equal(variables.input.comment_id, id);
    assert.equal(variables.input.attachments, null);
    return response({ comment_edit: { comment: { id } } });
  } }, { getPostComments: async () => ({ items: [{ id, text: "new" }] }) }, ctx());
  assert.equal((await edit(id, "new")).verified, true);
});

test("Page Plus timeline validates delegate Page rather than treating every User as Page", async () => {
  const method = require("../src/getPagePosts")({ post: async (url, jar, form) => {
    if (form.fb_api_req_friendly_name === "ProfileCometTimelineListViewRootQuery") return response({ user: { id: "123", delegate_page: { id: "456" } } });
    return response({ node: { __typename: "User", id: "123", timeline_list_feed_units: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } });
  } }, {}, ctx());
  assert.equal((await method("123")).delegatePageID, "456");
});

test("audience normalization follows array metadata but excludes shared original privacy", () => {
  const { normalizePost } = require("../lib/facebook/PostReader");
  const root = { __typename: "Story", id: storyID, post_id: "456", comet_sections: { context_layout: { story: {
    id: storyID, comet_sections: { metadata: [{ story: { privacy_scope: { privacy_scope_renderer: { privacy_row_input: { base_state: "EVERYONE" } } } } }] },
  } } }, attached_story: { privacy_row_input: { base_state: "SELF" } } };
  assert.equal(normalizePost({ node: root }, { storyID, postID: "456" }).audience, "PUBLIC");
});

test("verified publication preserves accepted URL after readback transport failure", async () => {
  let creates = 0;
  const method = require("../src/publishPostVerified")({}, {
    createPost: async () => { creates++; return "https://www.facebook.com/123/posts/456/"; },
    getProfilePosts: async () => { throw new Error("read timeout"); },
  }, ctx());
  const result = await method("hi");
  assert.equal(result.url, "https://www.facebook.com/123/posts/456/");
  assert.equal(result.verification.status, "unavailable");
  assert.equal(creates, 1);
});

test("management rejects conflicting identities and ignores foreign attachment scopes", async () => {
  const m = require("../lib/facebook/ContentManagement");
  assert.throws(() => m.storyIdentity({ storyID, postID: "999" }));
  assert.throws(() => m.commentID(Buffer.from("comment:999_1").toString("base64"), "456"));
  const visited = [];
  m.walkRootStory({ id: storyID, attachment: { story: { privacy_write_id: "foreign" } }, comet_sections: {
    wrong: { story: { __typename: "Story", id: Buffer.from("S:_I123:999").toString("base64"), privacy_write_id: "also-foreign" } },
  } }, node => { if (node.privacy_write_id) visited.push(node.privacy_write_id); });
  assert.deepEqual(visited, []);
});

test("publication validates before mutation and does not equate query-style post URLs", async () => {
  let creates = 0, selected;
  const fn = require("../src/publishPostVerified")({}, {
    createPost: async () => { creates++; return "https://www.facebook.com/permalink.php?story_fbid=456&id=123"; },
    getProfilePosts: async () => ({ items: [{ url: "https://www.facebook.com/permalink.php?story_fbid=999&id=123", storyID: "wrong" }], pageInfo: { hasNextPage: false } }),
    verifyPublication: async target => { selected = target; },
  }, ctx());
  await assert.rejects(fn("text", { maxAttempts: 0 }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fn("text", { signal: controller.signal }), { code: "ABORTED" });
  assert.equal(creates, 0);
  const result = await fn("text");
  assert.equal(creates, 1); assert.equal(selected, undefined); assert.equal(result.verification.verified, false);
});

test("deletion rejects a mismatched acknowledgment and honors switched actor", async () => {
  let actor;
  const fn = require("../src/deleteCommentPost")({ post: async (url, jar, form) => {
    actor = JSON.parse(form.variables).input.actor_id;
    return response({ comment_delete: { deleted_comment_id: "wrong" } });
  } }, {}, { ...ctx(), i_userID: "777" });
  await assert.rejects(fn("789", { postID: "456" }), { outcome: "unknown" });
  assert.equal(actor, "777");
});
