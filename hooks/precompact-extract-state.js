#!/usr/bin/env node
// PreCompact hook — SKILL.state: kick off structured execution state (Σ)
// extraction from the pre-compaction transcript.
//
// Two modes:
//   parent (default)  — spawns a detached worker, emits the summarizer nudge,
//                       exits 0 in milliseconds. Native compaction is NEVER
//                       blocked by the LLM call.
//   --worker <event>  — the detached child: transcript tail → SUMMARY_LLM
//                       state-patch extraction (JSON only, no prose) →
//                       null-deletion merge into
//                       ~/.qwen/tmp/focus-memory/state/<sid>.json →
//                       dual-write a work_memory "state_checkpoint" point.
//
// Why async: the transcript JSONL keeps its full raw history after
// compaction (qwen only appends a `chat_compression` system record), so the
// extraction can run in parallel with the native compaction side-query and
// the Σ is ready by the time SessionStart(source=compact) re-injects it.
// For small contexts the native summary can finish before the worker — in
// that case the injection is simply skipped this round (fail-open); the Σ
// still lands for the next compaction and in work_memory.
//
// Feature gate: FOCUSMEMORY_SKILLSTATE=on — any other value / unset returns
// immediately at the entry, so with the gate off the existing auto-recall +
// Hard Gate structure is byte-for-byte untouched.
//
// Fail-open (same principle as the Hard Gate hooks): any error → silent exit 0;
// native compaction proceeds exactly as if this hook did not exist.

const fs = require('fs');
const { spawn } = require('child_process');
const ss = require('./lib/skillstate.js');

const LLM_TIMEOUT_MS = 120000; // worker is detached — no hook timeout constrains it
// Transcript window for extraction (rendered chars). Local 27B prefill is
// ~0.5ms/char; 30k keeps the worker in the ~1min range.
const BUDGET_CHARS = Math.max(2000, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_MAX_CHARS || '30000', 10) || 30000);

/**
 * Worker mode — the actual extraction (runs detached, no hook timeout).
 * @param {object} event - PreCompact event JSON
 * @returns {Promise<void>}
 */
async function runWorker(event) {
  const sessionId = event.session_id;
  if (!sessionId) return;

  const transcriptText = ss.extractTranscriptTail(event.transcript_path, BUDGET_CHARS);
  if (!transcriptText) return; // recording disabled or unreadable — nothing to extract

  const sigma = ss.loadSigma(sessionId);
  const rawOutput = await ss.callSummaryLLM(ss.buildExtractionPrompt(sigma, transcriptText), LLM_TIMEOUT_MS);
  const patch = ss.extractJsonPatch(rawOutput);
  if (!patch || Object.keys(patch).length === 0) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'extract_failed', trigger: event.trigger });
    return; // fail-open — compaction proceeds without state
  }

  const next = ss.mergeSigma(sigma, patch);
  next.session_id = sessionId;
  next.updated_at = new Date().toISOString();
  ss.saveSigma(sessionId, next);
  ss.recordCheckpoint(next, event.cwd, event.trigger).catch(() => {});
  ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'extracted', trigger: event.trigger, keys: Object.keys(patch) });
}

/**
 * Parent mode — spawn the detached worker and return immediately.
 * @param {object} event - PreCompact event JSON
 */
function spawnWorker(event) {
  try {
    const child = spawn(process.execPath, [__filename, '--worker', JSON.stringify(event)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (err) {
    console.error(`[skillstate] worker spawn failed: ${err.message}`);
  }
}

function main() {
  // Worker mode (detached child)
  if (process.argv[2] === '--worker') {
    if (!ss.skillStateEnabled()) return;
    let event = {};
    try {
      event = JSON.parse(process.argv[3] || '{}');
    } catch {
      return;
    }
    // The pending LLM fetch keeps the event loop alive until the work is done;
    // a crash must not take down anything else — log the reason for diagnosis.
    runWorker(event).catch((err) => {
      ss.appendTelemetry({
        ts: Date.now(),
        session_id: event.session_id || '',
        hook: 'precompact-extract-state',
        event: 'worker_error',
        error: String((err && err.message) || err),
      });
    });
    return;
  }

  // Parent mode — feature gate first: off means zero behavior change.
  if (!ss.skillStateEnabled()) return;

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (!event.session_id) return;

  spawnWorker(event);

  ss.emitHookOutput({
    hookEventName: 'PreCompact',
    additionalContext:
      'FocusMemory SKILL.state: a structured execution state (files touched, test status, current step, pending checks, decisions) is being extracted from this conversation in parallel and persisted separately. ' +
      'In your summary, do NOT re-enumerate those facts — focus on decisions, rationale, and open issues not captured as structured state.',
  });
}

main();
