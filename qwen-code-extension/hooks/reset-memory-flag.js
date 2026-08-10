#!/usr/bin/env node
// UserPromptSubmit hook — reset memoryCalled flag at start of each new turn
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
  } catch { return; }

  const sessionId = event.session_id;
  if (!sessionId) return;

  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ memoryCalled: false }));
  } catch {}
}

main();
