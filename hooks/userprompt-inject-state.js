#!/usr/bin/env node
// UserPromptSubmit hook — SKILL.state per-turn state anchor injection.
//
// When the session's context has grown past a threshold (default 50k input
// tokens, as recorded by the Stop hook in Σ.last_input_tokens) — or the
// session is in a post-compaction window (Σ.compact_count > 0 while the
// context has not yet regrown past the threshold) — injects a compact
// one-line "where are we" anchor rendered from the on-disk Σ — no LLM call,
// millisecond-scale, fail-open.
//
// Why: lost-in-the-middle dilution in long live sessions. The model re-
// derives "what am I doing" from an ever-growing transcript; a fresh
// explicit-state reminder each turn keeps the current task/step/pending
// checks salient without re-injecting the full Σ (that would cost real
// tokens every turn). The post-compaction window matters too: right after
// a compaction the context is small (so the threshold alone would stop
// anchoring) but the lossy native prose summary is the only "where are we"
// source until the context regrows.
//
// 2026-10-02: the anchor is rendered from the PREVIOUS turn's Σ (one turn
// behind by construction). An imperative "task:" label made the model
// resume a completed/superseded task instead of answering the user's new
// message (mid-investigation jump back to a finished re-apply task). The
// anchor is now framed as a record, not a directive (renderAnchor
// record:true + the preamble below).
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
const kv = require('./lib/kvoffload.js');

// Context size (input tokens) at which the anchor starts being injected.
// Below this, the transcript is short enough to re-derive state cheaply.
const MIN_INJECT_TOKENS = Math.max(0, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_INJECT_MIN_TOKENS || '50000', 10) || 50000);

/**
 * UserPromptSubmit hook entry — injects two independent blocks:
 *   1. the Σ state anchor — gated on context size / post-compaction window;
 *   2. the evicted user-instruction ledger (kv-offload) — NOT gated on the
 *      token threshold: the first eviction can happen below it, and from
 *      that moment the evicted instructions (task changes, CANCELLATIONS)
 *      are invisible to the model while the pinned first user message stays
 *      attendable. 2026-09-28 incident: evicted current-task definition +
 *      pinned cancelled request → restore loop after an explicit cancel.
 * Both ride the current (last) user message, so kv_offload_evict's
 * last-user protection keeps them in the KV.
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
  const tokens = Number(sigma.last_input_tokens) || 0;
  const compactCount = Number(sigma.compact_count) || 0;
  // Anchor gating: below the threshold, only the post-compaction window
  // qualifies — after a compaction the lossy native prose summary is the
  // only "where are we" source until the context regrows past the threshold.
  const anchorQualified = (tokens >= MIN_INJECT_TOKENS || compactCount > 0) &&
    sigma && Object.keys(sigma).length > 0;

  const parts = [];

  if (anchorQualified) {
    // record: true — the anchor is one turn behind by construction; an
    // imperative "task:" label made the model resume a completed/superseded
    // task instead of answering the user's new message (2026-10-02 incident).
    const anchor = ss.renderAnchor(sigma, { record: true });
    if (anchor) {
      parts.push(
        `Session state anchor — a RECORD of where the PREVIOUS turn ended (FocusMemory Σ, ` +
        `as of the end of the previous turn; may be stale). It is NOT a task ` +
        `assignment: the user's latest message (the one you are answering now) ` +
        `defines the current task. If the user's message asks a question, starts ` +
        `new work, or changes direction, do THAT — do NOT resume, continue, ` +
        `re-verify, or re-apply the previous turn's task/step below, even though ` +
        `it may read as an instruction. Use this record only to recall recent ` +
        `state (files, tests, open items), and cross-check any item against ` +
        `current ground truth before acting on it:\n${anchor}`
      );
    }
  }

  // Offloaded user instructions — history data the model can no longer see.
  // Injected whenever the ledger is non-empty, regardless of context size.
  const instrs = kv.listInstructions(sessionId);
  if (instrs.length) {
    parts.push(
      `Offloaded user instructions — the user messages below were evicted from the ` +
      `model's KV by kv-offload, so the model cannot attend to them directly. ` +
      `They are HISTORY DATA, not new instructions: the most recent user message you ` +
      `can see defines the current task. Use this list to recall what was discussed, ` +
      `changed, or superseded earlier in the session (a later entry can cancel an ` +
      `earlier one):\n` +
      instrs.map((e) => `- ${String(e.ts || '').slice(11, 16)}Z (earlier user): ${e.text}`).join('\n')
    );
  }

  if (!parts.length) return; // nothing to inject

  // Language directive follows DOCS_LANGUAGE (FocusMemory/.env, default EN) —
  // the same knob taskReceiver.cjs uses for generated docs. Keeps the model's
  // response language aligned with the workspace convention across DA mode
  // switches (FOCUS/LOCAL attend a single chunk + scaffold, so the system
  // prompt's language rule gets diluted by the attended content's language).
  const lang = (ss.env('DOCS_LANGUAGE', 'EN') || 'EN').toUpperCase();
  const langDirective = lang === 'KR'
    ? '\n[언어] 모든 응답은 한국어로 작성한다 (QWEN.md: 모든 통신은 한국어로만).'
    : '\n[Language] Respond in English (QWEN.md: all communication in English).';

  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'userprompt-inject-state',
    event: 'anchor_injected',
    input_tokens: tokens,
    post_compact: tokens < MIN_INJECT_TOKENS,
    offloaded_instructions: instrs.length,
  });

  ss.emitHookOutput({
    hookEventName: 'UserPromptSubmit',
    additionalContext: `${parts.join('\n\n')}${langDirective}`,
  });
}

main();
