#!/usr/bin/env node
// SessionStart hook (matcher "compact") — SKILL.state: after native
// compaction completes, re-inject the structured execution state (Σ) so the
// model conditions on explicit state instead of reconstructing it from the
// prose summary. This is the "state-first reference" point of the design.
//
// Flow: load Σ → compact_count += 1 (counts real completed compactions —
// this event only fires on the chat_compressed path) → inject as
// additionalContext (appended to the system instructions as a hidden block).
//
// Feature gate: FOCUSMEMORY_SKILLSTATE=on — any other value / unset returns
// immediately at the entry, so with the gate off the existing auto-recall +
// Hard Gate structure is byte-for-byte untouched.
//
// Fail-open: no Σ file (extraction was skipped or failed) → silent exit 0;
// the session continues with the native summary only.

const fs = require('fs');
const ss = require('./lib/skillstate.js');

const MAX_INJECT_CHARS = 4000; // keep the injected block small (O(1) prompt)

function main() {
  // Feature gate — off means zero behavior change.
  if (!ss.skillStateEnabled()) return;

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  if (event.source !== 'compact') return; // defensive — the matcher already filters on source
  const sessionId = event.session_id;
  if (!sessionId) return;

  const sigma = ss.loadSigma(sessionId);
  if (!sigma || Object.keys(sigma).length === 0) return; // nothing extracted — fail-open

  sigma.compact_count = (Number.isFinite(sigma.compact_count) ? sigma.compact_count : 0) + 1;
  ss.saveSigma(sessionId, sigma);
  ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'sessionstart-inject-state', event: 'injected', compact_count: sigma.compact_count });

  let body = JSON.stringify(sigma, null, 2);
  if (body.length > MAX_INJECT_CHARS) body = `${body.slice(0, MAX_INJECT_CHARS)}\n...[truncated]`;
  ss.emitHookOutput({
    hookEventName: 'SessionStart',
    additionalContext:
      `Execution State (Σ) — structured state extracted from this session before compaction; ` +
      `prefer it over the prose summary for "where are we" questions:\n` +
      '```json\n' + body + '\n```',
  });
}

main();
