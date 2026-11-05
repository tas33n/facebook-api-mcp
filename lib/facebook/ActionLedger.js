"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const queues = new Map();
const TYPES = new Set(["post", "comment", "reply", "reaction", "share"]);
const STATUSES = new Set(["pending", "completed", "unknown", "safe_retry"]);

function ledgerError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function identifier(value, name, required = false) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw ledgerError("INVALID_ACTION", `${name} must be a string or safe integer`);
  value = value.trim();
  if (required && !value) throw ledgerError("INVALID_ACTION", `${name} is required`);
  return value;
}

function text(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw ledgerError("INVALID_ACTION", "text must be a string");
  // Preserve spaces, line endings and Unicode exactly: these can affect the post.
  return value;
}

function field(action, name) {
  const id = `${name}ID`;
  if (action[name] !== undefined && action[id] !== undefined &&
      identifier(action[name], name) !== identifier(action[id], id)) {
    throw ledgerError("INVALID_ACTION", `Conflicting ${name} and ${id}`);
  }
  return action[id] === undefined ? action[name] : action[id];
}

/** Account is the authenticated account; actor may be a page acting on its behalf. */
function normalizeAction(accountID, action) {
  accountID = identifier(accountID, "accountID", true);
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw ledgerError("INVALID_ACTION", "An action object is required");
  }
  const type = identifier(action.type, "type", true).toLowerCase();
  if (!TYPES.has(type)) throw ledgerError("INVALID_ACTION", `Unsupported action type: ${type}`);
  return {
    accountID,
    actor: identifier(field(action, "actor") ?? accountID, "actor", true),
    type,
    target: identifier(field(action, "target"), "target", true),
    text: text(action.text),
    parent: identifier(field(action, "parent"), "parent", type === "reply"),
    reaction: identifier(action.reaction, "reaction", type === "reaction").toUpperCase(),
    destination: identifier(field(action, "destination"), "destination", type === "share"),
  };
}

function actionKey(accountID, action) {
  return createHash("sha256").update(JSON.stringify(normalizeAction(accountID, action))).digest("hex");
}

// Only throw this when the executor can prove NO request/effect was attempted.
class BeforeNetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BeforeNetworkError";
    this.code = "BEFORE_NETWORK";
  }
}

async function serialize(identity, task) {
  const prior = queues.get(identity) || Promise.resolve();
  const current = prior.catch(() => {}).then(task);
  queues.set(identity, current);
  try { return await current; }
  finally { if (queues.get(identity) === current) queues.delete(identity); }
}

/**
 * Without path this is explicitly process-local, non-durable memory storage.
 * With path, the caller must provision its parent directory and retain the file
 * and its history. Never delete a lock without independently verifying its owner
 * has stopped: even old locks are BUSY. A lock spans reservation through outcome.
 * Executors must not recursively run this ledger (or another at the same path).
 */
