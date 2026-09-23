#!/usr/bin/env node
// Stop hook — turn-end guard against "session stops after a bad summary".
//
// Failure mode guarded (plans/20260923-compaction-stop-investigation.md):
// mid-session, a turn whose user prompt was "keep working" ends with a
// model-written "session summary" that claims there is NO active task, and
// that summary becomes the turn's final output (end_turn). With no
// verification or re-entry mechanism, the session parks itself in a
// "waiting for instructions" state while the real work anchor (Σ state /
// in-progress todos) still exists on disk.
//
// The guard fires only when ALL THREE conditions hold (conservative by
// design — a legitimate "summarize the session" request must pass through):
//   A. summary shape   — the turn result carries a session-summary title
//                        marker (e.g. "# 세션 요약", "state snapshot").
//   B. no-task claim   — the summary asserts there is no active task /
//                        the session is waiting for instructions.
//   C. active anchor   — Σ has task_summary / current_step / pending_checks,
//                        OR today's todos/YYYY-MM-DD.md has [~] / [!] items.
//
// On fire: emit decision "block" with a continuation reason that (1) declares
// the just-written summary discarded, (2) re-injects the work anchor, (3)
// instructs the model to resume the in-flight work instead of re-summarizing.
// qwen-code feeds that reason back as the next turn's prompt (verified in
// 0.24.0: isBlockingDecision() → getStopHookContinuationReason() →
// sendMessageStream).
//
// Loop guard: stop_hook_active is hard-coded true on the messageBus Stop
// path (unusable), so the hook self-limits via Σ fields:
//   - identical message hash as the last blocked one → skip (true loop),
//   - at most MAX_BLOCKS within a STREAK_WINDOW → skip,
//   - the streak window resets after the quiet period.
// qwen-code's own stopHookBlockingCap (default 8) remains the outer safety
// net; self-limiting keeps this hook from starving that shared budget.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, fail-open).
// Fail-open: any error → silent exit 0; the session is unaffected.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ss = require('./lib/skillstate.js');

const MAX_BLOCKS = 3;
const STREAK_WINDOW_MS = 30 * 60 * 1000;
const MAX_REASON_CHARS = 2500;

// A. session-summary shape markers (title / structure).
const SUMMARY_SHAPE = [
  /#\s*세션\s*요약/,
  /세션\s*요약/,
  /session\s+summary/i,
  /state\s+snapshot/i,
  /<state_snapshot>/,
  /##\s*현재\s*상태/,
  /##\s*다음\s*단계/,
];

// B. "no active task" claims.
const NO_TASK_CLAIM = [
  /작업\s*요청\s*아직\s*없음/,
  /작업\s*지시\s*대기/,
  /작업(이|가)?\s*없(음|는)/,
  /요청(이|가)?\s*없(음|는)/,
  /대기\s*중/,
  /no\s+active\s+task/i,
  /no\s+task\s+(to|awaiting)/i,
  /waiting\s+for\s+(your\s+)?(instructions|input|next)/i,
  /nothing\s+(to\s+do|pending)/i,
];

/**
 * Short stable hash of a message (loop-detection key).
 * @param {string} s
 * @returns {string} 12-hex-char sha256 prefix
 */
function hashMsg(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/**
 * First-match index of any pattern in s, or -1.
 * @param {string} s
 * @param {RegExp[]} patterns
 * @returns {number}
 */
function firstMatch(s, patterns) {
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(s)) return i;
  }
  return -1;
}

/**
 * In-progress items from today's todos file ([~] in-progress, [!] partial/
 * interrupted headers). Empty array when the file is absent or clean.
 * @param {string} cwd
 * @returns {string[]}
 */
