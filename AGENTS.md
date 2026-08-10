# FocusMemory Search Protocol (Hard Gate)

## Required Order
1. **search_memory** — Past work history, decisions, unresolved issues (call first)
2. **search_code** — Natural language code search: "Where is this logic?", "Is there a similar pattern?"
3. **query_graph** — Code dependency questions: function definitions, call relationships
4. **grep / glob / file read** — Verify actual code location and read files
5. Code modification or answer

## Conditional Re-search Rules
- If context was already injected by Hook (`## Search Results (Auto-injected)` header present),
  do NOT call `search_memory` again with the same keywords.
- Only re-search when a new sub-question arises or initial results are insufficient.

## Rules
- Concept/behavior questions → search_memory first, then grep
- "Why was this done", "Have we tried this before" → must call search_memory first
- Exact symbol name known → can go directly to grep; otherwise use search tools first

## Write-back Rules (remember_decision)
- Do not save on every file edit.
- **Trigger: call `remember_decision` once after a task completes** — specifically when tests pass, a feature is delivered, or a bug root cause is identified and fixed.
- What to save: key decisions, bug root causes and fixes, architecture changes.
- Always include `reasoning` (why this decision was made) — it's what makes causal chains useful.
- Leave `topic_key` empty for auto-inference; the server matches against existing topics via embedding similarity.
- If a new decision replaces an older approach on the same topic, **omit `supersedes`** — auto-supersede detection will find and link the prior active node via topic_key + embedding similarity (threshold ≥ 0.8).
