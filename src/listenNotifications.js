"use strict";
const { listen } = require("../lib/facebook/Notifications");
module.exports = (defaults, api, ctx) => (options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  const listener = listen(input => api.getNotifications(input), options, callback);
  if (!ctx.facebookListeners) ctx.facebookListeners = new Set();
  ctx.facebookListeners.add(listener);
  const stop = listener.stopListeningAsync;
  listener.stopListeningAsync = async () => { ctx.facebookListeners.delete(listener); await stop(); };
  listener.stopListening = cb => {
    const promise = listener.stopListeningAsync();
    if (typeof cb === "function") promise.then(() => cb(null), cb).catch(() => {});
    return promise;
  };
  return listener;
};
