"use strict";

const { completion } = require("./LightSpeedRequest");
const { task, identifier } = require("./Task");

// Cookie-web LS schemas are corroborated by mautrix/meta socket tasks.
// Native APK MSYS/Graph operations are separate transports; see MESSAGING_AUDIT.md.
const version = "25095469420099952";
function ids(value, name) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > 100) throw new TypeError(`${name} must contain 1..100 IDs`);
  return [...new Set(list.map(id => identifier(id, name)))];
}

function management(ctx, name, args, callback) {
  const operation = completion(callback);
  let tasks;
  try {
    switch (name) {
      case "muteThread": {
        const thread = identifier(args[0], "threadID");
        const seconds = args[1];
        if (!Number.isSafeInteger(seconds) || seconds < -1) throw new TypeError("muteSeconds must be -1, zero, or a positive integer");
        const expires = seconds > 0 ? Date.now() + seconds * 1000 : seconds;
        if (!Number.isSafeInteger(expires)) throw new TypeError("Mute expiry is outside the supported range");
        tasks = [{ label: "144", queue: thread, payload: { thread_key: thread, mailbox_type: 0, mute_expire_time_ms: expires, sync_group: 1 } }];
        break;
      }
      case "changeAdminStatus": {
        const thread = identifier(args[0], "threadID");
        const contacts = ids(args[1], "adminIDs");
        if (typeof args[2] !== "boolean") throw new TypeError("adminStatus must be a boolean");
        tasks = contacts.map(contact => ({ label: "25", queue: "admin_status", payload: { thread_key: thread, contact_id: contact, is_admin: args[2] ? 1 : 0 } }));
        break;
      }
      case "removeUserFromGroup": {
        const contact = identifier(args[0], "userID");
        const thread = identifier(args[1], "threadID");
        tasks = [{ label: "140", queue: "remove_participant_v2", payload: { thread_id: thread, contact_id: contact } }];
        break;
      }
      case "deleteMessage":
        tasks = ids(args[0], "messageIDs").map(id => ({ label: "155", queue: "155", payload: {
          thread_key: identifier(args[1], "threadID (required for remove-for-me)"), message_id: id,
        } }));
        break;
      default: throw new TypeError("Unknown messaging operation");
    }
  } catch (error) { operation.done(error); return operation.promise; }
  // Validate the whole selection before sending, and stop on the first uncertain result.
  (async () => {
    const results = [];
    for (const spec of tasks) results.push(await task(ctx, { ...spec, type: name, version }));
    return { acknowledged: true, verified: false, results };
  })().then(value => operation.done(null, value), operation.done);
  return operation.promise;
}

module.exports = { management };
