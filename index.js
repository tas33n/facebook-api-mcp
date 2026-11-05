"use strict";

// Facebook API MCP runtime entry point; upstream lineage in ATTRIBUTION.md.
//
// ApiFactory attaches the API modules from src/. CookieSession preserves
// server-issued cookies and checkpoints configured files after rotation.

const log = require("npmlog");
const utils = require("./utils");
const logger = require("./lib/logger");
const FacebookSafety = require("./lib/safety/FacebookSafety");
const LoginManager = require("./lib/auth/LoginManager");
const ApiFactory = require("./lib/factory/ApiFactory");
const { CookieSession, readState } = require("./lib/auth/CookieSession");

const defaultLogRecordSize = 100;
const defaultUserAgent =
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.260 Mobile Safari/537.36";

const BooleanOption = new Set([
  "online",
  "selfListen",
  "listenEvents",
  "updatePresence",
  "forceLogin",
  "autoMarkDelivery",
  "autoMarkRead",
  "listenTyping",
  "autoReconnect",
  "emitReady"
]);

function createSafety() {
  return new FacebookSafety({
    enableSafeHeaders: true,
    enableHumanBehavior: true,
    enableAntiDetection: true,
    enableAutoRefresh: true,
    enableLoginValidation: true,
    enableSafeDelays: true,
    bypassRegionLock: true,
    ultraLowBanMode: true,
    // No timers or network work at import/login time. Deployment owners can
    // explicitly opt in to background maintenance below.
    deferStart: true
  });
}

function defaultOptions(options) {
  return {
    selfListen: false,
    listenEvents: false,
    listenTyping: false,
    updatePresence: false,
    forceLogin: false,
    autoMarkDelivery: true,
    autoMarkRead: true,
    autoReconnect: true,
    logRecordSize: defaultLogRecordSize,
    online: true,
    emitReady: false,
    userAgent: defaultUserAgent,
    ...options
  };
}

function setOptions(globalOptions, options) {
  for (const [key, value] of Object.entries(options)) {
    if (BooleanOption.has(key)) {
      globalOptions[key] = Boolean(value);
      continue;
    }
    if (key === "pauseLog") {
      if (value) log.pause();
      else log.resume();
      continue;
    }
    if (key === "logLevel") {
      log.level = value;
      globalOptions.logLevel = value;
      continue;
    }
    if (key === "logRecordSize") {
      log.maxRecordSize = value;
      globalOptions.logRecordSize = value;
      continue;
    }
    if (key === "pageID") {
      globalOptions.pageID = String(value);
      continue;
    }
    if (key === "userAgent" || key === "proxy") {
      globalOptions[key] = value;
      continue;
    }
    globalOptions[key] = value;
  }
}

function buildAPI(globalOptions, html, jar, safety = createSafety()) {
  const apiFactory = new ApiFactory(safety);
  const result = apiFactory.buildAPI(globalOptions, html, jar);
  if (!result) {
    throw new Error("Failed to build Facebook API MCP from the active session.");
  }

  const originalListen = result.api.listenMqtt;
  if (typeof originalListen === "function" && !result.api._chikaSafetyListen) {
    result.api.listenMqtt = function listenMqttWithSafety(callback) {
      if (typeof callback !== "function") {
        const emitter = originalListen.call(result.api);
        emitter.on("message", () => safety.recordEvent());
        return emitter;
      }
      return originalListen.call(result.api, (error, event) => {
        if (!error && event) safety.recordEvent();
        if (typeof callback === "function") callback(error, event);
      });
    };
    Object.defineProperty(result.api, "_chikaSafetyListen", {
      configurable: false,
      enumerable: false,
      value: true
    });
    result.api.listen = result.api.listenMqtt;
  }

  return result;
}

