"use strict";

const utils = require("../../utils");
const { identifier } = require("./Task");
const attachmentKeys = ["image_id", "gif_id", "file_id", "video_id", "audio_id"];

function validateMessage(message, mqtt = false) {
  if (message.body != null && typeof message.body !== "string") throw new TypeError("body must be a string");
  if (message.mentions != null) {
    if (!Array.isArray(message.mentions)) throw new TypeError("mentions must be an array");
    for (const mention of message.mentions) {
      if (!mention || typeof mention.tag !== "string" || !mention.tag) throw new TypeError("mention.tag must be non-empty");
      identifier(mention.id, "mention.id");
      if (mention.fromIndex != null && (!Number.isInteger(mention.fromIndex) || mention.fromIndex < 0)) throw new TypeError("mention.fromIndex must be nonnegative");
      if ((message.body || "").indexOf(mention.tag, mention.fromIndex || 0) < 0) throw new TypeError("Mention tag is absent from body");
    }
  }
  if (message.location != null) {
    const { latitude, longitude, live } = message.location;
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new TypeError("Invalid location coordinates");
    if (live) throw new TypeError("Live location sessions are not implemented");
  }
  if (message.attachment != null) {
    const items = Array.isArray(message.attachment) ? message.attachment : [message.attachment];
    if (!items.length) throw new TypeError("attachments must not be empty");
    const streams = items.every(item => utils.isReadableStream(item));
    const staged = !mqtt && items.every(item => Array.isArray(item) && item.length === 2 && attachmentKeys.includes(item[0]) && identifier(item[1], "attachment ID"));
    if (!streams && !staged) throw new TypeError("attachments must be readable streams or supported staged-ID pairs");
  }
  if (message.url != null) {
    const url = new URL(message.url);
    if (!["https:", "http:"].includes(url.protocol)) throw new TypeError("URL attachments require HTTP or HTTPS");
  }
  if (message.sticker != null) identifier(message.sticker, "sticker");
  if (message.emojiSize != null && !message.emoji) throw new TypeError("emojiSize requires emoji");
  if (message.emoji) {
    const sizes = mqtt ? ["small", "medium", "large", 1, 2, 3] : ["small", "medium", "large"];
    if (message.emojiSize != null && !sizes.includes(message.emojiSize)) throw new TypeError("Invalid emojiSize");
    if (message.body) throw new TypeError("emoji and body cannot be combined");
  }
  if (!message.body && !message.attachment && !message.url && !message.sticker && !message.emoji && !message.location) throw new TypeError("Message has no content");
}

module.exports = { validateMessage, attachmentKeys };
