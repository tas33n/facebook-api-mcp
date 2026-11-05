"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { storyIdentity, normalizePost, normalizeComments } = require("../lib/facebook/PostReader");
const getPostFactory = require("../src/getPost");
const commentsFactory = require("../src/getPostComments");
const repliesFactory = require("../src/getCommentReplies");

const storyID = Buffer.from("S:_I100:200").toString("base64");
const identity = storyIdentity(storyID);
const info = (hasNext = false, cursor = null) => ({ has_next_page: hasNext, end_cursor: cursor });
const comment = { id: "comment-1", body: { text: "A comment" }, author: { id: "300" },
  feedback: { id: "comment-feedback" }, replies_connection: { count: 2, page_info: info(true, "reply-cursor") } };
const connection = (edges = [{ node: comment }]) => ({ edges, page_info: info(true, "next-cursor") });
function nestedStory(media = [], feedback = {}) {
  return { node: { __typename: "Story", id: storyID, post_id: "200", url: "https://www.facebook.com/100/posts/200",
    comet_sections: {
      context_layout: { story: { actors: [{ id: "100" }] } },
      content: { story: { comet_sections: {
        message: { story: { message: { text: "Root text" } } },
        attachment: { story: { attachments: media.map(item => ({ styles: { attachment: { media: item } } })) } },
      } } },
      feedback: { story: { feedback: { feedback: { id: "post-feedback", ...feedback } } } },
    },
  } };
}
function client(factory, data) {
  const calls = [];
  const defaults = { async post(url, jar, form) {
    calls.push({ url, form, variables: JSON.parse(form.variables) });
    return { statusCode: 200, body: JSON.stringify({ data }) };
  } };
  const ctx = { jar: {}, globalOptions: { facebookOperations: {
    groupsCometFetchStoryQuery: "29252258941075043",
    CommentsListComponentsPaginationQuery: "29013552121638010",
    Depth1CommentsListPaginationQuery: "29315530901392279",
  } } };
  return { read: factory(defaults, {}, ctx), calls };
}

test("story identities require an actor for numeric posts and never decode pfbid", () => {
  assert.deepEqual(storyIdentity({ postID: "200", actorID: "100" }), identity);
  assert.deepEqual(storyIdentity("200", { actorID: "100" }), identity);
  assert.deepEqual(storyIdentity({ storyID }), identity);
  for (const input of ["200", "pfbid123456", "S:_I100:200", 200, {}, null]) {
    assert.throws(() => storyIdentity(input), { code: "INVALID_ARGUMENT" });
  }
});

test("equivalent repeated-post story aliases match root and nested story identities", () => {
  const alias = Buffer.from("S:_I100:200:200").toString("base64");
  assert.deepEqual(storyIdentity(alias), { ...identity, storyID: alias });
  assert.throws(() => storyIdentity(Buffer.from("S:_I100:200:201").toString("base64")), { code: "INVALID_ARGUMENT" });
  const data = nestedStory();
  data.node.id = alias;
  delete data.node.post_id;
  data.node.comet_sections.content.story.id = storyID;
  assert.equal(normalizePost(data, identity).text, "Root text");
  assert.equal(normalizePost(data, identity).storyID, alias);
  data.node.id = Buffer.from("S:_I101:200:200").toString("base64");
  assert.throws(() => normalizePost(data, identity), { code: "POST_UNAVAILABLE" });
});

test("live UFI container shape exposes viewer reaction without inferring its name", () => {
  const data = nestedStory();
  data.node.comet_sections.feedback.story = { story_ufi_container: { story: {
    id: Buffer.from("S:_I100:200:200").toString("base64"),
    feedback_context: { feedback_target_with_context: { comet_ufi_summary_and_actions_renderer: {
      feedback: { id: "root-feedback", viewer_feedback_reaction_info: { id: "reaction-id" },
        adaptive_ufi_action_renderers: [{ feedback: { viewer_feedback_reaction_info: { id: "reaction-id" }, reaction_count: { count: 1 } } }] },
    } } },
  } } };
  const post = normalizePost(data, identity);
  assert.equal(post.feedbackID, "root-feedback");
  assert.equal(post.viewerReactionKnown, true);
  assert.deepEqual(post.viewerReaction, { id: "reaction-id", name: null });
  delete data.node.comet_sections.feedback.story.story_ufi_container.story.feedback_context.feedback_target_with_context.comet_ufi_summary_and_actions_renderer.feedback.viewer_feedback_reaction_info;
  assert.equal(normalizePost(data, identity).viewerReactionKnown, true);
});

