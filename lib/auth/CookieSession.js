"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Cookie } = require("tough-cookie");

// UI viewport/presence state is not authentication. Keep unknown cookies:
// Facebook can introduce new session, device, routing, or checkpoint cookies.
const browserOnly = new Set(["wd", "dpr", "presence"]);
function isSessionDomain(domain) {
  return /(^|\.)(facebook|messenger)\.com$/i.test(String(domain || "").replace(/^\./, ""));
}

function importCookies(jar, cookies, prune = true) {
  if (!Array.isArray(cookies)) throw new TypeError("appState must contain a cookie array");
  for (const source of cookies) {
    const key = source.key || source.name;
    const domain = String(source.domain || "facebook.com").replace(/^\./, "").toLowerCase();
    if (!key || typeof source.value !== "string" || !isSessionDomain(domain)) continue;
    if (prune && browserOnly.has(key)) continue;
    const data = { ...source, key, domain, path: source.path || "/" };
    const expiry = source.expires ?? source.expirationDate;
    if (source.session === true || expiry === -1 || expiry === 0 || expiry == null || expiry === "Infinity") {
      delete data.expires;
    } else {
      const date = typeof expiry === "number"
        ? new Date(expiry < 1e10 ? expiry * 1000 : expiry) : new Date(expiry);
      if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid expiry for cookie ${key}`);
      if (date.getTime() <= Date.now()) continue;
      data.expires = date.toISOString();
    }
    if (source.sameSite === "no_restriction") data.sameSite = "none";
    if (source.sameSite === "unspecified" || source.sameSite == null) delete data.sameSite;
    // Browser exports explicitly say hostOnly. FCA arrays without this field
    // historically represented Domain cookies.
    data.hostOnly = source.hostOnly === true;
    const cookie = Cookie.fromJSON(data);
    if (cookie) {
      // Older tough-cookie exports used lastAccessed as the Max-Age origin.
      // Convert the saved deadline once, never restart its lifetime on import.
      if (cookie.maxAge != null && (source.lastAccessed || source.creation)) {
        const deadline = cookie.expiryTime(new Date(source.lastAccessed || source.creation));
        if (deadline <= Date.now()) continue;
        if (Number.isFinite(deadline)) cookie.expires = new Date(deadline);
        cookie.maxAge = null;
      }
      const created = source.creation ? new Date(source.creation) : new Date();
      jar.setCookie(cookie, `https://${domain}${data.path}`, {
        now: Number.isFinite(created.getTime()) ? created : new Date(),
      });
    }
  }
}

function snapshot(jar, prune = true) {
  const cookies = jar.serializeSync().cookies;
  return cookies.filter(data => {
    const cookie = Cookie.fromJSON(data);
    return cookie && isSessionDomain(cookie.domain) && cookie.expiryTime() > Date.now()
      && (!prune || !browserOnly.has(cookie.key));
  });
}

