#!/usr/bin/env node
// PreToolUse hook — deny grep_search/glob if search_memory was not called this turn
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

  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);

  try {
    let state;
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } else {
      returnDeny();
    }
    if (state && state.memoryCalled) {
      returnAllow();
    }
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
