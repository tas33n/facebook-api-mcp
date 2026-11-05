// Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
// getCtx.js - Get context property

module.exports = function (defaultFuncs, api, ctx) {
  return (str) => ctx[str];
};