test("normalizes nested Comet sections, media, author and exposed reaction state", () => {
  const data = nestedStory([{ __typename: "Photo", id: "photo", image: { uri: "https://cdn/photo" } }], {
    viewer_feedback_reaction_info: { id: "1635855486666999", name: "Like" },
    viewer_has_commented: false, viewer_has_shared: true,
  });
  const post = normalizePost(data, identity);
  assert.equal(post.text, "Root text");
  assert.equal(post.authorID, "100");
  assert.equal(post.feedbackID, "post-feedback");
  assert.equal(post.kind, "photo");
  assert.equal(post.media[0].previewURL, "https://cdn/photo");
  assert.deepEqual(post.viewerReaction, { id: "1635855486666999", name: "Like" });
  assert.equal(post.viewerReactionKnown, true);
  assert.equal(post.viewerHasCommented, false);
  assert.equal(post.viewerHasShared, true);
});

test("unknown viewer fields differ from explicit null reaction and false booleans", () => {
  const unknown = normalizePost(nestedStory(), identity);
  assert.equal(unknown.viewerReaction, null);
  assert.equal(unknown.viewerReactionKnown, false);
  assert.equal(unknown.viewerHasCommented, null);
  assert.equal(unknown.viewerHasShared, null);
  const absent = normalizePost(nestedStory([], { viewer_feedback_reaction_info: null, viewer_has_commented: false, viewer_has_shared: false }), identity);
  assert.equal(absent.viewerReaction, null);
  assert.equal(absent.viewerReactionKnown, true);
  assert.equal(absent.viewerHasCommented, false);
  assert.equal(absent.viewerHasShared, false);
  assert.equal(normalizePost(nestedStory([], { viewer_feedback_reaction_info: {} }), identity).viewerReactionKnown, false);
});

test("classifies video and reel only from explicit fields or reel URL", () => {
  const video = { __typename: "Video", id: "video", playable_url: "https://cdn/video", duration: 5 };
  assert.equal(normalizePost(nestedStory([video]), identity).kind, "video");
  assert.equal(normalizePost(nestedStory([{ ...video, is_fb_short: true }]), identity).kind, "reel");
  assert.equal(normalizePost(nestedStory([{ ...video, url: "https://www.facebook.com/reel/123/" }]), identity).kind, "reel");
  assert.equal(normalizePost(nestedStory([video, { __typename: "Photo", id: "photo" }]), identity).kind, "mixed");
  assert.equal(normalizePost(nestedStory(), identity).kind, "text");
  assert.equal(normalizePost({ node: { __typename: "Story", id: storyID } }, identity).kind, "unknown");
});

test("shared originals and recommendations cannot supply root text, media or viewer state", () => {
  const original = { __typename: "Story", id: "other", message: { text: "Original" },
    feedback: { viewer_has_shared: true }, attachments: [{ media: { __typename: "Video", id: "wrong-video" } }] };
  const root = { __typename: "Story", id: storyID, attachments: [{ target: original, story: original,
    media: { __typename: "Photo", id: "shared-preview" } }],
    recommendations: [original], comet_sections: { content: { story: original } } };
  const post = normalizePost({ node: root }, identity);
  assert.equal(post.text, null);
  assert.equal(post.kind, "unknown");
  assert.deepEqual(post.media, []);
  assert.equal(post.viewerHasShared, null);
  assert.throws(() => normalizePost({ recommendations: [original] }, identity), { code: "POST_UNAVAILABLE" });
  assert.throws(() => normalizePost({ node: original }, identity), { code: "POST_UNAVAILABLE" });
});

test("feedback-context renderers and album subattachments remain inside the root story", () => {
  const data = nestedStory();
  data.node.comet_sections.feedback.story = { feedback_context: { feedback_target_with_context: {
    comet_ufi_summary_and_actions_renderer: { feedback: { id: "actual-feedback", viewer_has_commented: false } },
  } } };
  data.node.attachments = [{ styles: { attachment: { all_subattachments: { nodes: [
    { media: { __typename: "Photo", id: "p1" } },
    { media: { __typename: "Photo", id: "p2" } },
    { media: { __typename: "Photo", id: "p1" } },
  ] } } } }];
  const post = normalizePost(data, identity);
  assert.equal(post.feedbackID, "actual-feedback");
  assert.equal(post.viewerHasCommented, false);
  assert.equal(post.kind, "photo");
  assert.deepEqual(post.media.map(item => item.id), ["p1", "p2"]);
});

