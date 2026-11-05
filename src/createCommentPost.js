// Facebook API MCP: create a comment using the active web GraphQL operation.
'use strict';

const utils = require('../utils');
const { randomBytes } = require('crypto');
const createGraphQLClient = require('../lib/facebook/GraphQLClient');

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  return function createCommentPost(msg, postID, callback, replyCommentID) {
    if (typeof callback === 'string') {
      replyCommentID = callback;
      callback = undefined;
    }
    if (typeof msg === 'function') callback = msg;
    else if (typeof postID === 'function') callback = postID;

    const promise = Promise.resolve().then(async () => {
      if (typeof msg === 'string') msg = { body: msg };
      else if (!msg || utils.getType(msg) !== 'Object') throw new TypeError('Message must be a string or object');
      msg = { ...msg };
      for (const key of ['attachments', 'mentions']) {
        msg[key] = msg[key] == null ? [] : Array.isArray(msg[key]) ? msg[key].slice() : [msg[key]];
      }
      msg.body = msg.body == null ? '' : typeof msg.body === 'object' ? JSON.stringify(msg.body) : String(msg.body);
      if (typeof postID !== 'string' || !postID.trim()) throw new TypeError('postID must be a nonempty string');
      if (replyCommentID != null && (typeof replyCommentID !== 'string' || !replyCommentID.trim())) throw new TypeError('replyCommentID must be a nonempty string');
      if (msg.url != null && (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url))) throw new TypeError('url must be an HTTP(S) URL');
      if (msg.sticker != null && !((typeof msg.sticker === 'string' && /^\d+$/.test(msg.sticker)) || (Number.isSafeInteger(msg.sticker) && msg.sticker > 0))) throw new TypeError('sticker must be an ID');
      if (msg.attachments.some(item => !utils.isReadableStream(item))) throw new TypeError('Image should be a readable stream');
      if ([msg.attachments.length > 0, !!msg.url, msg.sticker != null].filter(Boolean).length > 1) throw new TypeError('Choose attachments, a URL or a sticker');
      if (!msg.body.trim() && !msg.attachments.length && !msg.url && msg.sticker == null) throw new TypeError('Comment must contain text or an attachment');

      const ranges = msg.mentions.map(item => {
        if (!item || typeof item.tag !== 'string' || !item.tag) throw new TypeError('Mention tag must be a nonempty string');
        if (typeof item.id !== 'string' || !item.id.trim()) throw new TypeError('Mention id must be a nonempty string');
        if (item.fromIndex !== undefined && (!Number.isInteger(item.fromIndex) || item.fromIndex < 0)) throw new TypeError('Invalid mention fromIndex');
        const offset = msg.body.indexOf(item.tag, item.fromIndex || 0);
        if (offset < 0) throw new Error('Mention for "' + item.tag + '" not found in message string');
        return { entity: { id: item.id }, length: item.tag.length, offset };
      });
      const sessionID = randomBytes(16).toString('hex');
      let feedbackID = Buffer.from('feedback:' + postID).toString('base64');
      if (replyCommentID) {
        const decoded = /^\d+$/.test(replyCommentID) ? replyCommentID : Buffer.from(replyCommentID, 'base64').toString('utf8');
        const legacyID = /^\d+$/.test(decoded) ? decoded : /^comment:\d+_(\d+)$/.exec(decoded)?.[1];
        if (!legacyID) throw new TypeError('replyCommentID must encode a recognized comment identity');
        feedbackID = Buffer.from('feedback:' + legacyID).toString('base64');
      }
      const form = {
        feedLocation: 'NEWSFEED', feedbackSource: 1, groupID: null,
        input: {
          client_mutation_id: sessionID,
          actor_id: (ctx.globalOptions || {}).pageID || ctx.i_userID || ctx.userID,
          attachments: [],
          feedback_id: feedbackID,
          formatting_style: null,
          message: { ranges, text: msg.body },
          reply_comment_parent_fbid: replyCommentID ? /^\d+$/.test(replyCommentID) ? Buffer.from('comment:' + postID + '_' + replyCommentID).toString('base64') : replyCommentID : null,
          reply_target_clicked: !!replyCommentID,
          attribution_id_v2: 'CometHomeRoot.react,comet.home,via_cold_start,' + Date.now() + ',156248,4748854339,,',
          vod_video_timestamp: null, feedback_referrer: '/', is_tracking_encrypted: true,
          tracking: [], feedback_source: 'NEWS_FEED',
          idempotence_token: 'client:' + sessionID, session_id: sessionID
        },
        inviteShortLinkKey: null, renderLocation: null, scale: 1, useDefaultActor: false, focusCommentID: null
      };

      for (const file of msg.attachments) {
        const response = await defaultFuncs.postFormData('https://www.facebook.com/ajax/ufi/upload/', ctx.jar, {
          profile_id: ctx.userID, source: 19, target_id: ctx.userID, file
        });
        // Do not replay uploads through the legacy parser's HTTP retry path.
        if (response.statusCode !== 200) throw new Error('Comment upload failed with HTTP ' + response.statusCode);
        const res = await utils.parseAndCheckLogin(ctx, defaultFuncs, 5)(response);
        if (res.error || (res.errors && res.errors.length)) throw res;
        if (!res.payload || !res.payload.fbid) throw new Error('Comment upload response missing fbid');
        form.input.attachments.push({ media: { id: String(res.payload.fbid) } });
      }
      if (msg.url) form.input.attachments.push({ link: { external: { url: msg.url } } });
      if (msg.sticker != null) form.input.attachments.push({ media: { id: String(msg.sticker) } });

      if (graphql.registry?.resolve('useCometUFICreateCommentMutation').docId === '28865832786377560') {
        Object.assign(form, require('../lib/facebook/ComposerVariables'), { translationType: 'ORIGINAL', canUseNicknameOnComet: false });
      }
      const data = await graphql.request('useCometUFICreateCommentMutation', form, { mutation: true, allowIncremental: true });
      const result = data && data.comment_create;
      const node = result && result.feedback_comment_edge && result.feedback_comment_edge.node;
      if (!node || !node.id || !node.feedback || !node.feedback.url || !result.feedback) {
        throw new Error('Comment creation response missing comment ID, URL or count');
      }
      return { id: node.id, url: node.feedback.url, count: result.feedback.total_comment_count ?? result.feedback.comment_rendering_instance?.comments?.total_count ?? null };
    });
    if (typeof callback === 'function') promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
    return promise;
  };
};
