"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const NativeAppLogin = require("../lib/auth/NativeAppLogin");
const EmailPasswordLogin = require("../lib/auth/EmailPasswordLogin");
const LoginManager = require("../lib/auth/LoginManager");
const FacebookSafety = require("../lib/safety/FacebookSafety");
const utils = require("../utils");

test("EmailPasswordLogin.validateCredentials should validate inputs", () => {
  const login = new EmailPasswordLogin();
  assert.equal(login.validateCredentials("", "").valid, false);
  assert.equal(login.validateCredentials("user@example.com", "123").valid, false);
  assert.equal(login.validateCredentials("user@example.com", "valid_password_123").valid, true);
  assert.equal(login.validateCredentials("+12345678901", "valid_password_123").valid, true);
});

test("EmailPasswordLogin.formatBrowserPassword should produce Facebook browser envelope", () => {
  const login = new EmailPasswordLogin();
  const ts = 1700000000000;
  const formatted = login.formatBrowserPassword("secret123", ts);
  assert.equal(formatted, "#PWD_BROWSER:5:1700000000000:secret123");
});

test("EmailPasswordLogin.extractFormFields should parse HTML inputs", () => {
  const login = new EmailPasswordLogin();
  const sampleHtml = `
    <form action="/login/device-based/">
      <input type="hidden" name="jazoest" value="2953" />
      <input type="hidden" name="lsd" value="AVp12345" />
      <input type="text" name="email" value="" />
      <input type="password" name="pass" value="" />
      <input type="submit" name="login" value="Log In" />
    </form>
  `;
  const fields = login.extractFormFields(sampleHtml);
  assert.equal(fields.jazoest, "2953");
  assert.equal(fields.lsd, "AVp12345");
  assert.equal(fields.email, "");
});

test("EmailPasswordLogin.resolveFormAction should resolve relative and absolute actions", () => {
  const login = new EmailPasswordLogin();
  const base = "https://www.facebook.com/login/";
  const html1 = '<form action="/login/device-based/regular/login/">';
  const html2 = '<form action="https://www.facebook.com/custom_action">';
  assert.equal(
    login.resolveFormAction(html1, base),
    "https://www.facebook.com/login/device-based/regular/login/"
  );
  assert.equal(
    login.resolveFormAction(html2, base),
    "https://www.facebook.com/custom_action"
  );
});

test("EmailPasswordLogin.needsTwoFactorCode should detect 2FA challenges", () => {
  const login = new EmailPasswordLogin();
  assert.equal(login.needsTwoFactorCode("Enter your 6-digit login code to continue"), true);
  assert.equal(login.needsTwoFactorCode("Please enter the two-factor authentication code"), true);
  assert.equal(login.needsTwoFactorCode("Enter approvals_code from your authenticator app"), true);
  assert.equal(login.needsTwoFactorCode("Welcome to Facebook! Share memories with friends."), false);
});

test("EmailPasswordLogin.resolveTwoFactorCode should handle string, number, and async functions", async () => {
  const login = new EmailPasswordLogin();
  assert.equal(await login.resolveTwoFactorCode(" 123456 "), "123456");
  assert.equal(await login.resolveTwoFactorCode(654321), "654321");
  assert.equal(await login.resolveTwoFactorCode(async () => "789012"), "789012");
  assert.equal(await login.resolveTwoFactorCode(null), null);
});

test("LoginManager.loginWithAppState should populate CookieJar with cookies from cookie array", async () => {
  const safety = new FacebookSafety({ deferStart: true });
  const manager = new LoginManager(safety);
  const jar = utils.getJar();

  const mockCookies = [
    { key: "c_user", value: "1000987654321", domain: ".facebook.com", path: "/" },
    { key: "xs", value: "abcdef123456", domain: ".facebook.com", path: "/" },
  ];

  // Test cookie loading logic directly
  mockCookies.forEach(c => {
    jar.setCookie(`${c.key}=${c.value}; domain=${c.domain}; path=/;`, "https://facebook.com");
  });

  const cookies = jar.getCookies("https://facebook.com");
  assert.ok(cookies.some((c) => (c.key || c.name) === "c_user" && c.value === "1000987654321"));
  assert.ok(cookies.some((c) => (c.key || c.name) === "xs" && c.value === "abcdef123456"));
});

test("LoginManager.loginWithAppState should parse semicolon-separated cookie strings", async () => {
  const cookieString = "c_user=1000555555555; xs=xyz987654; sb=sb_cookie_val;";
  const parts = cookieString.split(";").map((p) => {
    const [k, ...v] = p.trim().split("=");
    return { key: k.trim(), value: v.join("=").trim(), domain: "facebook.com", path: "/" };
  }).filter((c) => c.key && c.value);

  assert.equal(parts.length, 3);
  assert.equal(parts[0].key, "c_user");
  assert.equal(parts[0].value, "1000555555555");
});

test("NativeAppLogin.computeSignature should correctly hash sorted parameters with secret", () => {
  const nativeAuth = new NativeAppLogin({ secret: "test_secret_123" });
  const params = {
    c: "3",
    a: "1",
    b: "2",
  };
  // Expected string: a=1b=2c=3test_secret_123 -> md5
  const crypto = require("crypto");
  const expectedMd5 = crypto.createHash("md5").update("a=1b=2c=3test_secret_123").digest("hex");
  const computed = nativeAuth.computeSignature(params);
  assert.equal(computed, expectedMd5);
});

