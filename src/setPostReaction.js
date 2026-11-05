/** Originally maintained by NTKhang, 10 February 2022. */
'use strict';

const { randomBytes } = require('crypto');
const createGraphQLClient = require('../lib/facebook/GraphQLClient');

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  return function setPostReaction(postID, type, callback) {
    if (typeof type === 'function') {
      callback = type;
      type = 0;
    }
    const promise = Promise.resolve().then(async () => {
      if (typeof postID !== 'string' || !postID.trim()) throw new TypeError('postID must be a nonempty string');
      // Preserve the legacy heart/love mapping; care is an explicit alias.
      const map = { unlike: 0, like: 1, heart: 2, love: 16, care: 16, haha: 4, wow: 3, sad: 7, angry: 8 };
      if (typeof type === 'string') type = Object.prototype.hasOwnProperty.call(map, type.toLowerCase()) ? map[type.toLowerCase()] : undefined;
      if (!Object.values(map).includes(type)) throw new TypeError('setPostReaction: Invalid reaction type');
      const sessionID = randomBytes(16).toString('hex');
      const data = await graphql.request('CometUFIFeedbackReactMutation', {
        input: {
          actor_id: (ctx.globalOptions || {}).pageID || ctx.i_userID || ctx.userID,
          feedback_id: Buffer.from('feedback:' + postID).toString('base64'),
          feedback_reaction: type, feedback_source: 'OBJECT', is_tracking_encrypted: true,
          tracking: [], session_id: sessionID, client_mutation_id: sessionID
        },
        useDefaultActor: false, scale: 3, canUseNicknameOnComet: false,
        __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false
      }, { mutation: true, allowIncremental: true });
      const feedback = data && data.feedback_react && data.feedback_react.feedback;
      if (!feedback || !feedback.top_reactions || !Array.isArray(feedback.top_reactions.edges)) throw new Error('Post reaction response missing feedback');
      return {
        viewer_feedback_reaction_info: feedback.viewer_feedback_reaction_info,
        supported_reactions: feedback.supported_reactions,
        top_reactions: feedback.top_reactions.edges,
        reaction_count: feedback.reaction_count
      };
    });
    if (typeof callback === 'function') promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
    return promise;
  };
};
