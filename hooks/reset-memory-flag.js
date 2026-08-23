#!/usr/bin/env node
// UserPromptSubmit hook — start a new turn: increment turnEpoch and clear the
// satisfaction stamp. The Hard Gate (check-memory-first.js) only passes when
// memoryCalledEpoch === turnEpoch, so clearing the stamp here forces either a
// fresh auto-recall stamp (HTTP hook) or an explicit search_memory this turn.
//
// decisionRecorded and decisionDeclined are NOT reset here; they persist
// across turns until a new code change (edit/write_file) clears them via
// log-tool-call.js.
//
// Lock-protected write (updateState): the HTTP recall hook runs in parallel
// for the same prompt and writes the same file. The lock serializes them so
// this epoch increment is never lost — a lost increment would let the
// previous turn's satisfaction leak into the new turn (silent gate bypass).

const fs = require('fs');
const state = require('./lib/state.js');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { return; }

  const sessionId = event.session_id;
  if (!sessionId) return;

  state.updateState(sessionId, (s) => ({
    ...s,
    turnEpoch: (Number.isFinite(s.turnEpoch) ? s.turnEpoch : 0) + 1,
    memoryCalled: false,
    memoryCalledEpoch: null,
    satisfiedBy: null,
  }));
}

main();
