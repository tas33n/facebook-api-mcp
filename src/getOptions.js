// Facebook API MCP — inherited Nexus-FCA adapter; see ATTRIBUTION.md.
// getOptions.js - Get global options

module.exports = function (defaultFuncs, api, ctx) {
  return (str) => ctx.globalOptions[str];
};
