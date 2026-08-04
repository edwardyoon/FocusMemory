# FocusMemory Search Protocol (Hard Gate)

## Required Order
1. **search_memory** — Past work history, decisions, unresolved issues (call first)
2. **query_graph** — Code dependency questions: function definitions, call relationships
3. **grep / glob / file read** — Verify actual code location and read files
4. Code modification or answer

## Conditional Re-search Rules
- If context was already injected by Hook (`## 검색 결과 (자동 주입)` header present),
  do NOT call `search_memory` again with the same keywords.
- Only re-search when a new sub-question arises or initial results are insufficient.

## Rules
- Concept/behavior questions → search_memory first, then grep
- "Why was this done", "Have we tried this before" → must call search_memory first
- Exact symbol name known → can go directly to grep; otherwise use search tools first

## Write-back Rules (remember_decision)
- Do not save on every file edit.
- Save once after the full task completes or after tests pass.
- What to save: key decisions, bug root causes and fixes, architecture changes.
