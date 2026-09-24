// KV offload durable store for FocusMemory (CJS — hooks/ scope).
//
// Backs the focus-llama kv-offload feature (plans/focus-offload.md): when the
// engine's prompt exceeds --kv-offload-threshold, it evicts the oldest DA
// chunk by (1) PUT-ing the chunk's raw text here and (2) removing the chunk's
// KV range. When the model later emits <focus magic_chunks="N"> targeting an
// evicted chunk, the engine GETs the text back and re-prefills it.
//
// This module is a DUMB store. It does not decide what to evict or when —
// that judgment (and the physical KV removal / re-prefill) lives in the
// focus-llama engine, which owns the KV cache. FocusMemory only persists the
// text the engine hands it, keyed by (session_id, chunk_id), and returns it
// verbatim on request.
//
// Storage: one JSON file per session at
//   ~/.qwen/tmp/focus-memory/kv-offload/<session_id>.json
// shaped { session_id, updated_at, chunks: { "<chunk_id>": {text, tokens, ts} } }.
// Per-session JSON (not append-only JSONL) because individual chunks are
// upserted/removed in place; it mirrors skillstate.js's per-session Σ file and
// reuses state.js's withLock/atomicWrite so concurrent engine PUT/GET can
// never observe a torn file (rename is atomic; a lock-free read still sees
// either the old or the new whole file).
//
// Everything here is fail-open by design: a store error must never take down
// the HTTP server or block the engine. put/get return a status object; the
// engine treats a failed GET as fail-open (proceed without the chunk),
// consistent with the DA marker/drift fail-open principle.
//
// Feature gate: FOCUSMEMORY_KVOFFLOAD=on (any other value / unset → the HTTP
// routes return 404 and the store is inert). Read from process.env: the HTTP
// server (index.js) loads FocusMemory/.env via dotenv before any route runs,
// so the gate is resolved there. (Unlike the qwen-spawned hooks, this store is
// only reached over HTTP, so it does not need skillstate.js's manual .env
// parse.)

const fs = require('fs');
const path = require('path');
const { withLock, atomicWrite } = require('./state.js');

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const KV_DIR = path.join(HOME, '.qwen', 'tmp', 'focus-memory', 'kv-offload');
fs.mkdirSync(KV_DIR, { recursive: true });

/**
 * Feature gate — true only when FOCUSMEMORY_KVOFFLOAD is exactly "on".
 * @returns {boolean}
 */
function kvOffloadEnabled() {
  return String(process.env.FOCUSMEMORY_KVOFFLOAD || '').toLowerCase() === 'on';
}

/**
 * Sanitize a session_id for use as a file name. Only [A-Za-z0-9_-] survive;
 * everything else becomes "_". Prevents path traversal if a malformed id ever
 * reaches the store (the engine sends a UUID, so this is defense in depth).
 * @param {string} sessionId
 * @returns {string} a safe file-stem (never empty, never a path separator)
 */
function safeSessionStem(sessionId) {
  const s = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'default';
}

/**
 * Absolute path of a session's offload file.
 * @param {string} sessionId
 * @returns {string}
 */
function sessionFile(sessionId) {
  return path.join(KV_DIR, `${safeSessionStem(sessionId)}.json`);
}

/**
 * Read a session's offload doc; missing or corrupt file yields the empty shape.
 * @param {string} sessionId
 * @returns {{session_id: string, updated_at: string|null, chunks: Object<string, {text: string, tokens?: number, ts: string}>}}
 */
function loadDoc(sessionId) {
  const file = sessionFile(sessionId);
  try {
    if (fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc === 'object' && typeof doc.chunks === 'object' && doc.chunks !== null) {
        return doc;
      }
    }
  } catch {
    // corrupt file — fall through to the empty shape (fail-open)
  }
  return { session_id: String(sessionId || ''), updated_at: null, chunks: {} };
}

/**
 * Lock-protected read-modify-write of a session's offload doc.
 * @param {string} sessionId
 * @param {(doc: object) => object|null} mutate - returns the next doc, or null to skip the write
 * @returns {object|null} the doc as written (null when mutate skipped)
 */
