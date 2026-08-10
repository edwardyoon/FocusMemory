# FocusMemory Search Protocol (Hard Gate)

## Required Order — Always follow this chain, do NOT skip steps

1. **search_memory** — Query ALL backends: work_memory, decision_chains, project_facts, **code_structure**, **code_chunks**. This is your FIRST call for ANY question about the codebase.
   - `search_memory` indexes both past decisions AND live code (file paths, functions, classes, imports via Meilisearch + embedding-based chunks via Qdrant).
   - If results contain structural/code hits → proceed to step 2-3 for details.
   - If results are empty or only historical → still call step 2-3 if the question is about code structure/logic.

2. **search_code** — Natural language code search: "Where is this logic?", "Is there a similar pattern?", "How does X work?". Uses embedding-based semantic matching against indexed code chunks (Qdrant).
   - Call this AFTER search_memory when you need actual code content, not just file paths or decision history.
   - Use `entity_type` filter for targeted searches: `"function"`, `"method"`, `"class"`.

3. **query_graph** — Code dependency questions: "Who calls X?", "What's in Y file?", "What does Z depend on?". Uses Meilisearch code_structure index (AST-extracted entities, imports, file metadata).
   - Call this AFTER search_code when you need call relationships, function definitions, or precise structural queries.

4. **grep_search / glob / read_file** — Verify exact line numbers, read full context, match symbol names. Only use these AFTER steps 1-3 have narrowed down the target files/areas.
   - `grep_search` for exact regex patterns in known files.
   - `glob` for file pattern matching when you know the naming convention.
   - `read_file` to read full context of identified targets.

5. Code modification or answer.

## When to Skip Steps (Exceptions)
- User explicitly names a file path ("Read /path/to/file.php") → go directly to `read_file`.
- User asks for exact symbol match with known name (`grep_search` only).
- Hook already injected context (`## Search Results (Auto-injected)` header present) — do NOT re-search with same keywords.

## Conditional Re-search Rules
- If search_memory results are insufficient for code structure questions, ALWAYS proceed to step 2 (search_code), then step 3 (query_graph). Do NOT jump directly to grep/glob.
- Only skip to step 4 when you have concrete file paths from earlier steps and need exact line numbers or full context.

## Rules
- Concept/behavior/architecture questions → search_memory first, then search_code/query_graph for code details
- "Why was this done", "Have we tried this before" → must call search_memory first (decision_chains)
- Code structure/logic questions → search_memory → search_code → query_graph → grep_search (full chain)
- Exact symbol name AND file known → can go directly to grep_search; otherwise use full search chain

## Tool Coverage Reference
| Backend | Index | Content | Access via |
|---------|-------|---------|-----------|
| work_memory | filesystem | Past sessions, decisions, todos | `search_memory`, `search_work_memory` |
| decision_chains | filesystem | Causal chains of why/how | `trace_decision_chain` |
| project_facts | Meilisearch (docs_plans) | Fixed architecture, DB schema, API specs | `search_project_facts` |
| code_structure | Meilisearch (code_structure) | File paths, entities (functions/classes), imports | `query_graph` |
| code_chunks | Qdrant | Semantic code chunks with embeddings | `search_code` |

## Write-back Rules (remember_decision)
- Do not save on every file edit.
- **Trigger: call `remember_decision` once after a task completes** — specifically when tests pass, a feature is delivered, or a bug root cause is identified and fixed.
- What to save: key decisions, bug root causes and fixes, architecture changes.
- Always include `reasoning` (why this decision was made) — it's what makes causal chains useful.
- Leave `topic_key` empty for auto-inference; the server matches against existing topics via embedding similarity.
- If a new decision replaces an older approach on the same topic, **omit `supersedes`** — auto-supersede detection will find and link the prior active node via topic_key + embedding similarity (threshold ≥ 0.8).