class ActionLedger {
  constructor({ path: filename, accountID, maxRecords = 10000, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.accountID = identifier(accountID, "accountID", true);
    if (filename !== undefined && (typeof filename !== "string" || !filename.trim())) {
      throw ledgerError("INVALID_LEDGER", "path must be an explicit nonempty file path");
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw ledgerError("INVALID_LEDGER", "maxRecords and maxBytes must be positive safe integers");
    }
    this.path = filename === undefined ? null : path.resolve(filename);
    this.durable = this.path !== null;
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this._records = Object.create(null);
    this._identity = this.path ? (process.platform === "win32" ? this.path.toLowerCase() : this.path) : this;
  }

  key(action) { return actionKey(this.accountID, action); }

  _key(actionOrKey) {
    if (typeof actionOrKey !== "string") return this.key(actionOrKey);
    if (!/^[a-f0-9]{64}$/.test(actionOrKey)) throw ledgerError("INVALID_ACTION", "Invalid ledger key");
    return actionOrKey;
  }

  _view(key, record) {
    if (record && record.action.accountID !== this.accountID) throw ledgerError("LEDGER_ACCOUNT_MISMATCH", "Ledger key belongs to another account");
    return { key, durable: this.durable, status: record?.status || "absent", revision: record?.revision || 0,
      ...(record ? { record: JSON.parse(JSON.stringify(record)) } : {}) };
  }

  /** Snapshot under the same exclusive lock as execution. Missing keys are absent. */
  async inspect(actionOrKey) {
    const key = this._key(actionOrKey);
    return serialize(this._identity, async () => {
      const unlock = await this._lock();
      try { return this._view(key, (await this._load())[key]); }
      finally { await unlock(); }
    });
  }

  status(actionOrKey) { return this.inspect(actionOrKey); }

  /** Resolver MUST be read-only. Only {source:'server', matched:true, result?, coverage?}
   * completes an existing record. Negative/partial evidence never authorizes replay. */
  async reconcile(actionOrKey, readOnlyResolver) {
    if (typeof readOnlyResolver !== "function") throw ledgerError("INVALID_ACTION", "A read-only resolver is required");
    const key = this._key(actionOrKey);
    return serialize(this._identity, async () => {
      const unlock = await this._lock();
      try {
        const records = JSON.parse(JSON.stringify(await this._load()));
        const view = this._view(key, records[key]);
        if (!view.record) return { ...view, reconciled: false };
        const evidence = await readOnlyResolver(view.record.action, view);
        const positive = evidence?.source === "server" && evidence.matched === true;
        const record = records[key];
        if (positive) {
          record.status = "completed";
          record.updatedAt = new Date().toISOString();
          record.reconciliation = JSON.parse(JSON.stringify(evidence));
          if (evidence.result !== undefined) record.result = JSON.parse(JSON.stringify(evidence.result));
        }
        await this._save(records);
        return { ...this._view(key, record), reconciled: positive, evidence };
      } finally { await unlock(); }
    });
  }

  async _lock() {
    if (!this.durable) return async () => {};
    const filename = `${this.path}.lock`;
    let handle;
    try { handle = await fs.open(filename, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw ledgerError("LEDGER_BUSY", "Ledger lock exists; ownership must be resolved before retrying", error);
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(filename);
      throw error;
    }
    await handle.close();
    return () => fs.unlink(filename);
  }

  async _load() {
    if (!this.durable) return this._records;
    let handle;
    try { handle = await fs.open(this.path, "r"); }
    catch (error) {
      if (error.code === "ENOENT") return Object.create(null);
      throw error;
    }
    let data;
    try {
      if ((await handle.stat()).size > this.maxBytes) throw ledgerError("LEDGER_FULL", "Ledger exceeds maxBytes; history was retained");
      data = await handle.readFile("utf8");
    } finally { await handle.close(); }
    let file;
    try { file = JSON.parse(data); }
    catch (error) { throw ledgerError("LEDGER_CORRUPT", "Ledger is not valid JSON", error); }
    if (!file || file.version !== 1 || !file.records || typeof file.records !== "object" || Array.isArray(file.records)) {
      throw ledgerError("LEDGER_CORRUPT", "Invalid ledger format");
    }
    const entries = Object.entries(file.records);
    if (entries.length > this.maxRecords) throw ledgerError("LEDGER_FULL", "Ledger exceeds maxRecords; history was retained");
    for (const [key, record] of entries) {
      let valid = false;
      try {
        valid = /^[a-f0-9]{64}$/.test(key) && record && STATUSES.has(record.status) &&
          typeof record.createdAt === "string" && typeof record.updatedAt === "string" &&
          actionKey(record.action.accountID, record.action) === key &&
          (record.revision === undefined || (Number.isSafeInteger(record.revision) && record.revision >= 0)) &&
          (record.history === undefined || Array.isArray(record.history));
      } catch (_) { /* Invalid entries must fail closed, never disappear. */ }
      if (!valid) throw ledgerError("LEDGER_CORRUPT", `Invalid ledger record: ${key}`);
      // Holding the exclusive lock proves no cooperating executor owns pending.
      if (record.status === "pending") record.status = "unknown";
    }
    return Object.assign(Object.create(null), file.records);
  }

  async _save(records) {
    if (Object.keys(records).length > this.maxRecords) throw ledgerError("LEDGER_FULL", "Ledger maxRecords reached; history was retained");
    const data = JSON.stringify({ version: 1, records });
    if (Buffer.byteLength(data) > this.maxBytes) throw ledgerError("LEDGER_FULL", "Ledger maxBytes reached; history was retained");
    if (!this.durable) { this._records = records; return; }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.path);
      // POSIX needs the directory flushed as well as file contents. Windows
      // does not support opening directories for fsync through Node.
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }

  /** Failures throw with ledgerKey/ledgerStatus; only fulfilled effects return a result. */
  async run(action, executor, { retrySafe = false, expectedRevision, refreshCompleted } = {}) {
    if (typeof executor !== "function") throw ledgerError("INVALID_ACTION", "executor must be a function");
    const normalized = normalizeAction(this.accountID, action);
    const key = actionKey(this.accountID, normalized);
    return serialize(this._identity, async () => {
      const unlock = await this._lock();
      try {
        const records = await this._load();
        const existing = records[key];
        // An uncertain reaction of any desired value blocks all later values.
        const uncertain = normalized.type === "reaction" && Object.entries(records).find(([, record]) =>
          record.action.accountID === this.accountID && record.action.actor === normalized.actor &&
          record.action.type === "reaction" && record.action.target === normalized.target &&
          ["unknown", "pending"].includes(record.status));
        if (uncertain) return { duplicate: true, status: "unknown", key: uncertain[0], revision: uncertain[1].revision || 0 };
        let refresh = false;
        if (existing?.status === "completed" && normalized.type === "reaction" &&
            typeof refreshCompleted === "function" && expectedRevision === (existing.revision || 0)) {
          const evidence = await refreshCompleted(JSON.parse(JSON.stringify(existing)));
          refresh = evidence?.source === "server" && evidence.known === true && evidence.matches === false;
        }
        if (existing && !refresh && !(existing.status === "safe_retry" && retrySafe === true)) {
          return { duplicate: true, status: existing.status, result: existing.result === undefined ? undefined : JSON.parse(JSON.stringify(existing.result)), key };
        }
        const now = new Date().toISOString();
        const record = { action: normalized, status: "pending", createdAt: existing?.createdAt || now, updatedAt: now,
          revision: existing ? (existing.revision || 0) + 1 : 0,
          ...(existing ? { history: [...(existing.history || []), { status: existing.status, revision: existing.revision || 0,
            updatedAt: existing.updatedAt, result: existing.result }] } : {}) };
        // Work on a copy so a rejected reservation cannot modify memory state.
        const next = Object.assign(Object.create(null), records, { [key]: record });
        await this._save(next); // Must finish before calling ANY user/network code.
        let result;
        try { result = await executor(); }
        catch (cause) {
          record.status = cause instanceof BeforeNetworkError ? "safe_retry" : "unknown";
          record.updatedAt = new Date().toISOString();
          try { await this._save(next); }
          catch (error) {
            // Pending on disk is recovered as unknown, never automatically retried.
            record.status = "unknown";
            throw Object.assign(ledgerError("LEDGER_PERSIST_FAILED", "Could not persist action failure; outcome is unknown", error), { ledgerKey: key, ledgerStatus: "unknown" });
          }
          throw Object.assign(ledgerError(cause?.code || "ACTION_FAILED", cause?.message || "Action failed", cause), { ledgerKey: key, ledgerStatus: record.status });
        }
        try {
          // Persist a JSON snapshot; serialization errors after effects are unknown.
          const snapshot = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          record.status = "completed";
          record.updatedAt = new Date().toISOString();
          if (snapshot !== undefined) record.result = snapshot;
          await this._save(next);
          return { duplicate: false, status: "completed", result: snapshot === undefined ? undefined : JSON.parse(JSON.stringify(snapshot)), key };
        } catch (error) {
          record.status = "unknown";
          delete record.result;
          await this._save(next).catch(() => {});
          throw Object.assign(ledgerError("LEDGER_PERSIST_FAILED", "Effect may have completed; result could not be persisted", error), { ledgerKey: key, ledgerStatus: "unknown" });
        }
      } finally { await unlock(); }
    });
  }
}

// Operation-specific helpers use the same canonical identity as ledger.run().
const actionKeys = Object.freeze(Object.fromEntries([...TYPES].map(type => [type,
  (accountID, action) => actionKey(accountID, { ...action, type }),
])));

module.exports = { ActionLedger, BeforeNetworkError, actionKey, actionKeys, normalizeAction };
