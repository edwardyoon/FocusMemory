#!/usr/bin/env node
// PreToolUse hook — deny grep_search/glob unless memory was satisfied THIS turn.
//
// Satisfaction is epoch-scoped (see lib/state.js): reset-memory-flag.js
// increments turnEpoch on every prompt and clears the stamp; the HTTP
// auto-recall hook or an explicit search_memory stamps memoryCalledEpoch =
// current turnEpoch. The gate passes only when the two match — so a stamp
// from an earlier turn (e.g. after a failed recall on the new turn) can
// never satisfy the gate.

const fs = require('fs');
const { loadState, stateFile, appendTelemetry } = require('./lib/state.js');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { returnAllow(); }

  const sessionId = event.session_id;
  if (!sessionId) returnAllow();

  const toolName = event.tool_name || '';

  // 1. Bypass Hard Gate when an explicit file path is present in the tool input
  try {
    const inputStr = JSON.stringify(event.tool_input || '');
    // Absolute path pattern: /.../filename.ext — \b after the extension so it
    // also matches inside stringified JSON object input (e.g. {"path":"/a/b.js"})
    const explicitFile = /\/[A-Za-z0-9_\-\.\/]+\.[a-zA-Z0-9]{2,5}\b/.test(inputStr);
    if ((toolName === 'grep_search' || toolName === 'glob') && explicitFile) {
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision: 'allow', memoryCalled: false, reason: 'explicit_file_path_bypass' });
      returnAllow();
    }
  } catch {}

  let decision = 'deny';
  let reason = 'epoch_mismatch';
  try {
    if (!fs.existsSync(stateFile(sessionId))) {
      reason = 'no_state';
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision, memoryCalled: false, reason });
      returnDeny();
    }
    const state = loadState(sessionId);
    const turnEpoch = Number.isFinite(state.turnEpoch) ? state.turnEpoch : null;
    // Strict equality on both fields — a legacy state file without turnEpoch
    // (turnEpoch null) never passes.
    if (turnEpoch !== null && typeof state.memoryCalledEpoch === 'number' && state.memoryCalledEpoch === turnEpoch) {
      decision = 'allow';
      reason = state.satisfiedBy || 'memory_called';
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision, memoryCalled: true, reason });
      returnAllow();
    }
    if (turnEpoch === null) reason = 'legacy_state';
    appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision, memoryCalled: false, reason });
    returnDeny();
  } catch {
    returnAllow();
  }
}

function returnAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
  }));
  process.exit(0);
}

function returnDeny() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '[Hard Gate] Call mcp__focus-memory__search_memory before using grep_search/glob.'
    }
  }));
  process.exit(0);
}

main();
