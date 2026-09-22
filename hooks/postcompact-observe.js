#!/usr/bin/env node
// PostCompact hook — DA dead-marker observation (telemetry only).
//
// After native compaction the summary (one user message) may have copied
// [[da:N]] / <da:N> marker text from pre-compaction DA blocks verbatim.
// The focus-llama scanner (tail anchoring, P1) makes such dead markers
// structurally harmless, but this hook quantifies how often the summarizer
// copies them so the defense's premise stays measured.
//
// The PostCompact hook output is a no-op channel in qwen-code (no
// consumer), so this hook only appends a telemetry entry and exits 0.
//
// Gated by FOCUSMEMORY_DA=on (off/unset → immediate no-op): with DA off,
// no marker block was ever injected, so a summary cannot contain markers.
// Fail-open: any error → silent exit 0; compaction is never affected.

const fs = require('fs');
const ss = require('./lib/skillstate.js');

function main() {
  if (!['on', '1', 'true'].includes((ss.env('FOCUSMEMORY_DA', '') || '').toLowerCase())) return;

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (!event.session_id) return;

  const summary = typeof event.compact_summary === 'string' ? event.compact_summary : '';
  const brack = (summary.match(/\[\[da:/g) || []).length;
  const angle = (summary.match(/<da:/g) || []).length;

  ss.appendTelemetry({
    ts: Date.now(),
    session_id: event.session_id,
    hook: 'postcompact-observe',
    event: 'summary_scanned',
    trigger: event.trigger,
    summary_chars: summary.length,
    da_markers_bracket: brack,
    da_markers_angle: angle,
  });
}

try {
  main();
} catch {
  // fail-open — never affect compaction
}
