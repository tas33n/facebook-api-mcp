"use strict";
module.exports = (defaults, api) => (url, options = {}, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  const promise = Promise.resolve().then(() => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["www.facebook.com", "facebook.com"].includes(parsed.hostname) || parsed.username || parsed.password) throw new TypeError("Expected a Facebook post URL");
    const baseState = options.baseState === undefined ? 1 : options.baseState;
    if (![1, 2, 3].includes(baseState)) throw new TypeError("baseState must be 1, 2 or 3");
    return api.createPost({ body: options.text || "", url: parsed.href, baseState, ...(options.groupID ? { groupID: options.groupID } : {}) });
  });
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
