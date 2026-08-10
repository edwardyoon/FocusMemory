#!/usr/bin/env node
// PreToolUse hook — when search_memory is called, set memoryCalled flag to true
// State file: {STATE_DIR}/{session_id}.json → { memoryCalled: boolean }

const fs = require('fs');
const path = require('path');

// State lives in ~/.qwen/tmp/tool-calls/ so it's per-user, not tied to where FocusMemory is cloned
const STATE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qwen', 'tmp', 'tool-calls');
fs.mkdirSync(STATE_DIR, { recursive: true });

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { returnAllow(); }

  const sessionId = event.session_id;
  if (!sessionId) returnAllow();

  // Set state flag — search_memory has been called this turn
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ memoryCalled: true }));
  } catch {}

  // Audit log (optional)
  const toolName = event.tool_name || 'unknown';
  const logFile = path.join(STATE_DIR, `${sessionId}.jsonl`);
  const line = JSON.stringify({ tool: toolName, ts: Date.now() }) + '\n';
  try { fs.appendFileSync(logFile, line); } catch {}

  returnAllow();
}

function returnAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
  }));
}

main();
