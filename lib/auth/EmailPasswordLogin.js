"use strict";

/**
 * EmailPasswordLogin.js - Modern Facebook Credential & 2FA Authentication
 * Implements browser-based and mobile device-based authentication flows
 * with full Two-Factor Authentication (2FA) checkpoint handling.
 */

const utils = require("../../utils");
const logger = require("../logger");

class EmailPasswordLogin {
  constructor() {
    this.desktopLoginUrl =
      "https://www.facebook.com/login/device-based/regular/login/?login_attempt=1&lwv=110";
    this.mobileLoginUrl = "https://mbasic.facebook.com/login.php";
  }

  /**
   * Format password in Facebook's versioned browser-envelope format
   * @param {string} password - Raw password
   * @param {number} timestamp - Unix timestamp in ms
   */
  formatBrowserPassword(password, timestamp = Date.now()) {
    return `#PWD_BROWSER:5:${timestamp}:${password}`;
  }

  /**
   * Extract input fields from an HTML form response
   * @param {string} html - HTML string
   */
  extractFormFields(html) {
    const fields = {};
    const inputPattern = /<input\b[^>]*>/giu;
    const attributePattern =
      /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;

    for (const input of String(html || "").matchAll(inputPattern)) {
      const attributes = {};
      for (const attribute of input[0].matchAll(attributePattern)) {
        attributes[attribute[1].toLowerCase()] =
          attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      }
      const name = attributes.name;
      if (name && attributes.type !== "submit" && attributes.type !== "button") {
        fields[name] = attributes.value || "";
      }
    }
    return fields;
  }

  /**
   * Resolve form action URL
   * @param {string} html - HTML string
   * @param {string} fallback - Fallback URL
   */
  resolveFormAction(html, fallback) {
    const formPattern =
      /<form\b[^>]*action\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;
    const match = formPattern.exec(String(html || ""));
    const action = match ? match[1] ?? match[2] ?? match[3] : null;
    if (!action) return fallback;
    try {
      return new URL(action, fallback).toString();
    } catch (_) {
      return fallback;
    }
  }

  /**
   * Check if jar has active login cookie (c_user)
   * @param {Object} jar - Cookie jar
   */
  hasLoginCookie(jar) {
    return jar
      .getCookies("https://www.facebook.com")
      .some((c) => (c.key || c.name) === "c_user");
  }

  /**
   * Check if response is a checkpoint / security verification page
   * @param {Object} response - HTTP response
   */
  isCheckpointResponse(response) {
    const body = String((response && response.body) || "").toLowerCase();
    const url = (response?.request?.uri?.href || "").toLowerCase();
    return (
      url.includes("/checkpoint/") ||
      url.includes("/two_step_verification/") ||
      body.includes("checkpoint") ||
      body.includes("/checkpoint/") ||
      body.includes("/two_step_verification/") ||
      this.needsTwoFactorCode(body)
    );
  }

  /**
   * Detect if checkpoint is specifically asking for a 2FA code
   * @param {string} html - HTML string
   */
  needsTwoFactorCode(html) {
    return /(?:security|login)\s+code|two[-_ ]factor|two[-_ ]step|two_step_verification|approvals_code|6[- ]digit code|verification.{0,20}code|authentication app|authenticator|enter.{0,30}code/iu.test(
      String(html || "")
    );
  }

  /**
   * Resolve 2FA code from value, callback, or provider
   * @param {string|Function} value - 2FA code or async provider function
   */
  async resolveTwoFactorCode(value) {
    if (typeof value === "function") {
      const code = await value();
      return this.normalizeTwoFactorCode(code);
    }
    return this.normalizeTwoFactorCode(value);
  }

  normalizeTwoFactorCode(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const code = String(value).trim();
    return code.length > 0 ? code : null;
  }

  /**
   * Submit 2FA code to checkpoint
   */
  async submitTwoFactorCode(jar, response, twoFactorCode, globalOptions) {
    logger("🔑 Two-Factor Authentication checkpoint detected. Resolving code...", "info");
    const code = await this.resolveTwoFactorCode(twoFactorCode);
    if (!code) {
      throw new Error(
        "Facebook credential login requires a 2FA code; please supply 'twoFactorCode' in your login credentials or options."
      );
    }

    const fields = this.extractFormFields(response.body);
    fields.approvals_code = code;
    fields.codes_submitted = fields.codes_submitted || "0";
    fields["submit[Submit Code]"] = "Submit Code";

    const action = this.resolveFormAction(
      response.body,
      "https://www.facebook.com/checkpoint/"
    );

    let res = await utils.post(action, jar, fields, globalOptions);
    await utils.saveCookies(jar)(res);

    if (this.hasLoginCookie(jar)) return res;
    if (!this.isCheckpointResponse(res)) return res;

    // Continue checkpoint (save device / approve login)
    return await this.continueCheckpoint(jar, res, globalOptions);
  }

