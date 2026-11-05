"use strict";

const { Transform } = require("stream");

// Facebook's MQTT 3 endpoint sends PUBACK as 42 02 <message-id>.
// Keep mqtt-packet's strict validation for every other header and packet body.
class FacebookPacketNormalizer extends Transform {
  constructor({ maxPacketSize = 16 * 1024 * 1024, onPacketHeader } = {}) {
    super();
    if (!Number.isSafeInteger(maxPacketSize) || maxPacketSize < 2) {
      throw new RangeError("maxPacketSize must be an integer of at least 2 bytes");
    }
    this.maxPacketSize = maxPacketSize;
    this.onPacketHeader = onPacketHeader;
    this.header = Buffer.alloc(5);
    this.headerLength = 0;
    this.remainingLength = 0;
    this.payloadRemaining = 0;
  }

  _transform(chunk, encoding, callback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.payloadRemaining) {
          const length = Math.min(this.payloadRemaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + length));
          offset += length;
          this.payloadRemaining -= length;
          continue;
        }
        const byte = chunk[offset++];
        this.header[this.headerLength++] = byte;
        if (this.headerLength === 1) continue;
        this.remainingLength += (byte & 0x7f) * (128 ** (this.headerLength - 2));
        if (byte & 0x80) {
          if (this.headerLength === 5) throw new Error("Invalid MQTT remaining length");
          continue;
        }
        if (this.remainingLength + this.headerLength > this.maxPacketSize) {
          throw new Error("MQTT packet exceeds maximum packet size");
        }
        const header = Buffer.from(this.header.subarray(0, this.headerLength));
        const normalized = header[0] === 0x42 && this.remainingLength === 2;
        if (typeof this.onPacketHeader === "function") {
          // Metadata only: never expose message IDs, topics, or payload bytes.
          try {
            this.onPacketHeader({ header: header[0], remainingLength: this.remainingLength, normalized });
          } catch (_) { /* Diagnostics must not interrupt transport. */ }
        }
        if (normalized) header[0] = 0x40;
        this.payloadRemaining = this.remainingLength;
        this.headerLength = 0;
        this.remainingLength = 0;
        this.push(header);
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    callback(this.headerLength || this.payloadRemaining ? new Error("Truncated MQTT packet") : null);
  }
}

module.exports = FacebookPacketNormalizer;
