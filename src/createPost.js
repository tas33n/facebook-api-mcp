// Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
// createPost.js - Create a new Facebook post

const utils = require('../utils');
const { randomBytes } = require('crypto');
const createGraphQLClient = require('../lib/facebook/GraphQLClient');

module.exports = function (defaultFuncs, api, ctx) {
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  async function handleUpload(msg, form) {
    for (const attachment of msg.attachment) {
      const response = await defaultFuncs.postFormData(
        'https://upload.facebook.com/ajax/react_composer/attachments/photo/upload', ctx.jar,
        { source: 8, profile_id: ctx.userID, waterfallxapp: 'comet', farr: attachment, upload_id: randomBytes(16).toString('hex') }
      );
      // Uploads are mutations too. Never let the legacy parser replay a failed upload.
      if (response.statusCode !== 200) throw new Error('Photo upload failed with HTTP ' + response.statusCode);
      const res = await utils.parseAndCheckLogin(ctx, defaultFuncs, 5)(response);
      if (res.error || (res.errors && res.errors.length)) throw res;
      if (!res.payload || !res.payload.photoID) throw new Error('Photo upload response missing photoID');
      form.input.attachments.push({ photo: { id: String(res.payload.photoID) } });
    }
  }

  async function handleUrl(msg, form) {
    if (msg.url) {
      var vari = {
        feedLocation: "FEED_COMPOSER",
        focusCommentID: null,
        goodwillCampaignId: "",
        goodwillCampaignMediaIds: [],
        goodwillContentType: null,
        params: {
          url: msg.url
        },
        privacySelectorRenderLocation: "COMET_COMPOSER",
        renderLocation: "composer_preview",
        parentStoryID: null,
        scale: 1,
        useDefaultActor: false,
        shouldIncludeStoryAttachment: false,
        __relay_internal__pv__IsWorkUserrelayprovider: false,
        __relay_internal__pv__IsMergQAPollsrelayprovider: false
      };

      Object.assign(vari, require('../lib/facebook/ComposerVariables'), { referringStoryRenderLocation: null });
      const data = await graphql.request('ComposerLinkAttachmentPreviewQuery', vari, { allowIncremental: true });
      const res = data && data.link_preview;
      if (!res || typeof res.share_scrape_data !== 'string') throw new Error('Link preview response missing share_scrape_data');
      if (JSON.parse(res.share_scrape_data).share_type == 400) throw new Error('url is not accepted');
      form.input.attachments.push({ link: { share_scrape_data: res.share_scrape_data } });
    }
  }

  function handleMention(msg, form) {
    if (!msg.mentions) return;

    for (let mention of msg.mentions) {
      var { id, tag, fromIndex } = mention;

      if (typeof tag !== 'string' || !tag) throw new TypeError('Mention tag must be a nonempty string');
      if (typeof id !== 'string' || !id.trim()) throw new TypeError('Mention id must be a nonempty string');
      if (fromIndex !== undefined && (!Number.isInteger(fromIndex) || fromIndex < 0)) throw new TypeError('Invalid mention fromIndex');
      var offset = msg.body.indexOf(tag, fromIndex || 0);
      if (offset < 0)
        throw new Error('Mention for "' + tag + '" not found in message string.');
      form.input.message.ranges.push({
        entity: { id },
        length: tag.length,
        offset
      });
    }
  }

  return function createPost(msg, callback) {
    if (typeof msg === 'function') callback = msg;
    const rt = Promise.resolve().then(async () => {
    if (typeof msg === 'string') msg = { body: msg };
    else if (!msg || utils.getType(msg) !== 'Object') throw new TypeError('Msg must be a string or object');
    msg = { ...msg };
    for (const key of ['attachment', 'mentions', 'allowUserID']) {
      msg[key] = msg[key] == null ? [] : Array.isArray(msg[key]) ? msg[key].slice() : [msg[key]];
    }
    msg.body = msg.body == null ? '' : typeof msg.body === 'object' ? JSON.stringify(msg.body, null, 2) : String(msg.body);
    if (msg.baseState !== undefined && ![1, 2, 3].includes(msg.baseState)) throw new TypeError('baseState must be 1, 2 or 3');
    if (msg.groupID !== undefined && (typeof msg.groupID !== 'string' || !msg.groupID.trim())) throw new TypeError('groupID must be a nonempty string');
    if (msg.allowUserID.some(id => typeof id !== 'string' || !id.trim())) throw new TypeError('allowUserID must contain nonempty strings');
    if (msg.url != null && (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url))) throw new TypeError('url must be an HTTP(S) URL');
    if (msg.attachment.some(item => !utils.isReadableStream(item))) throw new TypeError('Attachment should be a readable stream');
    if (msg.videoID !== undefined && (typeof msg.videoID !== 'string' || !/^\d+$/.test(msg.videoID))) throw new TypeError('videoID must be a decimal-string ID');
    if (!msg.body.trim() && !msg.url && !msg.attachment.length && !msg.videoID) throw new TypeError('Post must contain text, a URL or an attachment');

    var sessionID = randomBytes(16).toString('hex');
    var base = [
      'EVERYONE',
      'FRIENDS',
      'SELF'
    ];
    var form = {
      input: {
        composer_entry_point: !msg.groupID && msg.url ? 'share_modal' : "inline_composer",
        composer_source_surface: !msg.groupID && msg.url ? 'feed_story' : msg.groupID ? "group" : "timeline",
        composer_type: !msg.groupID && msg.url ? 'share' : msg.groupID ? "group" : "timeline",
        idempotence_token: sessionID + "_FEED",
        source: "WWW",
        attachments: [],
        audience: msg.groupID ? {
          to_id: msg.groupID
        } : {
          privacy: {
            allow: msg.allowUserID ? msg.allowUserID : [],
            base_state: msg.allowUserID && msg.allowUserID.length > 0 ? base[2] : (base[msg.baseState - 1] || base[0]),
            deny: [],
            tag_expansion_state: "UNSPECIFIED"
          }
        },
        message: {
          ranges: [],
          text: msg.body ? typeof msg.body == 'object' ? JSON.stringify(msg.body, null, 2) : msg.body : ''
        },
        with_tags_ids: [],
        inline_activities: [],
        explicit_place_id: 0,
        text_format_preset_id: 0,
        logging: {
          composer_session_id: sessionID
        },
        navigation_data: {
          attribution_id_v2: msg.groupID ? "CometGroupDiscussionRoot.react,comet.group,tap_search_bar," + Date.now() + ",909538,2361831622," : "ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,via_cold_start," + Date.now() + ",796829,190055527696468,"
        },
        is_tracking_encrypted: !!msg.url,
        tracking: [],
        event_share_metadata: {
          surface: "newsfeed"
        },
        actor_id: (ctx.globalOptions || {}).pageID || ctx.i_userID || ctx.userID,
        client_mutation_id: sessionID
      },
      displayCommentsFeedbackContext: null,
      displayCommentsContextEnableComment: null,
      displayCommentsContextIsAdPreview: null,
      displayCommentsContextIsAggregatedShare: null,
      displayCommentsContextIsStorySet: null,
      feedLocation: msg.groupID ? "GROUP" : "TIMELINE",
      feedbackSource: 0,
      focusCommentID: null,
      gridMediaWidth: 230,
      groupID: null,
      scale: 1,
      privacySelectorRenderLocation: "COMET_STREAM",
      renderLocation: msg.groupID ? "group" : "timeline",
      useDefaultActor: false,
      inviteShortLinkKey: null,
      isFeed: false,
      isFundraiser: false,
      isFunFactPost: false,
      isGroup: !!msg.groupID,
      isEvent: false,
      isTimeline: !msg.groupID,
      isSocialLearning: false,
      isPageNewsFeed: !!(ctx.globalOptions || {}).pageID,
      isProfileReviews: false,
      isWorkSharedDraft: false,
      UFI2CommentsProvider_commentsKey: msg.groupID ? "CometGroupDiscussionRootSuccessQuery" : "ProfileCometTimelineRoute",
      hashtag: null,
      canUserManageOffers: false,
      __relay_internal__pv__CometUFIIsRTAEnabledrelayprovider: false,
      __relay_internal__pv__IsWorkUserrelayprovider: false,
      __relay_internal__pv__IsMergQAPollsrelayprovider: false,
      __relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider: false,
      __relay_internal__pv__StoriesRingrelayprovider: false
    };

    handleMention(msg, form);
    await handleUpload(msg, form);
    await handleUrl(msg, form);
    if (msg.videoID) form.input.attachments.push({ video: { id: msg.videoID } });
    if (graphql.registry?.resolve('ComposerStoryCreateMutation').docId === '40854814490784248') {
      Object.assign(form, require('../lib/facebook/ComposerVariables'), {
        checkPhotosToReelsUpsellEligibility: false, referringStoryRenderLocation: null,
      });
    }
    const data = await graphql.request('ComposerStoryCreateMutation', form, { mutation: true });
    const url = data && data.story_create && data.story_create.story && data.story_create.story.url;
    if (typeof url === 'string' && url) return url;
    // The verified video path returns a story ID with publishing_flow FALLBACK
    // and no URL. Decode only the observed actor:post identity, not arbitrary IDs.
    const storyID = data?.story_create?.story_id;
    const decoded = typeof storyID === 'string' ? Buffer.from(storyID, 'base64').toString('utf8') : '';
    const identity = /^S:_I(\d+):(\d+)$/.exec(decoded);
    if (identity) return `https://www.facebook.com/${identity[1]}/posts/${identity[2]}/`;
    throw Object.assign(new Error('Post creation response missing story URL or recognized story identity'), { outcome: 'unknown' });
    });
    // Observe the same promise for callbacks; callback exceptions cannot replay work or invoke it twice.
    if (typeof callback === 'function') rt.then(value => callback(null, value), error => callback(error)).catch(() => {});
    return rt;
  };
};
