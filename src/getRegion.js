// Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
// getRegion.js - Get server region

module.exports = function (defaultFuncs, api, ctx) {
  return function getRegion() {
    return ctx?.region;
  };
};