function pruneJar(jar, prune = true) {
  for (const data of jar.serializeSync().cookies) {
    const cookie = Cookie.fromJSON(data);
    if (!cookie) continue;
    if (!isSessionDomain(cookie.domain) || cookie.expiryTime() <= Date.now() || (prune && browserOnly.has(cookie.key))) {
      jar.store.removeCookie(cookie.domain, cookie.path, cookie.key, () => {});
    }
  }
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${require("node:crypto").randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function readState(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const cookies = Array.isArray(data) ? data : data.sessionCookies || data.appState || data.cookies;
  if (!Array.isArray(cookies)) throw new TypeError("Session file must contain a cookie array");
  return { data, cookies };
}

function persist(file, cookies, userID) {
  let data = fs.existsSync(file) ? readState(file).data : [];
  if (Array.isArray(data)) data = cookies;
  else {
    const field = Array.isArray(data.sessionCookies) ? "sessionCookies" : Array.isArray(data.appState) ? "appState" : "cookies";
    // Do not overwrite another account's envelope.
    if (data.uid && String(data.uid) !== String(userID)) throw new Error("Session file belongs to another account");
    data = { ...data, [field]: cookies, savedAt: new Date().toISOString() };
  }
  atomicWrite(file, data);
}

class CookieSession {
  constructor(ctx, api, utils) {
    this.ctx = ctx;
    this.api = api;
    this.utils = utils;
    this.disposed = false;
    this.lastActivity = Date.now();
    this.lastSaved = null;
    this.pending = null;
    this.refreshing = null;
    this.prune = ctx.globalOptions.pruneCookies !== false;
    this.files = [...new Set([ctx.appStatePath, ctx.globalOptions.sessionSavePath].filter(Boolean).map(f => path.resolve(f)))];
    // Observe the store, including cookies got accepts on intermediate redirects.
    this.originals = new Map();
    for (const name of ["putCookie", "updateCookie", "removeCookie", "removeAllCookies"]) {
      const original = ctx.jar.store[name];
      if (typeof original !== "function") continue;
      this.originals.set(name, original);
      ctx.jar.store[name] = (...args) => {
        const cb = args[args.length - 1];
        if (typeof cb !== "function") return original.apply(ctx.jar.store, args);
        args[args.length - 1] = (error, ...values) => {
          if (!error) this.scheduleSave();
          cb(error, ...values);
        };
        return original.apply(ctx.jar.store, args);
      };
    }
    ctx.cookieSession = this;
    try { this.flush(); } catch (error) {
      this.disposed = true;
      clearTimeout(this.pending);
      for (const [name, original] of this.originals) ctx.jar.store[name] = original;
      throw error;
    }
    const interval = Number(ctx.globalOptions.cookieRefreshIntervalMs ?? 30 * 60 * 1000);
    if (Number.isFinite(interval) && interval > 0) {
      this.intervalMs = Math.max(interval, 60000);
      this.timer = setInterval(() => {
        if (ctx.loggedIn !== false && (ctx.mqttClient?.connected || Date.now() - this.lastActivity < this.intervalMs)) {
          this.refresh().catch(error => this.report(error));
        }
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  report(error) {
    this.lastError = { code: error.code || "COOKIE_SESSION_ERROR", message: error.message };
    require("npmlog").warn("CookieSession", `${this.lastError.code}: ${error.message}`);
  }

  touch() { this.lastActivity = Date.now(); }

  scheduleSave() {
    if (this.disposed || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      try { this.flush(); } catch (error) { this.report(error); }
    }, 250);
    this.pending.unref();
  }

  flush() {
    clearTimeout(this.pending);
    this.pending = null;
    pruneJar(this.ctx.jar, this.prune);
    const cookies = snapshot(this.ctx.jar, this.prune);
    // lastAccessed changes on reads, not cookie rotation.
    const digest = JSON.stringify(cookies.map(({ lastAccessed, ...cookie }) => cookie));
    if (digest === this.lastSaved) return cookies;
    for (const file of this.files) persist(file, cookies, this.ctx.userID);
    this.lastSaved = digest;
    this.lastSavedAt = new Date().toISOString();
    return cookies;
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    if (this.disposed || this.ctx.loggedIn === false) return Promise.reject(new Error("Session is not active"));
    this.refreshing = (async () => {
      try {
        await this.api.refreshFb_dtsg();
        this.flush();
        this.lastRefreshAt = new Date().toISOString();
        return { refreshed: true, savedAt: this.lastSavedAt, refreshedAt: this.lastRefreshAt };
      } catch (error) {
        if (error.code === "SESSION_EXPIRED") this.ctx.loggedIn = false;
        throw error;
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.pending);
    for (const [name, original] of this.originals) this.ctx.jar.store[name] = original;
    this.flush();
  }
}

module.exports = { CookieSession, importCookies, snapshot, pruneJar, atomicWrite, readState, isSessionDomain };