function inProgressTodos(cwd) {
  if (!cwd) return [];
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(cwd, 'todos', `${ymd}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split('\n')) {
    if (/^##\s*\[(~|!)\]\s*(.+)$/.test(line)) {
      items.push(line.replace(/^##\s*\[(~|!)\]\s*/, '').trim());
    }
  }
  return items.slice(0, 5);
}

/**
 * Build the continuation reason (re-injected as the next turn's prompt).
 * Frames the bad summary as discarded DATA, not an instruction — the direct
// counter to the summarization role-misattribution (investigation §3.1).
 * @param {object} sigma
 * @param {string[]} todos
 * @returns {string}
 */
function buildReason(sigma, todos) {
  const parts = [
    '[FocusMemory turn-guard] The turn you just ended produced a "session summary" that claims there is no active task. The work anchor below shows ongoing work, so that summary is INCORRECT. Treat it as discarded — do not extend, repeat, or build on it, and do not write another summary.',
    '',
  ];
  const anchor = ss.renderAnchor(sigma);
  if (anchor) {
    parts.push('Active work anchor (execution state Σ):', `  ${anchor}`, '');
  }
  if (todos.length) {
    parts.push('In-progress todos (today):');
    for (const t of todos) parts.push(`  - ${t}`);
    parts.push('');
  }
  parts.push(
    'Resume the in-flight work from its last completed step. If you judge the work genuinely complete, state the completion with concrete evidence (files changed, tests run) instead of summarizing.',
  );
  let reason = parts.join('\n');
  if (reason.length > MAX_REASON_CHARS) reason = `${reason.slice(0, MAX_REASON_CHARS)}\n…[truncated]`;
  return reason;
}

/**
 * Stop hook entry — evaluate the just-ended turn; block with a work-anchor
 * continuation reason only when summary-shape + no-task-claim + active anchor
 * all hold, and the self loop guard allows it.
 * @returns {void}
 */
function main() {
  if (!ss.skillStateEnabled()) return; // gate off → zero behavior change

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  const msg = String(event.last_assistant_message || '');
  if (!sessionId || !msg) return;

  // A + B on the turn result.
  const shapeIdx = firstMatch(msg, SUMMARY_SHAPE);
  const noTaskIdx = firstMatch(msg, NO_TASK_CLAIM);
  if (shapeIdx === -1 || noTaskIdx === -1) return; // not the failure shape — allow stop

  // C — active work anchor.
  const sigma = ss.loadSigma(sessionId);
  const sigmaActive = !!(
    (typeof sigma.task_summary === 'string' && sigma.task_summary.trim()) ||
    (typeof sigma.current_step === 'string' && sigma.current_step.trim()) ||
    (Array.isArray(sigma.pending_checks) && sigma.pending_checks.length > 0)
  );
  const todos = inProgressTodos(event.cwd);
  if (!sigmaActive && todos.length === 0) return; // no anchor — the claim may be true

  // Self loop guard (Σ-managed; stop_hook_active is unusable — hard-coded true).
  const now = Date.now();
  const streakStart = Number(sigma.turn_guard_streak_start) || 0;
  if (streakStart && now - streakStart > STREAK_WINDOW_MS) {
    sigma.turn_guard_blocks = 0;
    sigma.turn_guard_last_hash = null;
    sigma.turn_guard_streak_start = 0;
  }
  const blocks = Number(sigma.turn_guard_blocks) || 0;
  const h = hashMsg(msg);

  if (sigma.turn_guard_last_hash === h) {
    ss.saveSigma(sessionId, sigma);
    ss.appendTelemetry({ ts: now, session_id: sessionId, hook: 'stop-turn-guard', decision: 'skip', reason: 'identical_message_loop', blocks });
    return;
  }
  if (blocks >= MAX_BLOCKS) {
    ss.saveSigma(sessionId, sigma);
    ss.appendTelemetry({ ts: now, session_id: sessionId, hook: 'stop-turn-guard', decision: 'skip', reason: 'max_blocks_reached', blocks });
    return;
  }

  // Fire: consume the block, then emit.
  sigma.turn_guard_blocks = blocks + 1;
  sigma.turn_guard_last_hash = h;
  if (!streakStart || now - streakStart > STREAK_WINDOW_MS) sigma.turn_guard_streak_start = now;
  ss.saveSigma(sessionId, sigma);

  ss.appendTelemetry({
    ts: now,
    session_id: sessionId,
    hook: 'stop-turn-guard',
    decision: 'block',
    shape_idx: shapeIdx,
    no_task_idx: noTaskIdx,
    anchor: { sigma: sigmaActive, todos: todos.length },
    blocks: blocks + 1,
    msg_hash: h,
  });

  process.stdout.write(JSON.stringify({ decision: 'block', reason: buildReason(sigma, todos) }));
}

main();
