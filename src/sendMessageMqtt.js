"use strict";

/**
 * Facebook API MCP — inherited Nexus-FCA transport; see ATTRIBUTION.md.
 * sendMessageMqtt.js - Send message via native LightSpeed MQTT (/ls_req)
 */

const utils = require("../utils");
const log = require("npmlog");
const bluebird = require("bluebird");
const { request, completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
  function uploadAttachment(attachments, callback) {
    callback = callback || function () {};
    const uploads = [];

    for (let i = 0; i < attachments.length; i++) {
      if (!utils.isReadableStream(attachments[i])) {
        return callback({
          error:
            "Attachment should be a readable stream and not " +
            utils.getType(attachments[i]) +
            ".",
        });
      }

      const form = {
        upload_1024: attachments[i],
        voice_clip: "true",
      };

      uploads.push(
        defaultFuncs
          .postFormData(
            "https://upload.facebook.com/ajax/mercury/upload.php",
            ctx.jar,
            form,
            {}
          )
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then(function (resData) {
            if (resData.error) {
              throw resData;
            }
            return resData.payload.metadata[0];
          })
      );
    }

    bluebird
      .all(uploads)
      .then((resData) => callback(null, resData))
      .catch((err) => {
        log.error("uploadAttachment", err);
        return callback(err);
      });
  }

  const epoch_id = () => Number(utils.generateOfflineThreadingID());

  const emojiSizes = {
    small: 1,
    medium: 2,
    large: 3,
  };

  function handleEmoji(msg, form, callback, cb) {
    if (msg.emojiSize != null && msg.emoji == null) {
      return callback({ error: "emoji property is empty" });
    }
    if (msg.emoji) {
      if (!msg.emojiSize) {
        msg.emojiSize = "small";
      }
      if (
        msg.emojiSize !== "small" &&
        msg.emojiSize !== "medium" &&
        msg.emojiSize !== "large" &&
        (isNaN(msg.emojiSize) || msg.emojiSize < 1 || msg.emojiSize > 3)
      ) {
        return callback({ error: "emojiSize property is invalid" });
      }

      form.payload.tasks[0].payload.send_type = 1;
      form.payload.tasks[0].payload.text = msg.emoji;
      form.payload.tasks[0].payload.hot_emoji_size = !isNaN(msg.emojiSize)
        ? msg.emojiSize
        : emojiSizes[msg.emojiSize];
    }
    cb();
  }

  function handleSticker(msg, form, callback, cb) {
    if (msg.sticker) {
      form.payload.tasks[0].payload.send_type = 2;
      form.payload.tasks[0].payload.sticker_id = msg.sticker;
    }
    cb();
  }

  function handleAttachment(msg, form, callback, cb) {
    if (msg.attachment) {
      form.payload.tasks[0].payload.send_type = 3;
      form.payload.tasks[0].payload.attachment_fbids = [];
      if (form.payload.tasks[0].payload.text === "") {
        form.payload.tasks[0].payload.text = null;
      }
      if (utils.getType(msg.attachment) !== "Array") {
        msg.attachment = [msg.attachment];
      }

      uploadAttachment(msg.attachment, function (err, files) {
        if (err) {
          return callback(err);
        }

        for (const file of files) {
          const id = file.fbid || file.image_id || file.gif_id || file.video_id || file.audio_id || file.file_id;
          if (!id) return callback(new Error("Upload response is missing an attachment ID"));
          form.payload.tasks[0].payload.attachment_fbids.push(String(id));
        }
        cb();
      });
    } else {
      cb();
    }
  }

  function handleMention(msg, form, callback, cb) {
    if (msg.mentions) {
      const arrayIds = [];
      const arrayOffsets = [];
      const arrayLengths = [];
      const mention_types = [];

      for (let i = 0; i < msg.mentions.length; i++) {
        const mention = msg.mentions[i];
        const tag = mention.tag;
        if (typeof tag !== "string") {
          return callback({ error: "Mention tags must be strings." });
        }

        const offset = (msg.body || "").indexOf(tag, mention.fromIndex || 0);
        if (offset < 0) {
          log.warn(
            "handleMention",
            'Mention for "' + tag + '" not found in message string.'
          );
        }

        const id = mention.id || 0;
        arrayIds.push(id);
        arrayOffsets.push(offset >= 0 ? offset : 0);
        arrayLengths.push(tag.length);
        mention_types.push("p");
      }

      form.payload.tasks[0].payload.mention_data = {
        mention_ids: arrayIds.join(","),
        mention_offsets: arrayOffsets.join(","),
        mention_lengths: arrayLengths.join(","),
        mention_types: mention_types.join(","),
      };
    }
    cb();
  }

  function handleLocation(msg, form, callback, cb) {
    if (msg.location) {
      if (msg.location.latitude == null || msg.location.longitude == null) {
        return callback({
          error: "location property needs both latitude and longitude",
        });
      }
      form.payload.tasks[0].payload.send_type = 1;
      form.payload.tasks[0].payload.location_data = {
        coordinates: {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
        },
        is_current_location: !!msg.location.current,
        is_live_location: !!msg.location.live,
      };
    }
    cb();
  }

  function send(form, threadID, otid, callback, replyToMessage) {
    if (replyToMessage) {
      form.payload.tasks[0].payload.reply_metadata = {
        reply_source_id: replyToMessage,
        reply_source_type: 1,
        reply_type: 0,
      };
    }

    const mqttClient = ctx.mqttClient;
    if (!mqttClient || !mqttClient.connected) {
      return callback(new Error("Not connected to MQTT broker"));
    }

    // Stringify each task payload
    form.payload.tasks.forEach((task) => {
      task.payload = JSON.stringify(task.payload);
    });
    form.payload = JSON.stringify(form.payload);

    // Track outbound for latency & ACK metrics
    if (!ctx._pendingOutbound) ctx._pendingOutbound = new Map();
    ctx._pendingOutbound.set(String(otid), Date.now());
    if (ctx.health) ctx.health.trackOutbound(ctx._pendingOutbound.size);

    return request(ctx, form, "send_message_mqtt", (error, data) => {
      ctx._pendingOutbound.delete(String(otid));
      if (ctx.health) ctx.health.trackOutbound(ctx._pendingOutbound.size);
      callback(error, data);
    }, data => ({
      ...data,
      threadID: data?.threadID || String(threadID),
      // An offline ID is not a server message ID. Preserve it separately.
      messageID: data?.messageID || null,
      timestamp: Date.now(),
      otid: String(otid),
      acknowledged: true,
    }));
  }

  return function sendMessageMqtt(msg, threadID, callback, replyToMessage) {
    if (
      !callback &&
      (utils.getType(threadID) === "Function" ||
        utils.getType(threadID) === "AsyncFunction")
    ) {
      const err = { error: "Pass a threadID as a second argument." };
      const operation = completion(threadID);
      operation.done(err);
      return operation.promise;
    }

    if (!replyToMessage && utils.getType(callback) === "String") {
      replyToMessage = callback;
      callback = null;
    }

    const operation = completion(callback);
    callback = operation.done;
    const returnPromise = operation.promise;
    if (!threadID || !["string", "number"].includes(typeof threadID)) {
      callback(new TypeError("threadID must be a non-empty string or number"));
      return returnPromise;
    }
    if (replyToMessage != null && typeof replyToMessage !== "string") {
      callback(new TypeError("replyToMessage must be a string"));
      return returnPromise;
    }
    if (!ctx.mqttClient?.connected) {
      callback(Object.assign(new Error("Not connected to MQTT broker"), { code: "MQTT_NOT_CONNECTED" }));
      return returnPromise;
    }

    const msgType = utils.getType(msg);
    if (msgType !== "String" && msgType !== "Object") {
      const err = {
        error:
          "Message should be of type string or object and not " + msgType + ".",
      };
      callback(err);
      return returnPromise;
    }

    if (msgType === "String") {
      msg = { body: msg };
    } else {
      msg = { ...msg };
    }
    if (msg.url) {
      callback(new TypeError("sendMessageMqtt does not implement URL attachments; use sendMessage"));
      return returnPromise;
    }
    if (msg.mentions && (!Array.isArray(msg.mentions) || msg.mentions.some(m => !m || typeof m.tag !== "string" || !m.id))) {
      callback(new TypeError("mentions must be an array of { id, tag } objects"));
      return returnPromise;
    }
    try {
      require("../lib/mqtt/MessageValidation").validateMessage(msg, true);
      require("../lib/mqtt/Task").identifier(threadID, "threadID");
    } catch (error) { callback(error); return returnPromise; }

    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
    const reqID = ctx.wsReqNumber;
    const taskID1 = ctx.wsTaskNumber;
    ctx.wsTaskNumber += 1;
    const taskID2 = ctx.wsTaskNumber;

    const otid = utils.generateOfflineThreadingID();

    const form = {
      app_id: "2220391788200892",
      payload: {
        tasks: [
          {
            label: "46",
            payload: {
              thread_id: threadID.toString(),
              otid: otid.toString(),
              source: 0,
              send_type: 1,
              sync_group: 1,
              text:
                msg.body != null && msg.body !== undefined
                  ? msg.body.toString()
                  : "",
              initiating_source: 1,
              skip_url_preview_gen: 0,
            },
            queue_name: threadID.toString(),
            task_id: taskID1,
            failure_count: null,
          },
          {
            label: "21",
            payload: {
              thread_id: threadID.toString(),
              last_read_watermark_ts: Date.now(),
              sync_group: 1,
            },
            queue_name: threadID.toString(),
            task_id: taskID2,
            failure_count: null,
          },
        ],
        epoch_id: epoch_id(),
        version_id: "6120284488008082",
        data_trace_id: null,
      },
      request_id: reqID,
      type: 3,
    };

    if (ctx.globalOptions.autoMarkRead === false) form.payload.tasks.splice(1);

    handleEmoji(msg, form, callback, function () {
      handleLocation(msg, form, callback, function () {
        handleMention(msg, form, callback, function () {
          handleSticker(msg, form, callback, function () {
            handleAttachment(msg, form, callback, function () {
              send(form, threadID, otid, callback, replyToMessage);
            });
          });
        });
      });
    });

    return returnPromise;
  };
};
