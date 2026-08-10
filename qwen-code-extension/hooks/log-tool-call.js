#!/usr/bin/env node
// PreToolUse hook — log tool calls and track state flags for Hard Gate enforcement
// Handles: search_memory (memoryCalled), remember_decision (decisionRecorded), code changes

const fs = require('fs');
const path = require('path');

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

  const toolName = event.tool_name || 'unknown';
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  const logFile = path.join(STATE_DIR, `${sessionId}.jsonl`);

  // Read current state (or create empty)
  let state = {};
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {}

  // --- Flag updates based on tool name ---

  // search_memory called → mark as memory-called this turn
  if (toolName === 'mcp__focus-memory__search_memory') {
    state.memoryCalled = true;
  }

  // remember_decision called → mark decision recorded for session
  if (toolName.includes('remember_decision')) {
    state.decisionRecorded = true;
    // Clear decline flag since user chose to record
    delete state.decisionDeclined;
  }

  // Code change tools — track and reset decline flag on new work
  if (['edit', 'write_file'].includes(toolName)) {
    // New code edit means a new work unit started — clear old decline so we can ask again later
    delete state.decisionDeclined;
  }

  // Write updated state
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}

  // Append to audit log (jsonl)
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
