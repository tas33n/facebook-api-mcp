'use strict';

const { randomBytes } = require('crypto');
const createGraphQLClient = require('../lib/facebook/GraphQLClient');

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  return function setCommentReaction(commentID, reactionType, callback) {
    if (typeof reactionType === 'function') {
      callback = reactionType;
      reactionType = 1;
    }
    const promise = Promise.resolve().then(async () => {
      if (typeof commentID !== 'string' || !commentID.trim()) throw new TypeError('commentID must be a nonempty string');
      const map = { unlike: 0, like: 1, heart: 2, love: 16, care: 16, haha: 4, wow: 3, sad: 7, angry: 8 };
      let type = reactionType === undefined ? 1 : reactionType;
      if (typeof type === 'string') type = Object.prototype.hasOwnProperty.call(map, type.toLowerCase()) ? map[type.toLowerCase()] : undefined;
      if (!Object.values(map).includes(type)) throw new TypeError('setCommentReaction: Invalid reaction type');
      const sessionID = randomBytes(16).toString('hex');
      const data = await graphql.request('CometUFIFeedbackReactMutation', {
        input: {
          actor_id: (ctx.globalOptions || {}).pageID || ctx.i_userID || ctx.userID,
          client_mutation_id: sessionID, session_id: sessionID,
          feedback_id: Buffer.from('feedback:' + commentID).toString('base64'),
          feedback_reaction: type, feedback_source: 'OBJECT', is_tracking_encrypted: true, tracking: []
        },
        useDefaultActor: false
      }, { mutation: true });
      if (!data || !data.feedback_react || !data.feedback_react.feedback) throw new Error('Comment reaction response missing feedback');
      // Retain the legacy GraphQL envelope returned by this method.
      return { data };
    });
    if (typeof callback === 'function') promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
    return promise;
  };
};