  /**
   * Continue checkpoint approval (e.g. Save Browser, This Was Me)
   */
  async continueCheckpoint(jar, response, globalOptions) {
    logger("📱 Approving checkpoint device authorization...", "info");
    const action = this.resolveFormAction(
      response.body,
      "https://www.facebook.com/checkpoint/"
    );
    const fields = this.extractFormFields(response.body);
    delete fields.approvals_code;
    delete fields.codes_submitted;
    delete fields["submit[Submit Code]"];
    fields.name_action_selected = "save_device";
    fields["submit[Continue]"] = "Continue";

    let res = await utils.post(action, jar, fields, globalOptions);
    await utils.saveCookies(jar)(res);

    if (this.hasLoginCookie(jar)) return res;
    if (!this.isCheckpointResponse(res)) return res;

    // Second checkpoint screen (e.g. "This Was Me")
    const followup = this.extractFormFields(res.body);
    delete followup.name_action_selected;
    followup["submit[This was me]"] = "This Was Me";
    followup["submit[Continue]"] = "Continue";

    const followupAction = this.resolveFormAction(res.body, action);
    res = await utils.post(followupAction, jar, followup, globalOptions);
    await utils.saveCookies(jar)(res);

    return res;
  }

  /**
   * Authenticate user with email/phone and password
   * @param {string} email - Facebook email or phone number
   * @param {string} password - Facebook password
   * @param {Object} jar - Cookie jar
   * @param {Object} globalOptions - FCA global options
   * @param {string|Function} twoFactorCode - 2FA code or code provider
   * @returns {Promise<Object>} Login result with session cookies
   */
  async login(email, password, jar, globalOptions = {}, twoFactorCode = null) {
    logger("🔐 Attempting secure browser-based credential login...", "info");

    const validation = this.validateCredentials(email, password);
    if (!validation.valid) {
      throw new Error(`Invalid credentials: ${validation.errors.join(", ")}`);
    }

    // Step 1: Request login page to extract tokens and establish cookies
    let loginPageRes;
    try {
      loginPageRes = await utils.get(
        this.desktopLoginUrl,
        jar,
        null,
        globalOptions,
        { noRef: true }
      );
      await utils.saveCookies(jar)(loginPageRes);
    } catch (err) {
      logger(`Desktop login page fetch failed (${err.message}), trying mobile basic fallback...`, "warn");
      loginPageRes = await utils.get(
        this.mobileLoginUrl,
        jar,
        null,
        globalOptions,
        { noRef: true }
      );
      await utils.saveCookies(jar)(loginPageRes);
    }

    // Step 2: Extract form fields and populate credentials
    const fields = this.extractFormFields(loginPageRes.body);
    fields.email = email;
    fields.pass = this.formatBrowserPassword(password);
    fields.login = fields.login || "Log In";

    const postAction = this.resolveFormAction(
      loginPageRes.body,
      this.desktopLoginUrl
    );

    // Step 3: Post credentials
    logger("📨 Submitting credentials to Facebook authentication gateway...", "info");
    let loginRes = await utils.post(postAction, jar, fields, globalOptions);
    await utils.saveCookies(jar)(loginRes);

    // Step 4: Check if already authenticated
    if (this.hasLoginCookie(jar)) {
      logger("✅ Credential login successful! Session cookies obtained.", "info");
      return { success: true, response: loginRes };
    }

    // Step 5: Check for 2FA / Checkpoints
    if (this.isCheckpointResponse(loginRes)) {
      if (this.needsTwoFactorCode(loginRes.body)) {
        loginRes = await this.submitTwoFactorCode(
          jar,
          loginRes,
          twoFactorCode,
          globalOptions
        );
      } else {
        loginRes = await this.continueCheckpoint(jar, loginRes, globalOptions);
      }
    }

    if (!this.hasLoginCookie(jar)) {
      const body = String(loginRes && loginRes.body || "").toLowerCase();
      if (body.includes("incorrect password") || body.includes("wrong password")) {
        throw new Error("Incorrect Facebook password. Please verify your credentials.");
      }
      if (body.includes("checkpoint") || body.includes("two_step_verification")) {
        throw new Error("Facebook security checkpoint requires manual browser verification.");
      }
      throw new Error(
        "Facebook credential login did not produce an active session. Verify credentials or use appState cookies."
      );
    }

    logger("✅ Credential login and checkpoint approval complete!", "info");
    return { success: true, response: loginRes };
  }

  /**
   * Validate email or phone format
   */
  validateCredentials(email, password) {
    const errors = [];
    if (!email || String(email).trim().length === 0) {
      errors.push("Email or phone number is required");
    }
    if (!password || String(password).length < 4) {
      errors.push("Password must be at least 4 characters");
    }
    return {
      valid: errors.length === 0,
      errors: errors,
    };
  }
}

module.exports = EmailPasswordLogin;
