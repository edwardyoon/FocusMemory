#!/usr/bin/env node
// PreToolUse hook — deny grep_search/glob unless memory was satisfied THIS turn.
//
// Satisfaction is epoch-scoped (see lib/state.js): reset-memory-flag.js
// increments turnEpoch on every prompt and clears the stamp; the HTTP
// auto-recall hook or an explicit search_memory stamps memoryCalledEpoch =
// current turnEpoch. The gate passes only when the two match — so a stamp
// from an earlier turn (e.g. after a failed recall on the new turn) can
// never satisfy the gate.
//
// Denial escalation (anti-livelock, plans/repeat-error.md): an unsatisfied
// call is counted per (tool, argsHash) within DENY_WINDOW_MS. The 1st deny
// carries the base message (now with a "skip the search" escape); the 2nd
// identical deny escalates and explicitly forbids the retry; the 3rd is
// fail-open (allow) so the gate can never trap the model in an infinite
// block→retry loop. Counters live in the per-session state file (`denies`)
// and persist across turns (reset-memory-flag.js and log-tool-call.js both
// merge via updateState, they never overwrite), so cross-turn repetition of
// the same call also converges.

const fs = require('fs');
const crypto = require('crypto');
const { loadState, stateFile, appendTelemetry, updateState } = require('./lib/state.js');

const DENY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DENIES = 3;                 // 3rd identical deny → fail-open

/**
 * 12-hex-char sha256 prefix of a string (loop-detection key).
 * @param {string} s
 * @returns {string}
 */
function hashArgs(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/**
 * Record one denial for (tool, argsHash) within the window, pruning stale
 * records. Returns the new count for this exact call (1 if first).
 * @param {string} sessionId
 * @param {string} tool
 * @param {string} argsHash
 * @returns {number}
 */
function recordDeny(sessionId, tool, argsHash) {
  const now = Date.now();
  const next = updateState(sessionId, (s) => {
    const denies = Array.isArray(s.denies) ? s.denies : [];
    const fresh = denies.filter((d) => now - (d.ts || 0) < DENY_WINDOW_MS);
    const rec = fresh.find((d) => d.tool === tool && d.h === argsHash);
    if (rec) rec.count = (rec.count || 1) + 1;
    else fresh.push({ tool, h: argsHash, ts: now, count: 1 });
    return { ...s, denies: fresh };
  });
  const rec = (next && Array.isArray(next.denies) ? next.denies : []).find((d) => d.tool === tool && d.h === argsHash);
  return rec ? rec.count : 1;
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { returnAllow(); }

  const sessionId = event.session_id;
  if (!sessionId) returnAllow();

  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || '';

  // 1. Bypass Hard Gate when an explicit file path is present in the tool input
  try {
    const inputStr = JSON.stringify(toolInput);
    // Absolute path pattern: /.../filename.ext — \b after the extension so it
    // also matches inside stringified JSON object input (e.g. {"path":"/a/b.js"})
    const explicitFile = /\/[A-Za-z0-9_\-\.\/]+\.[a-zA-Z0-9]{2,5}\b/.test(inputStr);
    if ((toolName === 'grep_search' || toolName === 'glob') && explicitFile) {
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision: 'allow', memoryCalled: false, reason: 'explicit_file_path_bypass' });
      returnAllow();
    }
  } catch {}

  // 2. Base gate decision (epoch-scoped satisfaction).
  let allow = false;
  let reason = 'epoch_mismatch';
  try {
    if (!fs.existsSync(stateFile(sessionId))) {
      reason = 'no_state';
    } else {
      const state = loadState(sessionId);
      const turnEpoch = Number.isFinite(state.turnEpoch) ? state.turnEpoch : null;
      // Strict equality on both fields — a legacy state file without turnEpoch
      // (turnEpoch null) never passes.
      if (turnEpoch !== null && typeof state.memoryCalledEpoch === 'number' && state.memoryCalledEpoch === turnEpoch) {
        allow = true;
        reason = state.satisfiedBy || 'memory_called';
      }
      if (turnEpoch === null) reason = 'legacy_state';
    }
  } catch {
    returnAllow();
  }

  if (allow) {
    appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision: 'allow', memoryCalled: true, reason });
    returnAllow();
  }

  // 3. Unsatisfied → denial with escalation (anti-livelock).
  const argsHash = hashArgs(JSON.stringify(toolInput));
  const count = recordDeny(sessionId, toolName, argsHash);

  if (count >= MAX_DENIES) {
    // 3rd identical deny → fail-open: the gate must never trap the model.
    appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision: 'allow', memoryCalled: false, reason: 'fail_open_max_denies', deny_count: count, root_reason: reason });
    returnAllow();
  }

  appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision: 'deny', memoryCalled: false, reason, deny_count: count });
  returnDeny(count, toolName);
}

function returnAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
  }));
  process.exit(0);
}

function denyMessage(count, toolName) {
  if (count >= 2) {
    return `[Hard Gate] This exact ${toolName} call was ALREADY blocked ${count - 1} time(s). Stop retrying it. Either call mcp__focus-memory__search_memory now, or — if you already have the information you need — proceed with the work WITHOUT this search. The next identical call will be allowed.`;
  }
  return `[Hard Gate] Call mcp__focus-memory__search_memory before using ${toolName}. If you do not actually need to search (the info is already in hand), you may proceed without it — but do not repeat this exact call.`;
}

function returnDeny(count, toolName) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyMessage(count, toolName)
    }
  }));
  process.exit(0);
}

main();
