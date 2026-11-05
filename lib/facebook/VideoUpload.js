"use strict";

// Experimental cookie-web protocol derived from shipped Facebook modules; not live-media verified.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { finished } = require("node:stream/promises");
const createGraphQLClient = require("./GraphQLClient");
const { parseResponse } = createGraphQLClient;
const { operationError } = require("./OperationRegistry");

const DEFAULT_START = "https://vupload-edge.facebook.com/ajax/video/upload/requests/start/";
const DEFAULT_RECEIVE = "https://vupload-edge.facebook.com/ajax/video/upload/requests/receive/";

function objectOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("options must be an object");
  return options;
}

function identifier(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new TypeError(`${name} must be a decimal ID string`);
  return value;
}

function actor(ctx, targetID) {
  return identifier(targetID ?? ctx.globalOptions?.pageID ?? ctx.i_userID ?? ctx.userID, "targetID");
}

function text(value, name, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function callbackPromise(promise, callback) {
  if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error)).catch(() => {});
  return promise;
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw operationError("INVALID_UPLOAD_ENDPOINT", "Upload endpoint must be an HTTPS Facebook URL"); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".facebook.com") || url.username || url.password || url.port || url.hash) {
    throw operationError("INVALID_UPLOAD_ENDPOINT", "Upload endpoint must be an HTTPS facebook.com subdomain without credentials or a custom port");
  }
  return url.href;
}

function payload(response) {
  const records = parseResponse(response);
  if (records.length !== 1 || !records[0] || typeof records[0] !== "object") throw operationError("INVALID_RESPONSE", "Expected one upload response record");
  const record = records[0];
  for (const item of [record, record.payload]) {
    if (!item) continue;
    if (item.errors != null && !Array.isArray(item.errors)) throw operationError("INVALID_RESPONSE", "Malformed upload errors field");
    if (item.error || item.error_code || item.errors?.length || item.success === false) throw operationError("UPLOAD_REJECTED", "Facebook rejected the video upload request");
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw operationError("INVALID_RESPONSE", "Upload response missing payload");
  return record.payload;
}

function offset(value, size) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0 || value > size) throw operationError("INVALID_UPLOAD_OFFSET", "Upload offset is outside the file bounds");
  return value;
}

function offsets(data, size) {
  const start = offset(data.start_offset, size);
  const end = offset(data.end_offset, size);
  if (end < start || (start !== size && end === start)) throw operationError("INVALID_UPLOAD_OFFSET", "Upload offsets do not make progress");
  return { start, end };
}

async function upload(defaultFuncs, ctx, filePath, options) {
  objectOptions(options);
  if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("filePath must be a filesystem path");
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(extension)) throw new TypeError("Video file must have a file extension");
  const target = actor(ctx, options.targetID);
  const sourceType = text(options.sourceType, "sourceType");
  if (!sourceType.trim()) throw new TypeError("sourceType must be an explicit deployment-supported string");
  const source = options.source;
  if (!(typeof source === "string" && source.trim()) && !(Number.isSafeInteger(source) && source >= 0)) throw new TypeError("source must be an explicit deployment-supported string or integer");
  const graphql = createGraphQLClient(defaultFuncs, ctx);
  const handle = await fs.open(filePath, "r");
  let started = false;
  let videoID;
  let uploadSessionID;
  let bytesUploaded = 0;
  try {
    const original = await handle.stat();
    const size = original.size;
    if (!original.isFile() || !Number.isSafeInteger(size) || size <= 0) throw new TypeError("Video must be a nonempty regular file with a safe integer size");
    const config = await graphql.request("MediaUploadFBDefaultServerConfigurationRetrieverQuery", { source_type: sourceType });
    const network = config?.media_upload_config;
    if (!network || typeof network !== "object" || Array.isArray(network)) throw operationError("INVALID_RESPONSE", "Upload configuration missing media_upload_config");
    const startURL = endpoint(network.network_start?.uri ?? DEFAULT_START);
    const receiveURL = endpoint(network.network_receive?.uri ?? DEFAULT_RECEIVE);
    const common = { composer_session_id: randomUUID(), source, target_id: target, waterfall_id: randomUUID(),
      supports_chunking: true, partition_start_offset: 0, partition_end_offset: size };
    started = true;
    const initial = payload(await defaultFuncs.post(startURL, ctx.jar, {
      ...common, file_size: size, file_extension: extension, supports_file_api: true, creator_product: 2,
    }));
    videoID = identifier(initial.video_id, "response video_id");
    uploadSessionID = identifier(initial.upload_session_id, "response upload_session_id");
    if (initial.skip_upload !== undefined && typeof initial.skip_upload !== "boolean") throw operationError("INVALID_RESPONSE", "Invalid skip_upload flag");
    if (initial.skip_upload === true) return { videoID, uploadSessionID, bytesUploaded, published: false };
    let range = offsets(initial, size);
    if (range.start !== 0) throw operationError("INVALID_UPLOAD_OFFSET", "A new upload must begin at offset zero");
    while (range.start < size) {
      const stat = await handle.stat();
      if (stat.size !== size || stat.mtimeMs !== original.mtimeMs) throw operationError("UPLOAD_FILE_CHANGED", "Video file changed during upload");
      const chunk = handle.createReadStream({ start: range.start, end: range.end - 1, autoClose: false, highWaterMark: 64 * 1024 });
      // FileHandle streams omit path; form-data needs it to emit a filename/file part.
      chunk.path = filePath;
      const completion = finished(chunk).catch(() => {});
      let next;
      try {
        // form-data requires textual scalars, including booleans. The media itself stays a raw bounded stream.
        const form = Object.fromEntries(Object.entries({ ...common, video_id: videoID, start_offset: range.start, end_offset: range.end }).map(([key, value]) => [key, String(value)]));
        form.video_file_chunk = chunk;
        next = payload(await defaultFuncs.postFormData(receiveURL, ctx.jar, form, {}));
        if (chunk.bytesRead !== range.end - range.start) throw operationError("UPLOAD_SIZE_MISMATCH", "Upload transport did not consume the complete chunk");
      } finally {
        // destroy() closes FileHandle streams even with autoClose:false. Keep the
        // descriptor for the next range after a normal EOF; aborts may close it.
        if (!chunk.readableEnded) chunk.destroy();
        await completion;
      }
      const nextRange = offsets(next, size);
      // A partial/repeated acknowledgement has an uncertain outcome; do not silently replay bytes.
      if (nextRange.start !== range.end) throw operationError("INVALID_UPLOAD_OFFSET", "Upload acknowledgement did not advance to the chunk end");
      bytesUploaded += range.end - range.start;
      range = nextRange;
    }
    const finalStat = await handle.stat();
    if (finalStat.size !== size || finalStat.mtimeMs !== original.mtimeMs) throw operationError("UPLOAD_FILE_CHANGED", "Video file changed during upload");
    return { videoID, uploadSessionID, bytesUploaded, published: false };
  } catch (error) {
    if (started && error && typeof error === "object") Object.assign(error, { outcome: "unknown", videoID, uploadSessionID, bytesUploaded });
    throw error;
  } finally {
    await handle.close();
  }
}

module.exports = { upload, objectOptions, identifier, actor, text, boolean, callbackPromise };
