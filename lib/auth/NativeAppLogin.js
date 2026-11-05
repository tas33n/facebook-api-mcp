"use strict";

/**
 * NativeAppLogin.js
 *
 * Implements native Android authentication protocol extracted and verified
 * directly from Facebook (com.facebook.katana) and Messenger (com.facebook.orca) APKs.
 *
 * Capabilities:
 * - Native hybrid password encryption (#PWD_MSGR / #PWD_FB4A) using AES-256-GCM + RSA-PKCS1
 * - Dynamic public key retrieval via /pwd_key_fetch
 * - Automatic 418 key rotation recovery
 * - Native 2FA challenge handling (credentials_type: two_factor)
 * - Pure JavaScript RFC 6238 TOTP generator
 * - Session cookies & token persistence to JSON file
 *
 * Verified Client Credentials:
 * - Katana App ID: 350685531728 | Secret: 62f8ce9f74b12f84c123cc23437a4a32
 * - Orca App ID:   256002347743983 | Secret: 374e60f8b9bb6b8cbb30f78030438895
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const utils = require("../../utils");
const logger = require("../logger");

const CLIENT_PRESETS = {
  katana: {
    appId: "350685531728",
    secret: "62f8ce9f74b12f84c123cc23437a4a32",
    prefix: "#PWD_FB4A",
    callerClass: "com.facebook.account.login.protocol.Fb4aAuthHandler",
    userAgent:
      "[FBAN/FB4A;FBAV/571.0.0.44.73;FBBV/473224497;FBDM/{density=2.0,width=720,height=1280};FBLC/en_US;FBRV/0;FBCR/Unknown;FBMF/Google;FBBD/google;FBPN/com.facebook.katana;FBDV/Pixel;FBSV/12;FBOP/1;FBCA/armeabi-v7a:armeabi;]",
  },
  orca: {
    appId: "256002347743983",
    secret: "374e60f8b9bb6b8cbb30f78030438895",
    prefix: "#PWD_MSGR",
    callerClass: "AuthOperations$PasswordAuthOperation",
    userAgent:
      "[FBAN/Orca-Android;FBAV/584.1.0.61.98;FBBV/347014937;FBDM/{density=2.0,width=720,height=1280};FBLC/en_US;FBCR/Unknown;FBMF/Google;FBBD/google;FBPN/com.facebook.orca;FBDV/Pixel;FBSV/12;FBOP/1;FBCA/armeabi-v7a:armeabi;]",
  },
};

const AUTH_ENDPOINT = "https://b-api.facebook.com/method/auth.login";
const KEY_FETCH_ENDPOINT = "https://b-graph.facebook.com/pwd_key_fetch";

class NativeAppLogin {
  constructor(options = {}) {
    const clientType = options.client === "orca" ? "orca" : "katana";
    const preset = CLIENT_PRESETS[clientType];

    this.clientType = clientType;
    this.appId = options.appId || preset.appId;
    this.secret = options.secret || preset.secret;
    this.prefix = options.prefix || preset.prefix;
    this.callerClass = options.callerClass || preset.callerClass;
    this.userAgent = options.userAgent || preset.userAgent;
    this.endpoint = options.endpoint || AUTH_ENDPOINT;
    this.keyFetchEndpoint = options.keyFetchEndpoint || KEY_FETCH_ENDPOINT;

    this.cachedKey = null;
    this.cachedKeyExpiry = 0;
  }

  /**
   * RFC 4648 Base32 decoder
   */
  base32Decode(base32) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0;
    let value = 0;
    let index = 0;
    const clean = String(base32).toUpperCase().replace(/=+$/, "");
    const bytes = new Uint8Array(Math.floor((clean.length * 5) / 8));
    for (let i = 0; i < clean.length; i++) {
      const val = alphabet.indexOf(clean[i]);
      if (val === -1) continue;
      value = (value << 5) | val;
      bits += 5;
      if (bits >= 8) {
        bytes[index++] = (value >>> (bits - 8)) & 255;
        bits -= 8;
      }
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, index);
  }

  /**
   * Pure JS RFC 6238 TOTP generator
   */
  generateTOTP(secret, timeStep = 30) {
    const key = this.base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000 / timeStep);
    const timeBuf = Buffer.alloc(8);
    timeBuf.writeBigUInt64BE(BigInt(epoch));
    const hmac = crypto.createHmac("sha1", key).update(timeBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return code.toString().padStart(6, "0");
  }

  /**
   * Compute MD5 signature according to Facebook Android native protocol:
   * sig = MD5(sorted_key_val_pairs + secret)
   */
  computeSignature(params, secret = this.secret) {
    const sortedKeys = Object.keys(params).sort();
    let sigString = "";
    for (const key of sortedKeys) {
      sigString += `${key}=${params[key]}`;
    }
    sigString += secret;
    return crypto.createHash("md5").update(sigString, "utf8").digest("hex");
  }

  /**
   * Compute jazoest telemetry checksum from deviceId
   */
  computeJazoest(deviceId) {
    const sum = Array.from(String(deviceId)).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return `2${sum}`;
  }

  /**
   * Validate email and password inputs
   */
  validateCredentials(email, password) {
    const errors = [];
    if (!email || typeof email !== "string" || !email.trim()) {
      errors.push("Email or phone number is required.");
    }
    if (!password || typeof password !== "string" || !password.trim()) {
      errors.push("Password is required.");
    }
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Fetch password encryption public key from /pwd_key_fetch
   */
  async fetchPasswordEncryptionKey(deviceId, proxyConfig = false) {
    const now = Date.now();
    if (this.cachedKey && now < this.cachedKeyExpiry) {
      return this.cachedKey;
    }

    try {
      const res = await axios.get(this.keyFetchEndpoint, {
        params: {
          device_id: deviceId,
          version: "2",
          flow: "CONTROLLER_INITIALIZATION",
          access_token: `${this.appId}|${this.secret}`,
        },
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
        proxy: proxyConfig,
        validateStatus: () => true,
      });

      if (res.data && res.data.public_key && res.data.key_id !== undefined) {
        const ttl = (res.data.seconds_to_live || 3600) * 1000;
        this.cachedKey = {
          publicKey: res.data.public_key,
          keyId: parseInt(res.data.key_id, 10),
        };
        this.cachedKeyExpiry = now + ttl - 60000;
        return this.cachedKey;
      }
    } catch (err) {
      logger(`⚠️ Failed to fetch public key from pwd_key_fetch: ${err.message}`, "warn");
    }

    return null;
  }

  /**
   * Encrypt password according to Facebook native Android hybrid scheme:
   * AES-256-GCM + RSA-PKCS1
   */
  encryptPassword(password, pubKeyPem, keyId, prefix = this.prefix) {
    const randKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    const encRandKey = crypto.publicEncrypt(
      {
        key: pubKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      randKey
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const cipher = crypto.createCipheriv("aes-256-gcm", randKey, iv);
    cipher.setAAD(Buffer.from(String(currentTime), "utf8"));

    const encryptedPasswd = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const lenBuf = Buffer.alloc(2);
    lenBuf.writeInt16LE(encRandKey.length, 0);

    const buf = Buffer.concat([
      Buffer.from([1, parseInt(keyId, 10)]),
      iv,
      lenBuf,
      encRandKey,
      authTag,
      encryptedPasswd,
    ]);

    const encoded = buf.toString("base64");
    return `${prefix}:1:${currentTime}:${encoded}`;
  }

  /**
   * Format the native Android login request payload
   */
  buildLoginPayload(email, password, deviceId, machineId = null, tryNum = "1") {
    const guid = deviceId || utils.getGUID();
    const params = {
      adid: guid,
      api_key: this.appId,
      cpl: "true",
      credentials_type: "password",
      device_id: guid,
      email: email.trim(),
      family_device_id: guid,
      fb_api_caller_class: this.callerClass,
      fb_api_req_friendly_name: "authenticate",
      format: "json",
      generate_analytics_claim: "1",
      generate_machine_id: "1",
      generate_session_cookies: "1",
      jazoest: this.computeJazoest(guid),
      locale: "en_US",
      client_country_code: "US",
      meta_inf_fbmeta: "NO_FILE",
      method: "auth.login",
      password: password,
      source: "login",
      try_num: String(tryNum),
      waterfall_id: guid,
    };

    if (machineId) {
      params.machine_id = machineId;
    }

    params.sig = this.computeSignature(params);
    return params;
  }

  /**
   * Format the native Android 2FA challenge resolution payload
   */
  buildTwoFactorPayload(twoFactorCode, uid, firstFactor, deviceId, machineId = null) {
    const guid = deviceId || utils.getGUID();
    const params = {
      adid: guid,
      api_key: this.appId,
      cpl: "true",
      credentials_type: "two_factor",
      device_id: guid,
      family_device_id: guid,
      fb_api_caller_class: this.callerClass,
      fb_api_req_friendly_name: "authenticate",
      first_factor: String(firstFactor).trim(),
      format: "json",
      generate_analytics_claim: "1",
      generate_machine_id: "1",
      generate_session_cookies: "1",
      jazoest: this.computeJazoest(guid),
      locale: "en_US",
      client_country_code: "US",
      meta_inf_fbmeta: "NO_FILE",
      method: "auth.login",
      twofactor_code: String(twoFactorCode).trim(),
      userid: String(uid).trim(),
      waterfall_id: guid,
    };

    if (machineId) {
      params.machine_id = machineId;
    }

    params.sig = this.computeSignature(params);
    return params;
  }

  /**
   * Resolve 2FA code from string, number, async provider function, or Base32 TOTP secret
   */
  async resolveTwoFactorCode(provider) {
    if (typeof provider === "function") {
      const code = await provider();
      return String(code).trim();
    }
    if (typeof provider === "string" || typeof provider === "number") {
      const str = String(provider).trim();
      // If it looks like a Base32 secret (16+ alphanumeric characters and not 6 digits), generate TOTP
      if (str.length >= 16 && !/^\d{6,8}$/.test(str)) {
        try {
          return this.generateTOTP(str);
        } catch (_) {}
      }
      return str;
    }
    return null;
  }

  /**
   * Inject Facebook session cookies returned by native auth into CookieJar
   */
  populateJarWithSessionCookies(sessionCookies, jar) {
    if (!Array.isArray(sessionCookies) || !jar) return;

    for (const cookie of sessionCookies) {
      if (!cookie || !cookie.name || !cookie.value) continue;

      const domain = cookie.domain || ".facebook.com";
      const path = cookie.path || "/";
      const isSecure = cookie.secure !== false;

      const pieces = [
        `${cookie.name}=${cookie.value}`,
        `domain=${domain}`,
        `path=${path}`,
      ];

      if (isSecure) pieces.push("secure");
      if (cookie.expires) {
        pieces.push(`expires=${new Date(cookie.expires).toUTCString()}`);
      }

      const cookieStr = pieces.join("; ");
      const host = domain.startsWith(".") ? domain.slice(1) : domain;

      try {
        jar.setCookie(cookieStr, `https://${host}`);
        jar.setCookie(cookieStr, "https://www.facebook.com");
        jar.setCookie(cookieStr, "https://www.messenger.com");
      } catch (_) {}
    }
  }

  /**
   * Save session data to a JSON file
   */
  saveSessionJson(sessionData, targetPath = null) {
    const defaultPath = path.resolve(__dirname, "../../config/session.json");
    const filePath = targetPath || defaultPath;

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const toSave = {
        uid: sessionData.uid,
        accessToken: sessionData.accessToken,
        sessionKey: sessionData.sessionKey,
        secret: sessionData.secret,
        machineId: sessionData.machineId,
        sessionCookies: sessionData.sessionCookies || [],
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), "utf8");
      logger(`💾 Saved native auth session to ${filePath}`, "info");
      return filePath;
    } catch (err) {
      logger(`⚠️ Failed to save session JSON: ${err.message}`, "warn");
      return null;
    }
  }

  /**
   * Execute Native Android App Login
   */
  async login(email, password, jar, options = {}, twoFactorCode = null) {
    const validation = this.validateCredentials(email, password);
    if (!validation.valid) {
      throw new Error(`Invalid credentials: ${validation.errors.join(", ")}`);
    }

    const deviceId = utils.getGUID();
    const proxyConfig = options.proxyConfig || false;
    const sessionSavePath = options.sessionSavePath || null;

    logger("🔐 Resolving native Android encryption keys...", "info");
    const keyInfo = await this.fetchPasswordEncryptionKey(deviceId, proxyConfig);

    let preparedPassword = password;
    if (keyInfo && keyInfo.publicKey && keyInfo.keyId !== undefined) {
      preparedPassword = this.encryptPassword(password, keyInfo.publicKey, keyInfo.keyId);
    }

    const headers = {
      "User-Agent": this.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "X-FB-Connection-Type": "WIFI",
      "X-FB-SIM-HNI": "310260",
      "X-FB-Net-HNI": "310260",
    };

    let tryNum = 1;
    let machineId = null;

    while (tryNum <= 3) {
      logger(`🔐 Sending native Android authentication request (attempt #${tryNum})...`, "info");
      const payload = this.buildLoginPayload(email, preparedPassword, deviceId, machineId, tryNum);

      let response;
      try {
        response = await axios.post(
          this.endpoint,
          new URLSearchParams(payload).toString(),
          {
            headers,
            proxy: proxyConfig,
            validateStatus: () => true,
          }
        );
      } catch (netErr) {
        logger(`❌ Network error contacting native auth endpoint: ${netErr.message}`, "error");
        throw netErr;
      }

      const resData = response.data;

      // 1. Check for success
      if (resData && (resData.session_cookies || resData.access_token)) {
        logger("✅ Native Android authentication successful!", "info");
        this.populateJarWithSessionCookies(resData.session_cookies, jar);

        const sessionResult = {
          success: true,
          uid: resData.uid,
          accessToken: resData.access_token,
          sessionKey: resData.session_key,
          secret: resData.secret,
          machineId: resData.machine_id || machineId,
          sessionCookies: resData.session_cookies || [],
          rawResponse: resData,
        };

        this.saveSessionJson(sessionResult, sessionSavePath);
        return sessionResult;
      }

      // Parse error_data if present
      let parsedErrorData = {};
      if (resData && resData.error_data) {
        try {
          parsedErrorData =
            typeof resData.error_data === "string"
              ? JSON.parse(resData.error_data)
              : resData.error_data;
        } catch (_) {}
      }

      if (parsedErrorData.machine_id) {
        machineId = parsedErrorData.machine_id;
      }

      // 2. Check for 418 Key Rotation
      if (resData && resData.error_code === 418 && parsedErrorData.pwd_enc_key_pkg) {
        logger("🔄 Native key rotation detected (418). Updating public key and retrying...", "warn");
        const newPkg = parsedErrorData.pwd_enc_key_pkg;
        this.cachedKey = {
          publicKey: newPkg.public_key,
          keyId: parseInt(newPkg.key_id, 10),
        };
        preparedPassword = this.encryptPassword(password, this.cachedKey.publicKey, this.cachedKey.keyId);
        tryNum++;
        continue;
      }

      // 3. Check for Two-Factor Challenge
      const isTwoFactor =
        resData &&
        (resData.error_code === 406 ||
          resData.error_code === 405 ||
          !!parsedErrorData.first_factor ||
          !!parsedErrorData.login_first_factor ||
          (resData.error_msg && /two.?factor|checkpoint/i.test(resData.error_msg)));

      if (isTwoFactor) {
        logger("🛡️ Two-factor authentication required by Facebook Android backend", "warn");

        const resolvedCode = await this.resolveTwoFactorCode(twoFactorCode);
        if (!resolvedCode) {
          const challengeError = new Error(
            "Two-factor authentication code required. Please provide twoFactorCode or an async 2FA callback."
          );
          challengeError.name = "TwoFactorRequired";
          challengeError.challenge = {
            uid: parsedErrorData.uid || (resData && resData.uid),
            firstFactor: parsedErrorData.first_factor || parsedErrorData.login_first_factor,
            machineId: machineId || parsedErrorData.machine_id,
          };
          throw challengeError;
        }

        logger("🔑 Submitting native 2FA verification code...", "info");
        const twoFactorPayload = this.buildTwoFactorPayload(
          resolvedCode,
          parsedErrorData.uid || (resData && resData.uid),
          parsedErrorData.first_factor || parsedErrorData.login_first_factor,
          deviceId,
          machineId
        );

        const twoFactorResponse = await axios.post(
          this.endpoint,
          new URLSearchParams(twoFactorPayload).toString(),
          {
            headers,
            proxy: proxyConfig,
            validateStatus: () => true,
          }
        );

        const tfData = twoFactorResponse.data;
        if (tfData && (tfData.session_cookies || tfData.access_token)) {
          logger("✅ Native 2FA authentication successful!", "info");
          this.populateJarWithSessionCookies(tfData.session_cookies, jar);

          const sessionResult = {
            success: true,
            uid: tfData.uid,
            accessToken: tfData.access_token,
            sessionKey: tfData.session_key,
            secret: tfData.secret,
            machineId: tfData.machine_id || machineId,
            sessionCookies: tfData.session_cookies || [],
            rawResponse: tfData,
          };

          this.saveSessionJson(sessionResult, sessionSavePath);
          return sessionResult;
        }

        const failMsg =
          (tfData && (tfData.error_msg || (tfData.error_data && tfData.error_data.error_message))) ||
          "2FA verification failed";
        throw new Error(`Two-factor verification failed: ${failMsg}`);
      }

      // 4. General authentication failure
      const errorMsg =
        (parsedErrorData && parsedErrorData.error_message) ||
        (parsedErrorData && parsedErrorData.short_msg) ||
        (resData && resData.error_msg) ||
        "Native Android login failed. Please verify credentials.";

      const authError = new Error(errorMsg);
      authError.code = resData ? resData.error_code : 500;
      authError.details = parsedErrorData;
      throw authError;
    }
  }
}

module.exports = NativeAppLogin;
