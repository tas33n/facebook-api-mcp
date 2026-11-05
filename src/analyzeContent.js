"use strict";
const { analyze } = require("../lib/facebook/Content");
module.exports = (defaults, api) => (url, callback) => {
  const promise = Promise.resolve().then(() => api.getContent(url)).then(analyze);
  if (typeof callback === "function") promise.then(value => callback(null, value), callback).catch(() => {});
  return promise;
};
