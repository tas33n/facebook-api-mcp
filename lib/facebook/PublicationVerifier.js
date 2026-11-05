"use strict";

const { operationError } = require("./OperationRegistry");
const { storyIdentity, timestamp } = require("./PostReader");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string" && value.trim() ? value : null;
const invalid = message => operationError("INVALID_ARGUMENT", message);

function videoIdentity(target) {
  const id = object(target) ? target.videoID : target;
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw invalid("videoID must be a decimal-string ID");
  return id;
}
function playbackURL(value) {
  if (!string(value)) return false;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch (_) { return false; }
}
function normalizeVideoStatus(data, videoID) {
  const video = data?.video;
  if (!object(video) || video.id !== videoID) throw operationError("VIDEO_UNAVAILABLE", "Response contains no matching video");
  const delivery = video.videoDeliveryLegacyFields;
  const playback = { dash: playbackURL(delivery?.dash_manifest_url), sd: playbackURL(delivery?.browser_native_sd_url),
    hd: playbackURL(delivery?.browser_native_hd_url) };
  const playable = Object.values(playback).some(Boolean);
  const creationStoryID = string(video.creation_story?.id), containerStoryID = string(video.container_story?.id);
  const hasStory = Boolean(creationStoryID || containerStoryID);
  const status = string(video.video_status_type);
  return { videoID, ownerID: string(video.owner?.id), status, videoStatusType: status,
    publishTime: timestamp(video.publish_time), creationStoryID, containerStoryID,
    storyID: containerStoryID || creationStoryID, playable, playback, hasStory,
    published: status === "OK" && hasStory && playable,
    coverage: "matching video; publication inferred only from OK status, linked story and playback URL presence; playback not fetched" };
}
function readOptions(options = {}) {
  if (!object(options)) throw invalid("options must be an object");
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw invalid("timeoutMs must be 1..600000");
  const signal = options.signal;
  if (signal != null && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw invalid("signal must be an AbortSignal");
  }
  return { timeoutMs, signal };
}
function verificationOptions(options = {}) {
  const parsed = readOptions(options);
  const maxAttempts = options.maxAttempts ?? 3, intervalMs = options.intervalMs ?? 1000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw invalid("maxAttempts must be 1..20");
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 30000) throw invalid("intervalMs must be 100..30000");
  if (options.expectedText !== undefined && typeof options.expectedText !== "string") throw invalid("expectedText must be a string");
  if (options.expectedMediaType !== undefined && !["text", "photo", "video", "reel", "mixed", "share"].includes(options.expectedMediaType)) throw invalid("expectedMediaType must be text, photo, video, reel, mixed or share");
  if (options.expectedAudience !== undefined && !string(options.expectedAudience)) throw invalid("expectedAudience must be a nonempty string");
  return { ...parsed, maxAttempts, intervalMs, expectedText: options.expectedText,
    expectedMediaType: options.expectedMediaType, expectedAudience: options.expectedAudience };
}

