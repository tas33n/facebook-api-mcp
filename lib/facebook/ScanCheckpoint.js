"use strict";

const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { ActionLedger } = require("./ActionLedger");
const queues = new Map();
const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => JSON.parse(JSON.stringify(value));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/** One checkpoint file per scan job. Uses the ledger's exclusive lock and fsynced
 * atomic replacement. Locks are never stolen, including after owner crashes.
 * ack commits a WHOLE page; unacknowledged pages are delivered at least once.
 */
class ScanCheckpoint extends ActionLedger {
  constructor({ path, accountID, fingerprint, initialCursor = null, sessionID = null, maxBytes = 8 * 1024 * 1024 } = {}) {
    super({ path, accountID, maxBytes });
    if (!this.durable) throw fail("INVALID_CHECKPOINT", "A durable checkpoint path is required");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw fail("INVALID_CHECKPOINT", "A SHA-256 fingerprint is required");
    this.fingerprint = fingerprint;
    this.initialCursor = initialCursor;
    this.initialSessionID = sessionID;
  }

  static fingerprint(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

  _initial() {
    return { kind: "scan-checkpoint", accountID: this.accountID, fingerprint: this.fingerprint,
      generation: randomUUID(), cursor: this.initialCursor, sessionID: this.initialSessionID,
      pagesFetched: 0, pagesAcknowledged: 0, exhausted: false, seenCursors: [], pending: null };
  }

  async _readState() {
    let handle;
    try { handle = await fs.open(this.path, "r"); }
    catch (error) { if (error.code === "ENOENT") return this._initial(); throw error; }
    let data;
    try {
      if ((await handle.stat()).size > this.maxBytes) throw fail("CHECKPOINT_FULL", "Checkpoint exceeds maxBytes");
      data = await handle.readFile("utf8");
    } finally { await handle.close(); }
    let state;
    try {
      const file = JSON.parse(data);
      if (file.version !== 1) throw new Error("version");
      state = file.records?.checkpoint;
      if (state?.kind !== "scan-checkpoint" || typeof state.generation !== "string" ||
          !Number.isSafeInteger(state.pagesFetched) || state.pagesFetched < 0 ||
          !Number.isSafeInteger(state.pagesAcknowledged) || state.pagesAcknowledged < 0 ||
          state.pagesFetched !== state.pagesAcknowledged + (state.pending ? 1 : 0) ||
          typeof state.exhausted !== "boolean" || !Array.isArray(state.seenCursors) ||
          state.seenCursors.some(cursor => typeof cursor !== "string" || !cursor) ||
          !(state.cursor === null || typeof state.cursor === "string") ||
          !(state.sessionID === null || typeof state.sessionID === "string") ||
          (state.pending && (typeof state.pending.token !== "string" || !Array.isArray(state.pending.items) ||
            state.pending.items.length > 100 || typeof state.pending.pageInfo?.hasNextPage !== "boolean" ||
            !(state.pending.pageInfo.endCursor === null || typeof state.pending.pageInfo.endCursor === "string") ||
            (state.pending.pageInfo.hasNextPage && !state.pending.pageInfo.endCursor)))) throw new Error("shape");
    } catch (error) { throw fail("CHECKPOINT_CORRUPT", "Invalid scan checkpoint; retained for inspection"); }
    if (state.accountID !== this.accountID) throw fail("CHECKPOINT_ACCOUNT_MISMATCH", "Checkpoint belongs to another account");
    if (state.fingerprint !== this.fingerprint) throw fail("CHECKPOINT_MISMATCH", "Scan source, target or options differ from the checkpoint");
    return state;
  }

  async _transaction(task) {
    const prior = queues.get(this._identity) || Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      const unlock = await this._lock();
      try { return await task(await this._readState()); }
      finally { await unlock(); }
    });
    queues.set(this._identity, current);
    try { return await current; }
    finally { if (queues.get(this._identity) === current) queues.delete(this._identity); }
  }

  _write(state) { return this._save({ checkpoint: state }); }

  status() { return this._transaction(state => copy(state)); }

  /** Clear only this matching job; stale ack tokens cannot affect a new generation. */
  clear() { return this._transaction(async () => { const state = this._initial(); await this._write(state); return copy(state); }); }

  async next(readPage, { maxPages, signal } = {}) {
    if (typeof readPage !== "function" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
      throw fail("INVALID_CHECKPOINT", "readPage and maxPages (1..1000) are required");
    }
    const canceled = () => { if (signal?.aborted) throw fail("ABORT_ERR", "Scan canceled; pending data retained"); };
    return this._transaction(async state => {
      canceled();
      if (state.pending) return { done: false, value: copy(state.pending) };
      if (state.exhausted || state.pagesFetched >= maxPages) return { done: true, value: undefined };
      // Store the initial search session before issuing a read, including failed reads.
      await this._write(state);
      const page = await readPage({ cursor: state.cursor, sessionID: state.sessionID, signal });
      const info = page?.pageInfo;
      if (!Array.isArray(page?.items) || page.items.length > 100 || typeof info?.hasNextPage !== "boolean" ||
          !(info.endCursor === null || typeof info.endCursor === "string") ||
          (info.hasNextPage && (!info.endCursor || info.endCursor === state.cursor || state.seenCursors.includes(info.endCursor)))) {
        throw fail("SCAN_PAGE_INVALID", "Page items or pagination are invalid/repeated; cursor was retained");
      }
      if (page.sessionID != null && page.sessionID !== state.sessionID) throw fail("SCAN_SESSION_MISMATCH", "Server changed the search session");
      state.pagesFetched++;
      state.pending = copy({ ...page, token: `${state.generation}:${state.pagesFetched}:${randomUUID()}`,
        pageNumber: state.pagesFetched, cursor: state.cursor, sessionID: state.sessionID });
      // Do not advance the committed cursor until the consumer acknowledges.
      await this._write(state);
      canceled();
      return { done: false, value: copy(state.pending) };
    });
  }

  ack(token) {
    return this._transaction(async state => {
      if (typeof token !== "string" || !token || state.pending?.token !== token) {
        if (!state.pending && typeof token === "string" && token === state.lastAcknowledgedToken) return copy(state);
        throw fail("CHECKPOINT_ACK_MISMATCH", "Acknowledge the current pending page token");
      }
      state.cursor = state.pending.pageInfo.endCursor;
      if (state.cursor) state.seenCursors.push(state.cursor);
      state.exhausted = state.pending.pageInfo.hasNextPage === false;
      state.pagesAcknowledged++;
      state.lastAcknowledgedToken = token;
      state.pending = null;
      await this._write(state);
      return copy(state);
    });
  }
}

module.exports = { ScanCheckpoint };
