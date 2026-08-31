#!/usr/bin/env node
// Stop hook — SKILL.state periodic checkpoint.
//
// When the context has grown CHECKPOINT_INTERVAL tokens (default 50k) past the
// last checkpoint, spawn the SAME detached Σ extraction worker that PreCompact
// uses (precompact-extract-state.js --worker). This yields warm checkpoints
// (fault tolerance: a crash mid-session leaves a recent Σ on disk; fresher
// state within a long pre-compaction cycle) at zero user-facing latency.
//
// Why Stop: it is the only existing qwen-code hook whose payload carries
// contextUsage (input_tokens / context_limit / context_usage) — the token
// signal needed to gate on context growth. PreToolUse/PostToolUse/PreCompact
// do not expose it. No upstream change required.
//
// Threshold is the loop guard: after a checkpoint, last_checkpoint_tokens is
// set to the current input_tokens, so a re-entrant Stop (or a stop-hook
// "continue" loop) cannot re-fire until another full interval of growth. We
// therefore do NOT gate on stop_hook_active (that field is hard-coded true on
// the messageBus Stop path, so gating on it would disable the hook entirely).
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0; the session is
// unaffected. Emits no hook output (non-interfering: does not block or steer).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ss = require('./lib/skillstate.js');

// Growth (tokens) since the last checkpoint that triggers a new one.
const INTERVAL = Math.max(1000, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_CHECKPOINT_INTERVAL || '50000', 10) || 50000);

/**
 * Stop hook entry — checkpoint when context growth since the last checkpoint
 * reaches INTERVAL. Spawns the shared detached extraction worker and returns
 * immediately (the worker is unref'd, so it is not bound by the hook timeout).
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

  // Baseline = the last checkpointed token count. Re-baseline when the context
  // shrank (a compaction happened since), so the next interval counts fresh.
  let last = Number(sigma.last_checkpoint_tokens);
  if (!Number.isFinite(last) || last < 0) last = 0;
  if (inputTokens < last) last = inputTokens;

  if (inputTokens - last < INTERVAL) return; // not grown enough yet

  // Consume the threshold first (persist before spawning) so a re-entrant Stop
  // cannot re-fire. The worker preserves this key: mergeSigma only touches the
  // Σ schema keys, so last_checkpoint_tokens survives the worker's save.
  sigma.last_checkpoint_tokens = inputTokens;
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
          trigger: 'stop-checkpoint',
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
    trigger: 'stop',
    input_tokens: inputTokens,
  });
}

main();
