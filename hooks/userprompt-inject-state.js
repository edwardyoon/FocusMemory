#!/usr/bin/env node
// UserPromptSubmit hook — SKILL.state per-turn state anchor injection.
//
// When the session's context has grown past a threshold (default 50k input
// tokens, as recorded by the Stop hook in Σ.last_input_tokens), injects a
// compact one-line "where are we" anchor rendered from the on-disk Σ —
// no LLM call, millisecond-scale, fail-open.
//
// Why: lost-in-the-middle dilution in long live sessions. The model re-
// derives "what am I doing" from an ever-growing transcript; a fresh
// explicit-state reminder each turn keeps the current task/step/pending
// checks salient without re-injecting the full Σ (that would cost real
// tokens every turn).
//
// If the previous turn's extraction worker is still running, the anchor is
// one turn stale — harmless: the live tail of the transcript contains
// everything done since, and the next turn's anchor is fresh.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0, the turn proceeds
// without the anchor.

const fs = require('fs');
const ss = require('./lib/skillstate.js');

// Context size (input tokens) at which the anchor starts being injected.
// Below this, the transcript is short enough to re-derive state cheaply.
const MIN_INJECT_TOKENS = Math.max(0, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_INJECT_MIN_TOKENS || '50000', 10) || 50000);

/**
 * UserPromptSubmit hook entry — inject the Σ state anchor when the context
 * is large enough to need one.
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
  if (!sessionId) return;

  const sigma = ss.loadSigma(sessionId);
  if (!sigma || Object.keys(sigma).length === 0) return; // no Σ yet — nothing to anchor

  const tokens = Number(sigma.last_input_tokens) || 0;
  if (tokens < MIN_INJECT_TOKENS) return; // short context — nothing to anchor

  const anchor = ss.renderAnchor(sigma);
  if (!anchor) return; // Σ exists but has no renderable content

  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'userprompt-inject-state',
    event: 'anchor_injected',
    input_tokens: tokens,
  });

  ss.emitHookOutput({
    hookEventName: 'UserPromptSubmit',
    additionalContext:
      `Session state anchor (FocusMemory Σ, as of the end of the previous turn — ` +
      `prefer it over re-deriving from history):\n${anchor}`,
  });
}

main();
