// SKILL.state shared helpers for FocusMemory hooks (CJS — hooks/ scope).
//
// Implements the Σ (structured execution state) design from the SKILL.state
// paper (arXiv:2608.26263): instead of letting native compaction reduce a
// long session to a prose summary, we extract a structured state patch from
// the pre-compaction transcript, merge it into a per-session Σ file, and
// re-inject Σ after compaction so the model conditions on explicit state
// rather than reconstructed history.
//
// Everything here is fail-open by design: a hook must never block or break
// the native compaction flow. Any error → the hook exits silently and qwen
// proceeds with its normal behavior.
//
// Feature gate: FOCUSMEMORY_SKILLSTATE=on (any other value / unset → the
// entry hooks return immediately; auto-recall + Hard Gate are untouched).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, atomicWrite, appendTelemetry } = require('./state.js');

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const SIGMA_DIR = path.join(HOME, '.qwen', 'tmp', 'focus-memory', 'state');
fs.mkdirSync(SIGMA_DIR, { recursive: true });

// .env next to the hooks/ parent (FocusMemory/.env) — same file the MCP
// server loads, so hooks hit the same local services without needing the
// mcpServers env block (that only applies to the MCP process, not command hooks).
const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');
let _dotenvCache = null;

/**
 * Parse FocusMemory/.env into a key/value map (no process.env override).
 * Cached per process; hooks are short-lived so staleness is a non-issue.
 * @returns {Object<string,string>}
 */
