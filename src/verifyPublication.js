"use strict";
const { withCallback } = require("../lib/facebook/PostReader");
const { verifyPublication } = require("../lib/facebook/PublicationVerifier");

module.exports = (defaults, api) => function verify(target, options = {}, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  return withCallback(Promise.resolve().then(() => verifyPublication(api, target, options)), callback);
};