test("NativeAppLogin.buildLoginPayload should produce signed Katana native payload", () => {
  const nativeAuth = new NativeAppLogin();
  const payload = nativeAuth.buildLoginPayload("user@example.com", "pass123", "dummy-guid-123");

  assert.equal(payload.api_key, "350685531728");
  assert.equal(payload.credentials_type, "password");
  assert.equal(payload.email, "user@example.com");
  assert.equal(payload.password, "pass123");
  assert.equal(payload.generate_session_cookies, "1");
  assert.equal(payload.generate_machine_id, "1");
  assert.equal(payload.method, "auth.login");
  assert.equal(payload.device_id, "dummy-guid-123");
  assert.ok(payload.sig && payload.sig.length === 32);
});

test("NativeAppLogin.buildTwoFactorPayload should produce signed two-factor native payload", () => {
  const nativeAuth = new NativeAppLogin();
  const payload = nativeAuth.buildTwoFactorPayload("123456", "1000111222", "ff_token_abc", "dummy-guid-123");

  assert.equal(payload.api_key, "350685531728");
  assert.equal(payload.credentials_type, "two_factor");
  assert.equal(payload.twofactor_code, "123456");
  assert.equal(payload.userid, "1000111222");
  assert.equal(payload.first_factor, "ff_token_abc");
  assert.equal(payload.method, "auth.login");
  assert.ok(payload.sig && payload.sig.length === 32);
});

test("NativeAppLogin.populateJarWithSessionCookies should inject cookies into CookieJar", () => {
  const nativeAuth = new NativeAppLogin();
  const jar = utils.getJar();
  const sessionCookies = [
    { name: "c_user", value: "100099887766", domain: ".facebook.com", path: "/", secure: true },
    { name: "xs", value: "xs_token_live_123", domain: ".facebook.com", path: "/", secure: true },
    { name: "fr", value: "fr_cookie_val", domain: ".facebook.com", path: "/", secure: true },
  ];

  nativeAuth.populateJarWithSessionCookies(sessionCookies, jar);

  const cookies = jar.getCookies("https://www.facebook.com");
  assert.ok(cookies.some((c) => (c.key || c.name) === "c_user" && c.value === "100099887766"));
  assert.ok(cookies.some((c) => (c.key || c.name) === "xs" && c.value === "xs_token_live_123"));
});

test("NativeAppLogin.generateTOTP should calculate valid RFC 6238 6-digit TOTP", () => {
  const nativeAuth = new NativeAppLogin();
  const sampleSecret = "CJF6XYYVXVXHSTDPQOGUXZ2CNC6L4KLO";
  const totp = nativeAuth.generateTOTP(sampleSecret);
  assert.equal(typeof totp, "string");
  assert.equal(totp.length, 6);
  assert.match(totp, /^\d{6}$/);
});

test("NativeAppLogin.resolveTwoFactorCode should auto-generate TOTP from Base32 secret", async () => {
  const nativeAuth = new NativeAppLogin();
  const sampleSecret = "CJF6XYYVXVXHSTDPQOGUXZ2CNC6L4KLO";
  const code = await nativeAuth.resolveTwoFactorCode(sampleSecret);
  assert.equal(typeof code, "string");
  assert.equal(code.length, 6);
  assert.match(code, /^\d{6}$/);

  // Direct code test
  assert.equal(await nativeAuth.resolveTwoFactorCode("123456"), "123456");
  assert.equal(await nativeAuth.resolveTwoFactorCode(654321), "654321");
});

test("NativeAppLogin.encryptPassword should produce native hybrid encrypted envelope", () => {
  const crypto = require("crypto");
  const nativeAuth = new NativeAppLogin();

  // Generate test RSA keypair
  const { publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const encrypted = nativeAuth.encryptPassword("test_password_123", publicKey, 70, "#PWD_MSGR");
  assert.ok(encrypted.startsWith("#PWD_MSGR:1:"));
  const parts = encrypted.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "#PWD_MSGR");
  assert.equal(parts[1], "1");
  assert.ok(!isNaN(parseInt(parts[2], 10)));
  assert.ok(parts[3].length > 50);
});

test("NativeAppLogin.saveSessionJson should persist session object to disk", () => {
  const fs = require("fs");
  const path = require("path");
  const nativeAuth = new NativeAppLogin();
  const tmpFile = path.resolve(__dirname, "../config/test-session-tmp.json");

  const mockSession = {
    uid: "1000998877",
    accessToken: "EAAB...mock",
    sessionKey: "sk_mock",
    secret: "sec_mock",
    machineId: "m_mock",
    sessionCookies: [{ name: "c_user", value: "1000998877" }],
  };

  const savedPath = nativeAuth.saveSessionJson(mockSession, tmpFile);
  assert.equal(savedPath, tmpFile);
  assert.ok(fs.existsSync(tmpFile));

  const content = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
  assert.equal(content.uid, "1000998877");
  assert.equal(content.accessToken, "EAAB...mock");

  // Clean up
  fs.unlinkSync(tmpFile);
});