function loadDotEnv() {
  if (_dotenvCache) return _dotenvCache;
  _dotenvCache = {};
  try {
    for (const line of fs.readFileSync(DOTENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) _dotenvCache[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return _dotenvCache;
}

/**
 * Resolve a config value: process.env first, then FocusMemory/.env, then fallback.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function env(key, fallback) {
  if (process.env[key]) return process.env[key];
  const v = loadDotEnv()[key];
  return v || fallback;
}

/**
 * Feature gate — true only when FOCUSMEMORY_SKILLSTATE is exactly "on".
 * Resolved via env(): process env first, then FocusMemory/.env — so the
 * gate can be set either in the shell (or qwen settings env) or in .env.
 * Any other value / unset → off (hooks return immediately at the entry).
 * @returns {boolean}
 */
function skillStateEnabled() {
  return env('FOCUSMEMORY_SKILLSTATE', '') === 'on';
}

/**
 * Absolute path of a session's Σ file.
 * @param {string} sessionId
 * @returns {string}
 */
function sigmaFile(sessionId) {
  return path.join(SIGMA_DIR, `${sessionId}.json`);
}

/**
 * Read a session's Σ; missing or corrupt file yields {}.
 * @param {string} sessionId
 * @returns {object}
 */
function loadSigma(sessionId) {
  try {
    if (fs.existsSync(sigmaFile(sessionId))) {
      return JSON.parse(fs.readFileSync(sigmaFile(sessionId), 'utf8'));
    }
  } catch {}
  return {};
}

/**
 * Lock-protected write of a session's Σ file (shares the lock discipline of
 * lib/state.js — a different file, so no lock contention with tool-calls state).
 * @param {string} sessionId
 * @param {object} sigma
 */
function saveSigma(sessionId, sigma) {
  const file = sigmaFile(sessionId);
  withLock(file, () => {
    atomicWrite(file, JSON.stringify(sigma, null, 2));
  });
}

/**
 * Delete SIGMA_DIR files older than maxAgeMs (mtime), optionally restricted
 * to names starting with `prefix`. Best-effort; returns removed count.
 * @param {number} maxAgeMs - 0 means "delete regardless of age" (within prefix)
 * @param {string} [prefix]
 * @returns {number}
 */
function sweepSigma(maxAgeMs, prefix = null) {
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = fs.readdirSync(SIGMA_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (prefix && !name.startsWith(prefix)) continue;
    if (!/\.(json|tmp|lock)$/.test(name)) continue;
    const full = path.join(SIGMA_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// ─── Σ merge (paper: Σ_{t+1} = Σ_t ⊕ Δ, null deletes a key) ─────────────

// Per-key merge semantics. Arrays of "facts" are cumulative (union);
// arrays of "current view" are snapshots (replace); objects merge per key.
const KEY_RULES = {
  task_summary: 'replace',
  current_step: 'replace',
  pending_checks: 'replace',
  files_touched: 'union',
  decisions: 'union',
  tests_status: 'merge',
};
const MAX_LIST_ITEMS = 50; // cap cumulative lists so Σ stays injection-sized

/**
 * Merge a state patch into the current Σ (null values delete keys).
 * @param {object} current
 * @param {object} patch
 * @returns {object} the merged Σ (new object)
 */
function mergeSigma(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete next[key];
      continue;
    }
    const rule = KEY_RULES[key] || (Array.isArray(value) ? 'union' : typeof value === 'object' ? 'merge' : 'replace');
    if (rule === 'union' && Array.isArray(value)) {
      const base = Array.isArray(next[key]) ? next[key] : [];
      const merged = [...base];
      for (const item of value) {
        if (!merged.includes(item)) merged.push(item);
      }
      next[key] = merged.slice(-MAX_LIST_ITEMS);
    } else if (rule === 'merge' && typeof value === 'object') {
      const base = (typeof next[key] === 'object' && next[key] !== null && !Array.isArray(next[key])) ? next[key] : {};
      const merged = { ...base };
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      next[key] = merged;
    } else {
      next[key] = value;
    }
  }
  return next;
}

// ─── Transcript extraction ────────────────────────────────────────────────

/**
 * Truncate a string to maxChars with an ellipsis marker.
 * @param {string} s
 * @param {number} maxChars
 * @returns {string}
 */
function clip(s, maxChars) {
  s = String(s);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s;
}

/**
 * Serialize one transcript entry to compact text (or null to skip it).
 * Skips system snapshots; keeps user text, assistant text + tool calls,
 * and truncated tool results — enough to extract state, not the full history.
 * @param {object} entry - parsed JSONL line
 * @returns {string|null}
 */
function entryToText(entry) {
  if (!entry || !entry.type || !entry.message || !Array.isArray(entry.message.parts)) return null;
  const parts = [];
  for (const part of entry.message.parts) {
    if (entry.type === 'user' && part.text) {
      parts.push(clip(part.text, 4000));
    } else if (entry.type === 'assistant' && part.text) {
      parts.push(clip(part.text, 4000));
    } else if (part.functionCall) {
      let args = '';
      try { args = JSON.stringify(part.functionCall.args || {}); } catch {}
      parts.push(`[call] ${part.functionCall.name} ${clip(args, 500)}`);
    } else if (part.functionResponse) {
      let resp = '';
      try { resp = JSON.stringify(part.functionResponse.response || {}); } catch {}
      parts.push(`[result ${part.functionResponse.name}] ${clip(resp, 800)}`);
    }
  }
  if (parts.length === 0) return null;
  const prefix = entry.type === 'user' ? '[user]' : entry.type === 'assistant' ? '[assistant]' : '[tool]';
  return `${prefix} ${parts.join(' | ')}`;
}

/**
 * Read the tail of a transcript JSONL within a character budget and render
 * it as compact text. Tail-based: the most recent work is what the next
 * post-compaction turn needs; earlier state is already accumulated in Σ.
 * The budget is measured on RENDERED (post-clip) length, so one giant
 * tool_result line costs its clipped size (~800 chars), not its raw size.
 * @param {string} transcriptPath
 * @param {number} [budgetChars=30000]
 * @returns {string} compact text (empty string when nothing usable)
 */
function extractTranscriptTail(transcriptPath, budgetChars = 30000) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n').filter(Boolean);
  const rendered = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0 && used < budgetChars; i--) {
    let text = null;
    try {
      text = entryToText(JSON.parse(lines[i]));
    } catch {}
    if (!text) continue;
    rendered.unshift(text);
    used += text.length + 1;
  }
  return rendered.join('\n');
}

// ─── SUMMARY_LLM extraction ───────────────────────────────────────────────

/**
 * Build the state-patch extraction prompt. Asks for a JSON patch only —
 * explicitly not a prose summary (the point of SKILL.state).
 * @param {object} sigma - current Σ (may be {})
 * @param {string} transcriptText - compact transcript tail
 * @returns {string}
 */
function buildExtractionPrompt(sigma, transcriptText) {
  const current = Object.keys(sigma).length ? JSON.stringify(sigma, null, 2) : '{}';
  return `You are a state extractor for a coding-agent session that is about to be compacted.
Extract ONLY the structured execution state needed to continue the work after compaction.
Do NOT write prose. Do NOT summarize the conversation. Output a single JSON object only.

[Current State (Σ)]:
${current}

[Recent Conversation]:
${transcriptText}

[Output Schema] — a state patch; omit keys that did not change, set a key to null to delete it:
{
  "task_summary": "one line: what this session is working on",
  "files_touched": ["new files created or modified in this conversation segment"],
  "tests_status": {"<check name>": "pass|fail|pending"},
  "current_step": "what the agent is doing right now",
  "pending_checks": ["verifications still outstanding — snapshot, replace the old list"],
  "decisions": ["new decisions made in this segment, one short line each"]
}

[Rules]
- files_touched / decisions / tests_status merge into the current state automatically — list only what is new or changed here.
- pending_checks is a snapshot: list only what is still outstanding (omit the key if nothing is pending).
- task_summary / current_step: give the current best value (omit if unchanged from current state).
- Use only facts present in the conversation. No speculation.
- Output JSON only. No markdown fences, no commentary.`;
}

/**
 * Wrap a raw prompt in the Qwen3 chat template.
 * Both configured targets (MAIN_LLM, SUMMARY_LLM) are Qwen3 family and need
 * the chat framing: a raw prompt on /v1/completions makes Qwen3 emit a
 * single EOS token.
 * @param {string} prompt
 * @returns {string}
 */
function wrapChatTemplate(prompt) {
  return `user\n${prompt}\n
</think>

\n
`;
}

/**
 * Call the extraction LLM (OpenAI-compatible /v1/completions).
 * Model cascade: MAIN_LLM (shared server LLM, already used by
 * taskReceiver/nudge/ingest) first; the local SUMMARY_LLM is only a
 * portability fallback for machines without MAIN_LLM (it is too slow for
 * this workload).
 * The prompt is wrapped in the Qwen3 chat template (see wrapChatTemplate):
 * raw prompts make the Qwen3 family emit a single EOS token.
 * @param {string} prompt
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<string>} raw completion text ('' on any failure)
 */
async function callSummaryLLM(prompt, timeoutMs = 120000) {
  const url = env('MAIN_LLM', env('SUMMARY_LLM_URL', 'http://127.0.0.1:8081/v1/completions'));
  const model = env('MAIN_LLM_MODEL', env('SUMMARY_LLM_MODEL', 'summary-27b'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // max_tokens 2048: Qwen3 thinking tokens share the budget with the
      // JSON output — 1024 risks truncating the patch after a long think.
      body: JSON.stringify({ model, prompt: wrapChatTemplate(prompt), temperature: 0.1, max_tokens: 2048 }),
      signal: controller.signal,
    });
    if (res.status !== 200) {
      console.error(`[skillstate] LLM HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    const t = data.choices && data.choices[0] && data.choices[0].text;
    return typeof t === 'string' ? t : ''; // contract: string, never a Promise/object
  } catch (err) {
    console.error(`[skillstate] LLM error: ${err.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : err.message}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

const SCHEMA_KEYS = ['task_summary', 'files_touched', 'tests_status', 'current_step', 'pending_checks', 'decisions'];

/**
 * Unwrap a {"state_patch": {...}} envelope if present.
 * @param {object} p
 * @returns {object}
 */
function unwrapPatch(p) {
  if (p && typeof p === 'object' && p.state_patch && typeof p.state_patch === 'object') return p.state_patch;
  return p;
}

/**
 * Extract the state-patch JSON object from LLM output. Tolerates markdown
 * fences, thinking preambles, and trailing commentary. Scans all balanced
 * top-level brace candidates (string/escape aware) and prefers ones
 * containing schema keys, trying the LAST candidate first (the final answer
 * usually comes after any mid-text examples).
 * @param {string} text
 * @returns {object|null}
 */
function extractJsonPatch(text) {
  if (typeof text !== 'string' || !text) return null; // defensive: never throw on non-string
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();

  const balanced = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        balanced.push(candidate.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const isObject = (p) => p !== null && typeof p === 'object' && !Array.isArray(p);
  const hasSchemaKey = (p) => isObject(p) && (p.state_patch !== undefined || SCHEMA_KEYS.some((k) => k in p));

  let p = tryParse(candidate);
  if (hasSchemaKey(p)) return unwrapPatch(p);
  // Final answer first: scan candidates right-to-left
  for (let i = balanced.length - 1; i >= 0; i--) {
    p = tryParse(balanced[i]);
    if (hasSchemaKey(p)) return unwrapPatch(p);
  }
  for (let i = balanced.length - 1; i >= 0; i--) {
    p = tryParse(balanced[i]);
    if (isObject(p)) return p;
  }
  return null;
}

// ─── work_memory dual-write ───────────────────────────────────────────────

/**
 * Embed text via the local BGE server.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embedText(text) {
  const url = env('BGE_URL', 'http://127.0.0.1:8080/v1/embeddings');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: text }),
      signal: controller.signal,
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    if (data.data && Array.isArray(data.data) && data.data[0]) return data.data[0].embedding;
    if (data.embedding) return data.embedding;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist a Σ snapshot to the work_memory collection (type "state_checkpoint")
 * so future sessions can auto-recall the last known execution state.
 * Best-effort — any failure is swallowed (the Σ file is the source of truth).
 * @param {object} sigma
 * @param {string} [cwd]
 * @param {string} [trigger]
 * @returns {Promise<boolean>} true when the point was upserted
 */
async function recordCheckpoint(sigma, cwd, trigger) {
  const qdrantUrl = env('QDRANT_URL', 'http://127.0.0.1:6333').replace(/\/$/, '');
  const summary = `SKILL.state checkpoint [${trigger || 'compact'}]: ${sigma.task_summary || '(no task summary)'}`;
  const vector = await embedText(summary);
  if (!vector) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // PUT, not POST: this Qdrant build treats POST /points as a different
    // endpoint ("missing field `ids`"); PUT is the upsert method here.
    const res = await fetch(`${qdrantUrl}/collections/work_memory/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            id: crypto.randomUUID(),
            vector,
            payload: {
              type: 'state_checkpoint',
              project: cwd ? path.basename(cwd) : '',
              summary_text: summary,
              detail: JSON.stringify(sigma),
              related_files: Array.isArray(sigma.files_touched) ? sigma.files_touched.slice(-MAX_LIST_ITEMS) : [],
              status: 'open',
              timestamp: new Date().toISOString(),
            },
          },
        ],
      }),
      signal: controller.signal,
    });
    return res.status === 200 || res.status === 201 || res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Emit a hook JSON output on stdout.
 * @param {object} hookSpecificOutput
 */
function emitHookOutput(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

module.exports = {
  SIGMA_DIR,
  skillStateEnabled,
  env,
  sigmaFile,
  loadSigma,
  saveSigma,
  sweepSigma,
  mergeSigma,
  extractTranscriptTail,
  buildExtractionPrompt,
  wrapChatTemplate,
  callSummaryLLM,
  extractJsonPatch,
  recordCheckpoint,
  emitHookOutput,
  appendTelemetry,
};