async function recoverFbDtsg(result, jar, globalOptions, initialHtml) {
  if (result.ctx.fb_dtsg) return;
  const recoveryOptions = {
    ...globalOptions,
    userAgent: defaultUserAgent
  };

  try {
    const mobile = await utils.get(
      "https://mbasic.facebook.com/",
      jar,
      null,
      recoveryOptions
    );
    const mobileHtml = mobile.body;
    const mobileToken =
      mobileHtml.match(/name="fb_dtsg" value="(.*?)"/)?.[1] ??
      mobileHtml.match(/name="dtsg_ag" value="(.*?)"/)?.[1];
    if (mobileToken) {
      applyFbDtsg(result, mobileToken, initialHtml);
      return;
    }
  } catch (error) {
    logger(`fb_dtsg mobile recovery failed: ${error.message}`, "warn");
  }

  try {
    const business = await utils.get(
      "https://business.facebook.com/business_locations",
      jar,
      null,
      recoveryOptions
    );
    const businessHtml = business.body;
    const businessToken =
      businessHtml.match(/name="fb_dtsg" value="(.*?)"/)?.[1] ??
      businessHtml.match(/DTSGInitialData.*?token":"(.*?)"/)?.[1];
    if (businessToken) applyFbDtsg(result, businessToken, initialHtml);
  } catch (error) {
    logger(`fb_dtsg business recovery failed: ${error.message}`, "warn");
  }
}

function applyFbDtsg(result, token, initialHtml) {
  result.ctx.fb_dtsg = token;
  result.ctx.ttstamp = "2" + [...token].map((char) => char.charCodeAt(0)).join("");
  const refreshedDefaults = utils.makeDefaults(
    initialHtml,
    result.ctx.i_userID || result.ctx.userID,
    result.ctx
  );
  // Source API functions close over the original default-functions object.
  // Mutating it preserves those native closures while using the recovered
  // Facebook token for all later requests.
  Object.assign(result.defaultFuncs, refreshedDefaults);
}

function normalizeCredentials(loginData) {
  if (Array.isArray(loginData)) {
    return { appState: loginData };
  }
  if (typeof loginData === "string") {
    const trimmed = loginData.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{") && trimmed.includes(":") && !trimmed.includes("=")) {
      const [email, password] = trimmed.split(":");
      return { email, password };
    }
    return { appState: loginData };
  }
  if (loginData === null || typeof loginData !== "object") return {};
  return {
    appState: loginData.appState ?? loginData.appstate,
    appStatePath: loginData.appStatePath,
    email: loginData.email ?? loginData.username,
    password: loginData.password,
    twoFactorCode: loginData.twoFactorCode ?? loginData.twofactorcode ?? loginData.code ?? loginData["2fa"],
    twoFactorCodeProvider: loginData.twoFactorCodeProvider
  };
}

function login(loginData, options, callback) {
  let loginOptions = options;
  let completion = callback;
  if (typeof loginOptions === "function") {
    completion = loginOptions;
    loginOptions = {};
  }
  const credentials = normalizeCredentials(loginData);
  const resolvedOptions = defaultOptions(loginOptions ?? {});
  if (credentials.appStatePath) resolvedOptions.appStatePath = credentials.appStatePath;
  if (typeof completion === "function") {
    void loginWithNativeApi(credentials, resolvedOptions, completion);
    return undefined;
  }
  return new Promise((resolve, reject) => {
    void loginWithNativeApi(credentials, resolvedOptions, (error, api) => {
      if (error) reject(error);
      else resolve(api);
    });
  });
}

async function loginWithNativeApi(credentials, globalOptions, callback) {
  const safety = createSafety();
  const jar = utils.getJar();
  const loginManager = new LoginManager(safety);
  let cookieSession;

  try {
    if (!credentials.appState && globalOptions.appStatePath && !credentials.email) {
      credentials.appState = readState(globalOptions.appStatePath).cookies;
    }
    const response = await loginManager.login(
      credentials.appState,
      credentials.email,
      credentials.password,
      globalOptions,
      jar,
      credentials.twoFactorCode || credentials.twoFactorCodeProvider
    );
    const result = buildAPI(globalOptions, response.body, jar, safety);
    await recoverFbDtsg(result, jar, globalOptions, response.body);
    cookieSession = new CookieSession(result.ctx, result.api, utils);
    result.api.refreshSession = (callback) => {
      const promise = cookieSession.refresh();
      if (typeof callback === "function") promise.then(value => callback(null, value), callback);
      return promise;
    };
    result.api.saveSession = () => cookieSession.flush();

    const sessionSafety = safety.validateSession(result.ctx);
    if (!sessionSafety.safe) {
      logger(`Session safety warning: ${sessionSafety.reason}`, "warn");
    }

    // Additional legacy safety maintenance remains deployment opt-in.
    if (process.env.FACEBOOK_ENABLE_BACKGROUND_SAFETY === "true") {
      safety.initSafety();
      safety.startMonitoring(result.ctx, result.api);
      try {
        safety.startDynamicSystems();
      } catch {
        // The raw provider remains available even if optional maintenance
        // cannot start on a particular host.
      }
    }

    Object.defineProperty(result.api, "__chikaDispose", {
      configurable: false,
      enumerable: false,
      value: () => {
        for (const listener of result.ctx.facebookListeners || []) {
          listener.stopListeningAsync().catch(() => {});
        }
        try { cookieSession.dispose(); } finally { safety.destroy(); }
      },
      writable: false
    });
    callback(null, result.api);
  } catch (error) {
    try { cookieSession?.dispose(); } catch (_) {}
    try {
      safety.destroy();
    } catch {
      // Preserve the original login error.
    }
    callback(error);
  }
}

// Keep the callable CommonJS surface: require("facebook-api-mcp"),
// and named properties remain available to direct ctx.fca users.
module.exports = login;
module.exports.login = login;
module.exports.buildAPI = buildAPI;
module.exports.setOptions = setOptions;
module.exports.utils = utils;
module.exports.logger = logger;
module.exports.FacebookSafety = FacebookSafety;
module.exports.LoginManager = LoginManager;
module.exports.ApiFactory = ApiFactory;
