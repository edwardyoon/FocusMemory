#!/usr/bin/env node
// Stop hook — SKILL.state per-Stop state-change detection + context-growth
// fallback checkpoint.
//
// Runs at the end of every turn. Two independent extraction triggers:
//   1. state change (primary): a mutating tool call (edit / write_file /
//      remember_decision) was logged since the last extraction. Mechanical
//      detection, no LLM — prose-only turns do not pay an extraction call.
//   2. context growth (fallback): input_tokens grew INTERVAL (default 50k)
//      past the last extraction — covers semantic drift that involves no
//      file change (decisions made in prose only).
//
// Either trigger spawns the SAME detached Σ extraction worker PreCompact
// uses (precompact-extract-state.js --worker) — zero user-facing latency,
// warm checkpoints (a crash mid-session leaves a recent Σ on disk).
//
// Regardless of trigger, last_input_tokens is recorded every turn: the
// UserPromptSubmit anchor hook (userprompt-inject-state.js) reads it as its
// injection threshold, so it must track the current context size even on
// turns where nothing is extracted.
//
// Why Stop: it is the only existing qwen-code hook whose payload carries
// contextUsage (input_tokens / context_limit / context_usage) — the token
// signal needed to gate on context growth.
//
// Loop guard: when a trigger fires, last_checkpoint_tokens is set to the
// current input_tokens (re-gating the growth trigger) and
// last_extraction_log_bytes to the current tool-log size (re-basing the
// state-change trigger), so a re-entrant Stop (or a stop-hook "continue"
// loop) cannot re-fire on work that was already counted. We do NOT gate on
// stop_hook_active (that field is hard-coded true on the messageBus Stop
// path, so gating on it would disable the hook entirely).
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0; the session is
// unaffected. Emits no hook output (non-interfering: does not block or steer).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ss = require('./lib/skillstate.js');
const { STATE_DIR } = require('./lib/state.js');

// Growth (tokens) since the last extraction that triggers the fallback.
const INTERVAL = Math.max(1000, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_CHECKPOINT_INTERVAL || '50000', 10) || 50000);

/**
 * Current size of the session's tool-call JSONL (0 when absent).
 * @param {string} sessionId
 * @returns {number}
 */
function toolLogSize(sessionId) {
  try {
    return fs.statSync(path.join(STATE_DIR, `${sessionId}.jsonl`)).size;
  } catch {
    return 0;
  }
}

/**
 * Stop hook entry — record last_input_tokens every turn; extract when a
 * state change was logged or the context grew INTERVAL past the last
 * extraction. Spawns the shared detached worker and returns immediately.
 * @returns {void}
 */
function main() {
  if (!ss.skillStateEnabled()) return; // gate off → zero behavior change

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  const inputTokens = Number(event.input_tokens);
  if (!sessionId || !Number.isFinite(inputTokens) || inputTokens <= 0) return;

  const sigma = ss.loadSigma(sessionId);

  // Always: persist the current context size (anchor threshold input).
  sigma.last_input_tokens = inputTokens;

  // Trigger 1 — mechanical state change since the last extraction.
  const lastOffset = Number(sigma.last_extraction_log_bytes) || 0;
  const stateChanged = ss.hasMutatingCallsSince(sessionId, lastOffset);

  // Trigger 2 — context growth fallback. Re-baseline when the context
  // shrank (a compaction happened since), so the interval counts fresh.
  let last = Number(sigma.last_checkpoint_tokens);
  if (!Number.isFinite(last) || last < 0) last = 0;
  if (inputTokens < last) last = inputTokens;
  const intervalHit = inputTokens - last >= INTERVAL;

  if (!stateChanged && !intervalHit) {
    ss.saveSigma(sessionId, sigma); // last_input_tokens only
    ss.appendTelemetry({
      ts: Date.now(),
      session_id: sessionId,
      hook: 'stop-checkpoint-state',
      event: 'no_trigger',
      input_tokens: inputTokens,
    });
    return;
  }

  // Consume the triggers before spawning (persist first) so a re-entrant
  // Stop cannot re-fire: growth is re-gated by last_checkpoint_tokens,
  // state change by the tool-log byte offset.
  sigma.last_checkpoint_tokens = inputTokens;
  sigma.last_extraction_log_bytes = toolLogSize(sessionId);
  ss.saveSigma(sessionId, sigma);

  try {
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, 'precompact-extract-state.js'),
        '--worker',
        JSON.stringify({
          session_id: sessionId,
          transcript_path: event.transcript_path,
          cwd: event.cwd,
          trigger: stateChanged ? 'stop-state-change' : 'stop-checkpoint',
        }),
      ],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.unref();
  } catch (err) {
    console.error(`[skillstate] checkpoint worker spawn failed: ${err.message}`);
  }

  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'stop-checkpoint-state',
    event: 'checkpoint',
    trigger: stateChanged ? 'state-change' : 'context-growth',
    input_tokens: inputTokens,
  });
}

main();