test("root timestamps accept creation_time and created_time without borrowing shared or recommended dates", () => {
  const data = nestedStory();
  data.node.creation_time = 100;
  data.node.created_time = 200;
  assert.equal(normalizePost(data, identity).createdTime, 100);
  delete data.node.creation_time;
  assert.equal(normalizePost(data, identity).createdTime, 200);
  delete data.node.created_time;
  data.node.comet_sections.context_layout.story.creation_time = "2026-01-01T00:00:00Z";
  assert.equal(normalizePost(data, identity).createdTime, 1767225600);
  delete data.node.comet_sections.context_layout.story.creation_time;
  const original = { __typename: "Story", id: "original", created_time: 123 };
  data.node.attached_story = original;
  data.node.recommendations = [original];
  assert.equal(normalizePost(data, identity).createdTime, null);
  data.node.creation_time = 0;
  assert.equal(normalizePost(data, identity).createdTime, 0);
});

test("explicit attached_story has separate identity and media metadata and retains root fields", () => {
  const data = nestedStory([], { viewer_has_shared: false });
  const attached = { __typename: "Story", id: Buffer.from("S:_I300:400").toString("base64"),
    message: { text: "Original message" }, actors: [{ id: "300" }], url: "https://www.facebook.com/300/posts/400",
    feedback: { id: "original-feedback", viewer_has_shared: true }, creation_time: 50,
    attachments: [{ media: { __typename: "Video", id: "shared-video", is_fb_short: true } }] };
  data.node.comet_sections.content.story.comet_sections.attached_story = { story: attached };
  const post = normalizePost(data, identity);
  assert.equal(post.kind, "share");
  assert.equal(post.storyID, storyID);
  assert.equal(post.postID, "200");
  assert.equal(post.text, "Root text");
  assert.equal(post.authorID, "100");
  assert.equal(post.feedbackID, "post-feedback");
  assert.equal(post.viewerHasShared, false);
  assert.equal(post.createdTime, null);
  assert.equal(post.sharedPostID, "400");
  assert.equal(post.sharedStoryID, attached.id);
  assert.equal(post.sharedURL, attached.url);
  assert.deepEqual(post.sharedMediaTypes, ["reel"]);
  assert.deepEqual(post.media, []);
  assert.equal(post.url, data.node.url);
  delete data.node.comet_sections.content.story.comet_sections.attached_story;
  data.node.recommendations = [{ attached_story: attached }];
  const plain = normalizePost(data, identity);
  assert.equal(plain.kind, "text");
  assert.equal(plain.sharedPostID, null);
  assert.deepEqual(plain.sharedMediaTypes, []);
});

test("normalizes comment and reply connection pages without claiming global completeness", () => {
  const result = normalizeComments({ node: { comment_rendering_instance_for_feed_location: { comments: connection() } } }, 20);
  assert.equal(result.items[0].id, "comment-1");
  assert.equal(result.items[0].text, "A comment");
  assert.equal(result.items[0].authorID, "300");
  assert.equal(result.items[0].feedbackID, "comment-feedback");
  assert.equal(result.items[0].replyCount, 2);
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "next-cursor" });
  assert.match(result.coverage, /^bounded/);
  assert.deepEqual(normalizeComments({ node: { replies_connection: connection() } }, 20, true).items, result.items);
  const empty = normalizeComments({ node: { replies_connection: { edges: [], page_info: info() } } }, 20, true);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pageInfo.hasNextPage, false);
});

test("missing, malformed and over-limit connections fail instead of returning empty success", () => {
  for (const data of [{}, { node: {} }, { node: { replies_connection: { edges: [] } } },
    { node: { replies_connection: { edges: [], page_info: info(true) } } },
    { node: { replies_connection: connection([{ node: null }]) } },
    { node: { replies_connection: connection([{ node: comment }, { node: comment }]) } }]) {
    assert.throws(() => normalizeComments(data, 1, true), { code: "COMMENTS_UNAVAILABLE" });
  }
});

test("comment feedback reply counts and expansion tokens survive normalization", () => {
  function read(fields, fallback) {
    const node = { id: "comment", feedback: { id: "feedback", replies_fields: fields,
      expansion_info: { expansion_token: "expand-token" } }, replies_connection: fallback };
    return normalizeComments({ node: { replies_connection: connection([{ node }]) } }, 20, true).items[0];
  }
  assert.equal(read({ count: 3 }).replyCount, 3);
  assert.equal(read({ total_count: 4 }).replyCount, 4);
  assert.equal(read({ count: 0, total_count: 4 }, { count: 9 }).replyCount, 0);
  assert.equal(read({ count: -1, total_count: 4 }).replyCount, 4);
  assert.equal(read({ count: "3", total_count: -1 }).replyCount, null);
  assert.equal(read(null, { count: 2 }).replyCount, 2);
  assert.equal(read({ count: 1 }).expansionToken, "expand-token");
});