// Bound the caller's wait even when the legacy transport cannot abort an in-flight read.
// Late resolution/rejection is consumed and cannot schedule another attempt.
function boundedRead(read, deadline, signal) {
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn(value);
    };
    const abort = () => finish(reject, operationError("ABORTED", "Publication read cancelled"));
    if (signal?.aborted) { abort(); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { finish(reject, operationError("VERIFICATION_TIMEOUT", "Publication read timed out")); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(reject, operationError("VERIFICATION_TIMEOUT", "Publication read timed out")), remaining);
    Promise.resolve().then(() => {
      if (!settled) return read();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
function wait(intervalMs, deadline, signal) {
  let timer;
  return boundedRead(() => new Promise(resolve => { timer = setTimeout(resolve, intervalMs); }), deadline, signal)
    .finally(() => clearTimeout(timer));
}
function postEvidence(post, options) {
  if (!object(post) || !string(post.storyID)) throw operationError("POST_UNAVAILABLE", "Read returned no story identity");
  const checks = {};
  if (options.expectedText !== undefined) checks.text = typeof post.text === "string" ? post.text === options.expectedText : null;
  if (options.expectedMediaType !== undefined) checks.mediaType = post.kind && post.kind !== "unknown" ? post.kind === options.expectedMediaType : null;
  // Only an explicitly normalized audience is comparable. Never infer it from visibility or a successful read.
  if (options.expectedAudience !== undefined) checks.audience = typeof post.audience === "string" ? post.audience === options.expectedAudience : null;
  const status = Object.values(checks).includes(false) ? "mismatch" : Object.values(checks).includes(null) ? "unavailable" : "verified";
  return { status, evidence: { storyID: post.storyID, postID: post.postID ?? null, authorID: post.authorID ?? null,
    kind: post.kind ?? "unknown", audience: typeof post.audience === "string" ? post.audience : null,
    readable: true, checks } };
}
async function verifyPublication(api, target, options = {}) {
  const parsed = verificationOptions(options);
  if (!object(target)) throw invalid("target must be {videoID}, {storyID}, or {postID, actorID}");
  const isVideo = target.videoID != null;
  if (isVideo && (target.storyID != null || target.postID != null)) throw invalid("target must identify either a video or a post");
  const identity = isVideo ? { videoID: videoIdentity(target) } : storyIdentity(target);
  const deadline = Date.now() + parsed.timeoutMs;
  const result = { verified: false, status: "unavailable", attempts: 0, target: identity, evidence: null, history: [] };
  const stop = error => {
    result.verified = false;
    result.status = error?.code === "ABORTED" ? "cancelled" : error?.code === "VERIFICATION_TIMEOUT" ? "timeout" : "unavailable";
    result.errorCode = typeof error?.code === "string" ? error.code : "READ_FAILED";
    return result;
  };
  for (let attempt = 1; attempt <= parsed.maxAttempts; attempt++) {
    if (parsed.signal?.aborted) return stop({ code: "ABORTED" });
    if (Date.now() >= deadline) return stop({ code: "VERIFICATION_TIMEOUT" });
    result.attempts = attempt;
    delete result.errorCode;
    result.evidence = null;
    try {
      if (isVideo) {
        const video = await boundedRead(() => api.getVideoStatus(identity.videoID,
          { timeoutMs: Math.max(1, deadline - Date.now()), signal: parsed.signal }), deadline, parsed.signal);
        if (!video || video.videoID !== identity.videoID) throw operationError("VIDEO_UNAVAILABLE", "Read returned no matching video");
        result.evidence = { video };
        result.status = video.status == null ? "unavailable" : video.published === true ? "verified" : "pending";
        if (result.status === "verified" && [parsed.expectedText, parsed.expectedMediaType, parsed.expectedAudience].some(value => value !== undefined)) {
          if (!video.storyID) result.status = "unavailable";
          else {
            let story;
            try { story = storyIdentity({ storyID: video.storyID }); }
            catch (_) { throw operationError("POST_UNAVAILABLE", "Video story identity cannot be read by getPost"); }
            const post = await boundedRead(() => api.getPost(story), deadline, parsed.signal);
            const compared = postEvidence(post, parsed);
            result.status = compared.status;
            result.evidence.post = compared.evidence;
          }
        }
      } else {
        const post = await boundedRead(() => api.getPost(identity), deadline, parsed.signal);
        const compared = postEvidence(post, parsed);
        result.status = compared.status;
        result.evidence = compared.evidence;
      }
      result.verified = result.status === "verified";
      result.history.push({ attempt, status: result.status });
      if (result.verified) return result;
    } catch (error) {
      stop(error);
      result.history.push({ attempt, status: result.status, errorCode: result.errorCode });
      if (!["POST_UNAVAILABLE", "VIDEO_UNAVAILABLE", "HTTP_ERROR", "REQUEST_FAILED"].includes(error?.code)) return result;
    }
    if (attempt < parsed.maxAttempts) {
      try { await wait(parsed.intervalMs, deadline, parsed.signal); }
      catch (error) { return stop(error); }
    }
  }
  return result;
}

module.exports = { videoIdentity, normalizeVideoStatus, readOptions, verificationOptions, boundedRead, verifyPublication };
