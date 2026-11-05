"use strict";
module.exports = (defaults, api) => (options, callback) => {
  const promise = Promise.resolve().then(() => {
    if (!options || typeof options.videoID !== "string" || !/^\d+$/.test(options.videoID)) throw new TypeError("videoID must identify staged media");
    const baseState = options.baseState === undefined ? 1 : options.baseState;
    if (![1, 2, 3].includes(baseState)) throw new TypeError("baseState must be 1 public, 2 friends or 3 self");
    if (options.description !== undefined && typeof options.description !== "string") throw new TypeError("description must be a string");
    return api.createPost({ videoID: options.videoID, body: options.description || "", baseState });
  }).then(url => ({ videoID: options.videoID, url, status: "accepted", published: null }));
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
