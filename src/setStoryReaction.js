'use strict';

const { randomBytes } = require('crypto');
const createGraphQLClient = require('../lib/facebook/GraphQLClient');

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  return function setStoryReaction(storyID, react, callback) {
    if (typeof react === 'function') {
      callback = react;
      react = 1;
    }
    const promise = Promise.resolve().then(async () => {
      if (!((typeof storyID === 'string' && storyID.trim()) || (Number.isSafeInteger(storyID) && storyID > 0))) throw new TypeError('storyID must be a nonempty string or safe integer');
      const map = { 1: '👍', 2: '❤️', 3: '🤗', 4: '😆', 5: '😮', 6: '😢', 7: '😡' };
      const value = react === undefined ? 1 : react;
      const reactionEmoji = Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value;
      if (!Object.values(map).includes(reactionEmoji)) throw new TypeError('setStoryReaction: Invalid reaction');
      const mutationID = randomBytes(16).toString('hex');
      // Web schema only. The registry's historical web ID (4826141330837571)
      // is not live-verified; native Messenger IDs are incompatible here.
      const data = await graphql.request('useStoriesSendReplyMutation', {
        input: {
          attribution_id_v2: `StoriesCometSuspenseRoot.react,comet.stories.viewer,unexpected,${Date.now()},538296,,;CometHomeRoot.react,comet.home,via_cold_start,${Date.now()},850302,4748854339,`,
          lightweight_reaction_actions: { offsets: [0], reaction: reactionEmoji },
          message: reactionEmoji, story_id: String(storyID), story_reply_type: 'LIGHT_WEIGHT',
          actor_id: String((ctx.globalOptions || {}).pageID || ctx.i_userID || ctx.userID),
          client_mutation_id: mutationID
        }
      }, { mutation: true });
      if (!data || typeof data !== 'object' || !Object.values(data).some(value => value != null)) throw new Error('Story reaction response missing mutation data');
      return { data };
    });
    if (typeof callback === 'function') promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
    return promise;
  };
};
