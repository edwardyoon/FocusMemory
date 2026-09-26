// Todo store for FocusMemory (CJS — hooks/ scope).
//
// Backs the per-session "task state" (todo list) that the focus-llama engine
// re-injects every turn at the evict-protected last_user position
// (--todo-inject). The model updates the list via the `set_todo` MCP tool;
// the engine GETs it back verbatim and injects it as a separate block before
// the DA instruction, so the working state survives kv-offload eviction (the
// list lives in the durable store, not in the evictable conversation history).
//
// This module is a thin structured layer over the kv-offload dumb store
// (./kvoffload.js): it persists the todo list as a JSON array under the key
// `todo:<session_id>` in the SAME per-session file as the evicted chunks, so
// the engine's existing GET endpoint (/v1/kv-offload/chunk) serves it with no
// protocol change (the C++ side reuses kv_offload_get, key "todo:<session>").
// This module owns the item shape, the 50-item cap, and upsert semantics; the
// store stays dumb (it does not decide what to evict or when — that is the
// engine's job, and the todo is model-maintained state, not engine state).
//
// The stored value is the JSON array ONLY (no label). The engine prepends the
// "[Current task state - not scaffold, this is real]" label at injection time
// so the model does not mistake the block for the DA scaffold.
//
// Everything here is fail-open: any error returns {ok:false, reason} — set_todo
// reports it to the model, and the engine's GET miss skips the injection for
// that turn (never blocks the request).
//
// Gate: reuses the kv-offload gate (FOCUSMEMORY_KVOFFLOAD=on) because the todo
// physically lives in the kv-offload store and is served by its GET route.

const kvoffload = require('./kvoffload.js');

// Injection-bloat guard: at most this many items are stored/injected.
const MAX_ITEMS = 50;
const STATUSES = new Set(['pending', 'in_progress', 'done']);

/**
 * The kv-offload store key for a session's todo list.
 * @param {string} sessionId
 * @returns {string} e.g. "todo:kv-offload-default"
 */
function keyFor(sessionId) {
  return 'todo:' + String(sessionId || '');
}

/**
 * Normalize a single todo item; null when it has no usable text.
 * @param {object} raw
 * @param {string} now - ISO timestamp assigned when the item carries none
 * @returns {{text: string, status: string, updated_at: string}|null}
 */
function normalizeItem(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  let status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : 'pending';
  if (!STATUSES.has(status)) status = 'pending';
  const updated_at = (typeof raw.updated_at === 'string' && raw.updated_at) ? raw.updated_at : now;
  return { text, status, updated_at };
}

/**
 * Read the raw stored array for a session ([] when absent/corrupt).
 * @param {string} sessionId
 * @returns {Array<object>}
 */
function loadItems(sessionId) {
  const got = kvoffload.getChunk(sessionId, keyFor(sessionId));
  if (!got.ok) return [];
  try {
    const parsed = JSON.parse(got.text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Replace the session's todo list with exactly `items` (full-state write).
 * @param {string} sessionId
 * @param {Array<object>} items - [{text, status?, updated_at?}, ...]
 * @returns {{ok: boolean, count?: number, reason?: string}}
 */
function setTodo(sessionId, items) {
  if (!kvoffload.kvOffloadEnabled()) {
    return { ok: false, reason: 'disabled (FOCUSMEMORY_KVOFFLOAD=on required)' };
  }
  if (!Array.isArray(items)) return { ok: false, reason: 'items must be an array' };
  const now = new Date().toISOString();
  const norm = [];
  for (const it of items) {
    const n = normalizeItem(it, now);
    if (n) norm.push(n);
    if (norm.length >= MAX_ITEMS) break;
  }
  const res = kvoffload.putChunk(sessionId, keyFor(sessionId), JSON.stringify(norm), 0);
  if (!res.ok) return res;
  return { ok: true, count: norm.length };
}

/**
 * Upsert `items` into the session's todo list: an item whose text matches an
 * existing one updates that entry (fresh status/updated_at), otherwise it is
 * appended. Items not mentioned are kept (stable order; updates in place).
 * @param {string} sessionId
 * @param {Array<object>} items
 * @returns {{ok: boolean, count?: number, reason?: string}}
 */
function upsertTodo(sessionId, items) {
  if (!kvoffload.kvOffloadEnabled()) {
    return { ok: false, reason: 'disabled (FOCUSMEMORY_KVOFFLOAD=on required)' };
  }
  if (!Array.isArray(items)) return { ok: false, reason: 'items must be an array' };
  const now = new Date().toISOString();
  const byText = new Map();
  for (const it of loadItems(sessionId)) {
    if (it && typeof it.text === 'string') byText.set(it.text, it);
  }
  for (const raw of items) {
    const n = normalizeItem(raw, now);
    if (!n) continue;
    byText.set(n.text, n); // update in place (Map keeps insertion order) or append
    if (byText.size >= MAX_ITEMS) break;
  }
  const merged = Array.from(byText.values()).slice(0, MAX_ITEMS);
  const res = kvoffload.putChunk(sessionId, keyFor(sessionId), JSON.stringify(merged), 0);
  if (!res.ok) return res;
  return { ok: true, count: merged.length };
}

/**
 * Read the session's todo list.
 * @param {string} sessionId
 * @returns {{ok: boolean, items?: Array<object>, reason?: string}}
 */
function getTodo(sessionId) {
  if (!kvoffload.kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const items = loadItems(sessionId);
  return { ok: true, items };
}

module.exports = {
  MAX_ITEMS,
  STATUSES,
  keyFor,
  setTodo,
  upsertTodo,
  getTodo,
};
