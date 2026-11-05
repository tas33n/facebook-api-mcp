"use strict";
// Public Relay provider values observed with ComposerStoryCreateMutation
// 40854814490784248, verified for a SELF video post on 2026-11-04.
const values = {
  CometFeedShareMedia_shouldPrefetchShareImage: true,
  CometFeedStory_enable_post_permalink_white_space_click: false,
  CometFeedStory_enable_reactor_facepile: false, CometFeedStory_enable_social_bubbles: false,
  CometImmersivePhotoCanUserDisable3DMotion: false, CometUFICommentActionLinksRewriteEnabled: true,
  CometUFICommentAutoTranslationType: "AUTO_TRANSLATE", CometUFICommentAvatarStickerAnimatedImage: false,
  CometUFIReactionsEnableShortName: false, CometUFIShareActionMigration: true, CometUFISingleLineUFI: true,
  CometUFI_dedicated_comment_routable_dialog_gk: true, FBReelsIFUTileContent_reelsIFUPlayOnHover: true,
  FBReelsMediaFooter_comet_enable_reels_ads_gk: true, FBReels_deprecate_short_form_video_context_gk: true,
  FBReels_enable_view_dubbed_audio_type_gk: true, GHLShouldChangeAdIdFieldName: true,
  GHLShouldChangeSponsoredAuctionDistanceFieldName: true, GHLShouldChangeSponsoredDataFieldName: true,
  GHLShouldUseSponsoredAuctionLabelFieldNameV1: true, GHLShouldUseSponsoredAuctionLabelFieldNameV2: false,
  GroupsCometGYSJFeedItemHeight: 206, IsMergQAPolls: false, IsWorkUser: false,
  ShouldEnableBakedInTextStories: false, StoriesShouldEnablePhotosensitiveContentWarning: false,
  StoriesShouldIncludeFbNotes: true, TestPilotShouldIncludeDemoAdUseCase: false,
  WorkCometIsEmployeeGKProvider: false, groups_comet_use_glv: false, relay_provider_comet_ufi_ssr_seo_defer: true,
};
module.exports = Object.freeze(Object.fromEntries(Object.entries(values).map(([key, value]) => [`__relay_internal__pv__${key}relayprovider`, value])));
