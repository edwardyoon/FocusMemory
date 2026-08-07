# FocusMemory Search Protocol (Hard Gate)

> Full protocol is defined in `~/.qwen/AGENTS.md` and loaded globally. This file enforces the search order inside the agent loop when the extension is active.

## Required Order
1. **search_memory** — Past work history, decisions, unresolved issues (call first)
2. **search_code** — Natural language code search: "Where is this logic?", "Is there a similar pattern?"
3. **query_graph** — Code dependency questions: function definitions, call relationships
4. **grep / glob / file read** — Verify actual code location and read files
5. Code modification or answer

## Conditional Re-search Rules
- If context was already injected by Hook (`## 검색 결과 (자동 주입)` header present),
  do NOT call `search_memory` again with the same keywords.
- Only re-search when a new sub-question arises or initial results are insufficient.

## Rules
- Concept/behavior questions → search_memory first, then grep
- "Why was this done", "Have we tried this before" → must call search_memory first
- Exact symbol name known → can go directly to grep; otherwise use search tools first

## Write-back (see `~/.qwen/AGENTS.md` for full rules)
- Call **`remember_decision`** once after task completes — tests pass, feature delivered, bug fixed.
- Always include `reasoning`. Leave `topic_key` empty for auto-inference.
- Omit `supersedes` — auto-supersede handles it (threshold ≥ 0.8).
