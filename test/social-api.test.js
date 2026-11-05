'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { Readable } = require('node:stream');

const feedback = {
  viewer_feedback_reaction_info: { id: '1' }, supported_reactions: [],
  top_reactions: { edges: [] }, reaction_count: { count: 1 }
};
const responses = {
  ComposerStoryCreateMutation: { story_create: { story: { url: 'https://www.facebook.com/100/posts/200' } } },
  ComposerLinkAttachmentPreviewQuery: { link_preview: { share_scrape_data: '{"share_type":1}' } },
  useCometUFICreateCommentMutation: {
    comment_create: {
      feedback_comment_edge: { node: { id: 'comment-id', feedback: { url: 'https://www.facebook.com/comment' } } },
      feedback: { total_comment_count: 0 }
    }
  },
  CometUFIFeedbackReactMutation: { feedback_react: { feedback } },
  useStoriesSendReplyMutation: { story_reply: { id: 'reply-id' } }
};

// Stub only the shared client's documented contract. These tests remain usable
// while the separately owned transport/registry is being integrated.
function setup(name, options = {}) {
  const calls = [];
  const uploads = [];
  const ctx = { userID: '100', jar: {}, globalOptions: {} };
  const defaultFuncs = {
    post() { throw new Error('Unexpected direct HTTP mutation/fallback'); },
    async postFormData(url, jar, form) {
      uploads.push({ url, jar, form });
      if (options.uploadError) throw options.uploadError;
      return {
        statusCode: options.statusCode || 200,
        body: JSON.stringify(options.uploadResponse || { payload: { photoID: 'photo-id', fbid: 'media-id' } }),
        request: { options: { url, method: 'POST' } }
      };
    }
  };
  const originalLoad = Module._load;
  const filename = require.resolve('../src/' + name);
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (request === '../lib/facebook/GraphQLClient') {
      return (funcs, context) => {
        assert.equal(funcs, defaultFuncs);
        assert.equal(context, ctx);
        return { request: async (operation, variables, requestOptions) => {
          calls.push({ operation, variables, options: requestOptions });
          if (options.error) throw options.error;
          return options.response !== undefined ? options.response : responses[operation];
        } };
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let factory;
  try { factory = require(filename); }
  finally {
    Module._load = originalLoad;
    delete require.cache[filename];
  }
  return { method: factory(defaultFuncs, {}, ctx), calls, uploads };
}

const cases = [
  ['createPost', ['hello']],
  ['createCommentPost', ['hello', '200']],
  ['setPostReaction', ['200', 'like']],
  ['setCommentReaction', ['300', 'like']],
  ['setStoryReaction', ['400', 1]]
];

for (const [name, args] of cases) {
  test(name + ' settles its promise and callback once on success', { timeout: 2000 }, async () => {
    const { method, calls } = setup(name);
    const observed = [];
    const result = await method(...args, (err, value) => observed.push({ err, value }));
    assert.deepEqual(observed, [{ err: null, value: result }]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, ['createCommentPost', 'setPostReaction'].includes(name) ? { mutation: true, allowIncremental: true } : { mutation: true });
    assert.ok(calls[0].variables.input.client_mutation_id);
    if (name === 'createPost') assert.equal(result, 'https://www.facebook.com/100/posts/200');
    if (name === 'createCommentPost') assert.equal(result.count, 0);
  });

  test(name + ' reports uncertain failure once without replay', { timeout: 2000 }, async () => {
    const error = new Error('Socket closed after request was sent');
    const { method, calls } = setup(name, { error });
    const observed = [];
    await assert.rejects(method(...args, (err, value) => observed.push({ err, value })), err => err === error);
    assert.deepEqual(observed, [{ err: error, value: undefined }]);
    assert.equal(calls.length, 1);
  });

  test(name + ' does not call a throwing callback twice', async () => {
    const { method, calls } = setup(name);
    let count = 0;
    await method(...args, () => { count++; throw new Error('Consumer callback failed'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(count, 1);
    assert.equal(calls.length, 1);
  });

  test(name + ' rejects incomplete mutation responses', async () => {
    const { method, calls } = setup(name, { response: {} });
    await assert.rejects(method(...args), /response missing/);
    assert.equal(calls.length, 1);
  });
}

test('posting normalizes frozen input without changing it', async () => {
  const mention = Object.freeze({ tag: 'Friend', id: '900', fromIndex: 0 });
  const message = Object.freeze({ body: 'Friend hello', mentions: mention, allowUserID: '900', url: 'https://example.com' });
  const { method, calls } = setup('createPost');
  await method(message);
  assert.equal(message.mentions, mention);
  assert.equal(message.allowUserID, '900');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operation, 'ComposerLinkAttachmentPreviewQuery');
  const input = calls[1].variables.input;
  assert.deepEqual(input.message.ranges, [{ entity: { id: '900' }, offset: 0, length: 6 }]);
  assert.deepEqual(input.audience.privacy.allow, ['900']);
  assert.equal(input.idempotence_token, input.client_mutation_id + '_FEED');
});

test('comments preserve frozen inputs and both legacy reply signatures', async () => {
  const message = Object.freeze({ body: 'Hi Friend', mentions: Object.freeze({ tag: 'Friend', id: '900' }) });
  const { method, calls } = setup('createCommentPost');
  await method(message, '200', '301');
  let count = 0;
  await method(message, '200', () => count++, '302');
  assert.equal(count, 1);
  assert.equal(message.attachments, undefined);
  assert.equal(Buffer.from(calls[0].variables.input.reply_comment_parent_fbid, 'base64').toString(), 'comment:200_301');
  assert.equal(Buffer.from(calls[1].variables.input.reply_comment_parent_fbid, 'base64').toString(), 'comment:200_302');
  assert.equal(calls[0].variables.input.idempotence_token, 'client:' + calls[0].variables.input.client_mutation_id);
  assert.notEqual(calls[0].variables.input.client_mutation_id, calls[1].variables.input.client_mutation_id);
});

test('all attachment and mention validation happens before any upload', async () => {
  for (const name of ['createPost', 'createCommentPost']) {
    const key = name === 'createPost' ? 'attachment' : 'attachments';
    const { method, calls, uploads } = setup(name);
    const invoke = msg => name === 'createPost' ? method(msg) : method(msg, '200');
    await assert.rejects(invoke({ body: 'hello', [key]: [Readable.from('photo'), 'bad'] }), /readable stream/);
    await assert.rejects(invoke({ body: 'hello', [key]: Readable.from('photo'), mentions: { tag: 'absent', id: '900' } }), /not found/);
    assert.equal(uploads.length, 0);
    assert.equal(calls.length, 0);
  }
});

test('successful uploads retain their IDs in the mutation variables', async () => {
  for (const name of ['createPost', 'createCommentPost']) {
    const key = name === 'createPost' ? 'attachment' : 'attachments';
    const stream = Readable.from('photo');
    const message = Object.freeze({ body: 'hello', [key]: stream });
    const { method, uploads, calls } = setup(name);
    if (name === 'createPost') await method(message);
    else await method(message, '200');
    assert.equal(message[key], stream);
    assert.equal(uploads.length, 1);
    assert.deepEqual(calls[0].variables.input.attachments, name === 'createPost' ? [{ photo: { id: 'photo-id' } }] : [{ media: { id: 'media-id' } }]);
  }
});

test('HTTP 500 upload failure is never retried or followed by a post', async () => {
  for (const name of ['createPost', 'createCommentPost']) {
    const key = name === 'createPost' ? 'attachment' : 'attachments';
    const { method, uploads, calls } = setup(name, { statusCode: 500 });
    const message = { body: 'hello', [key]: Readable.from('photo') };
    await assert.rejects(name === 'createPost' ? method(message) : method(message, '200'), /HTTP 500/);
    assert.equal(uploads.length, 1);
    assert.equal(calls.length, 0);
  }
});

test('invalid input rejects through the same callback and promise without network access', async () => {
  const invalid = [
    ['createPost', [null]], ['createPost', [{ body: 'x', baseState: 4 }]],
    ['createCommentPost', ['hello', '']],
    ['setPostReaction', ['200', NaN]], ['setPostReaction', ['200', 'toString']],
    ['setCommentReaction', ['300', 'unknown']], ['setCommentReaction', ['', 1]],
    ['setStoryReaction', ['400', NaN]], ['setStoryReaction', ['400', 'garbage']],
    ['setStoryReaction', [Number.MAX_SAFE_INTEGER + 1, 1]]
  ];
  for (const [name, args] of invalid) {
    const { method, calls, uploads } = setup(name);
    let received;
    let count = 0;
    await assert.rejects(method(...args, error => { received = error; count++; }), error => error === received);
    assert.equal(count, 1);
    assert.equal(calls.length + uploads.length, 0);
  }
});

test('callback shorthand preserves legacy reaction defaults', async () => {
  for (const [name, expected] of [['setPostReaction', 0], ['setCommentReaction', 1], ['setStoryReaction', '👍']]) {
    const { method, calls } = setup(name);
    let count = 0;
    await method('200', () => count++);
    assert.equal(count, 1);
    const input = calls[0].variables.input;
    assert.equal(name === 'setStoryReaction' ? input.message : input.feedback_reaction, expected);
  }
});

const clientAvailable = require('node:fs').existsSync(require('node:path').join(__dirname, '../lib/facebook/GraphQLClient.js'));
test('shared GraphQL client integration handles arrays and rejects partial-data errors without replay', { skip: !clientAvailable }, async () => {
  for (const [name, args] of cases) {
    const operation = name === 'createPost' ? 'ComposerStoryCreateMutation'
      : name === 'createCommentPost' ? 'useCometUFICreateCommentMutation'
        : name === 'setStoryReaction' ? 'useStoriesSendReplyMutation' : 'CometUFIFeedbackReactMutation';
    for (const withError of [false, true]) {
      let count = 0;
      const defaultFuncs = {
        async post(url, jar, form) {
          count++;
          const payload = [{ data: responses[operation] }];
          if (withError) payload.push({ errors: [{ message: 'Mutation outcome unknown' }] });
          return { statusCode: 200, body: JSON.stringify(payload), request: { options: { url, method: 'POST', form } } };
        }
      };
      const ctx = { userID: '100', jar: {}, globalOptions: {} };
      const method = require('../src/' + name)(defaultFuncs, {}, ctx);
      if (withError) await assert.rejects(method(...args));
      else assert.ok(await method(...args));
      assert.equal(count, 1);
    }
  }
});
