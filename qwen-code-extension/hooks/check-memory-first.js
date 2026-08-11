#!/usr/bin/env node
// PreToolUse hook — deny grep_search/glob if search_memory was not called this turn
const fs = require('fs');
const path = require('path');

// State lives in ~/.qwen/tmp/tool-calls/ so it's per-user, not tied to where FocusMemory is cloned
const STATE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qwen', 'tmp', 'tool-calls');
const TELEMETRY_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qwen', 'tmp', 'focus-memory');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(TELEMETRY_DIR, { recursive: true });

function appendTelemetry(entry) {
  const file = path.join(TELEMETRY_DIR, 'gate-telemetry.jsonl');
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {}
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { returnAllow(); }

  const sessionId = event.session_id;
  if (!sessionId) returnAllow();

  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  const toolName = event.tool_name || '';

  // 1. Bypass Hard Gate when an explicit file path is present in the tool input
  try {
    const inputStr = JSON.stringify(event.tool_input || '');
    // Absolute path pattern: /.../filename.ext
    const explicitFile = /\/[A-Za-z0-9_\-\.\/]+\.[a-zA-Z0-9]{2,5}(?:\s|$)/.test(inputStr);
    if ((toolName === 'grep_search' || toolName === 'glob') && explicitFile) {
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision: 'allow', memoryCalled: false, reason: 'explicit_file_path_bypass' });
      returnAllow();
    }
  } catch {}

  let decision = 'deny';
  try {
    let state;
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } else {
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision, memoryCalled: false, reason: 'no_state' });
      returnDeny();
    }
    if (state && state.memoryCalled) {
      decision = 'allow';
      appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision, memoryCalled: true });
      returnAllow();
    }
    appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-memory-first', tool: toolName, decision, memoryCalled: false });
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