test("getPost sends exact cookie GraphQL variables and supports promise plus callback", async () => {
  const { read, calls } = client(getPostFactory, nestedStory());
  let called;
  const result = await read({ storyID }, (error, value) => { assert.equal(error, null); called = value; });
  assert.equal(called, result);
  const { form, variables } = calls[0];
  assert.equal(form.doc_id, "29252258941075043");
  assert.equal(form.fb_api_req_friendly_name, "groupsCometFetchStoryQuery");
  assert.equal(variables.id, storyID);
  assert.equal(variables.feedLocation, "TIMELINE");
  assert.equal(variables.feedbackSource, 0);
  assert.equal(variables.privacySelectorRenderLocation, "COMET_STREAM");
  assert.equal(variables.renderLocation, "timeline");
  assert.equal(variables.referringStoryRenderLocation, null);
  assert.equal(variables.useDefaultActor, false);
});

test("comment readers send pagination variables, exact providers and explicit feedback identities", async () => {
  const { read, calls } = client(commentsFactory, { node: { comment_rendering_instance_for_feed_location: { comments: connection() } } });
  await read("200", { limit: 10, cursor: "after" });
  const variables = calls[0].variables;
  assert.equal(calls[0].form.doc_id, "29013552121638010");
  assert.equal(variables.id, Buffer.from("feedback:200").toString("base64"));
  assert.equal(variables.commentsAfterCount, 10);
  assert.equal(variables.commentsAfterCursor, "after");
  assert.equal(variables.commentsBeforeCount, null);
  assert.equal(variables.commentsBeforeCursor, null);
  assert.equal(variables.commentsIntentToken, null);
  assert.equal(variables.targetDialect, null);
  assert.equal(variables.feedLocation, "PERMALINK");
  assert.deepEqual(Object.fromEntries(Object.entries(variables).filter(([key]) => key.startsWith("__relay"))), {
    __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
    __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "AUTO_TRANSLATE",
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
  });
  await read({ feedbackID: "explicit-feedback", limit: 100 });
  assert.equal(calls[1].variables.id, "explicit-feedback");
  assert.equal(calls[1].variables.commentsAfterCount, 100);
});

test("reply reader uses comment feedback ID without inventing a comment-ID encoding", async () => {
  const { read, calls } = client(repliesFactory, { node: { replies_connection: connection() } });
  await read({ commentFeedbackID: "comment-feedback", cursor: "reply-after", limit: 5 });
  assert.equal(calls[0].form.doc_id, "29315530901392279");
  assert.equal(calls[0].variables.id, "comment-feedback");
  assert.equal(calls[0].variables.repliesAfterCount, 5);
  assert.equal(calls[0].variables.repliesAfterCursor, "reply-after");
  assert.equal(calls[0].variables.clientKey, null);
  assert.equal(calls[0].variables.expansionToken, null);
  await read("comment-feedback");
  assert.equal(calls[1].variables.repliesAfterCursor, null);
});

test("reply expansion tokens and client keys pass through with options taking precedence", async () => {
  const { read, calls } = client(repliesFactory, { node: { replies_connection: connection() } });
  await read({ commentFeedbackID: "comment-feedback", expansionToken: "target-token", clientKey: "target-key" });
  assert.equal(calls[0].variables.expansionToken, "target-token");
  assert.equal(calls[0].variables.clientKey, "target-key");
  await read({ commentFeedbackID: "comment-feedback", expansionToken: "target-token", clientKey: "target-key" },
    { expansionToken: "option-token", clientKey: "option-key" });
  assert.equal(calls[1].variables.expansionToken, "option-token");
  assert.equal(calls[1].variables.clientKey, "option-key");
  for (const key of ["expansionToken", "clientKey"]) {
    await assert.rejects(read("comment-feedback", { [key]: 1 }), TypeError);
    await assert.rejects(read({ commentFeedbackID: "comment-feedback", [key]: "x".repeat(16385) }), TypeError);
  }
  assert.equal(calls.length, 2);
});

test("invalid inputs reject asynchronously, notify callbacks, and make no request", async () => {
  for (const factory of [commentsFactory, repliesFactory]) {
    const { read, calls } = client(factory, {});
    for (const options of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { cursor: 3 }, { cursor: "x".repeat(4097) }, null, []]) {
      await assert.rejects(read("200", options), { code: "INVALID_ARGUMENT" });
    }
    assert.equal(calls.length, 0);
  }
  const { read, calls } = client(getPostFactory, {});
  let callbackError;
  await assert.rejects(read("200", error => { callbackError = error; }), { code: "INVALID_ARGUMENT" });
  assert.equal(callbackError.code, "INVALID_ARGUMENT");
  assert.equal(calls.length, 0);
});
