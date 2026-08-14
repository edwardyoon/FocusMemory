#!/usr/bin/env node
// UserPromptSubmit hook — reset memoryCalled at start of each turn
// decisionRecorded and decisionDeclined are NOT reset here; they persist across turns
// until a new code change (edit/write_file) clears the decline flag via log-tool-call.js.

const fs = require('fs');
const path = require('path');

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

  // Read existing state to preserve decisionRecorded/decisionDeclined across turns
  let state = {};
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {}

  // Reset only memoryCalled — turn-level flag for read Hard Gate
  state.memoryCalled = false;

  // decisionRecorded: preserve across turns (once recorded, stays recorded)
  // decisionDeclined: preserved until new edit/write_file clears it in log-tool-call.js

  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

main();