function updateDoc(sessionId, mutate) {
  const file = sessionFile(sessionId);
  return withLock(file, () => {
    const doc = loadDoc(sessionId);
    const next = mutate(doc);
    if (next === null) return null;
    atomicWrite(file, JSON.stringify(next));
    return next;
  });
}

/**
 * Store (upsert) one segment's text for a session.
 * @param {string} sessionId
 * @param {string} key - stable segment key (the engine's content hash)
 * @param {string} text - the segment's raw text (re-prefilled verbatim on GET)
 * @param {number} [tokens] - approximate token count (metadata, optional)
 * @returns {{ok: boolean, bytes?: number, reason?: string}}
 */
function putChunk(sessionId, key, text, tokens) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty text' };
  const k = String(key);
  if (!k) return { ok: false, reason: 'empty key' };
  try {
    const doc = updateDoc(sessionId, (d) => {
      d.session_id = String(sessionId || '');
      d.updated_at = new Date().toISOString();
      d.chunks[k] = {
        text,
        tokens: Number.isFinite(tokens) ? Number(tokens) : undefined,
        ts: new Date().toISOString(),
      };
      return d;
    });
    if (!doc) return { ok: false, reason: 'write skipped' };
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Retrieve one chunk's text for a session.
 * @param {string} sessionId
 * @param {number} chunkId
 * @returns {{ok: boolean, text?: string, tokens?: number, ts?: string, reason?: string}}
 *   ok=false (reason 'not found' | 'disabled') is the engine's fail-open signal.
 */
function getChunk(sessionId, key) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const k = String(key);
  const doc = loadDoc(sessionId);
  const entry = doc.chunks[k];
  if (!entry || typeof entry.text !== 'string') return { ok: false, reason: 'not found' };
  return { ok: true, text: entry.text, tokens: entry.tokens, ts: entry.ts };
}

/**
 * List the chunks a session has offloaded (metadata only, no text).
 * @param {string} sessionId
 * @returns {Array<{chunk_id: number, tokens?: number, ts: string, bytes: number}>}
 */
function listChunks(sessionId) {
  const doc = loadDoc(sessionId);
  return Object.entries(doc.chunks)
    .map(([key, e]) => ({
      key,
      tokens: e.tokens,
      ts: e.ts,
      bytes: Buffer.byteLength(e.text || '', 'utf8'),
    }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * Remove one chunk from a session's offload doc.
 * @param {string} sessionId
 * @param {number} chunkId
 * @returns {{ok: boolean, removed?: boolean, reason?: string}}
 */
function deleteChunk(sessionId, key) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const k = String(key);
  let removed = false;
  try {
    const doc = updateDoc(sessionId, (d) => {
      if (d.chunks[k] === undefined) return null; // nothing to do
      delete d.chunks[k];
      d.updated_at = new Date().toISOString();
      removed = true;
      return d;
    });
    if (!doc && !removed) return { ok: false, reason: 'not found' };
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Delete a session's entire offload doc (cleanup on session end).
 * @param {string} sessionId
 * @returns {{ok: boolean, removedChunks?: number, reason?: string}}
 */
function deleteSession(sessionId) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const file = sessionFile(sessionId);
  const n = loadDoc(sessionId).chunks ? Object.keys(loadDoc(sessionId).chunks).length : 0;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true, removedChunks: n };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Sweep offload files older than maxAgeMs (mtime). Optional GC hook (the
 * existing garbageCollect.js can call this later); not wired to a route in v1.
 * @param {number} maxAgeMs - 0 means "delete regardless of age"
 * @returns {number} number of files removed
 */
function sweepKv(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = fs.readdirSync(KV_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(KV_DIR, name);
    try {
      const st = fs.statSync(full);
      if (maxAgeMs === 0 || st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}

module.exports = {
  KV_DIR,
  kvOffloadEnabled,
  putChunk,
  getChunk,
  listChunks,
  deleteChunk,
  deleteSession,
  sweepKv,
};
