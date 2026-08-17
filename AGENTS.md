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

## Note on Hook Enforcement
The `check-memory-first` hook now intercepts grep_search/glob calls and can auto-inject relevant memory/code search results before the tool executes. When you see a `## Search Results (Auto-injected)` header, treat step 1 (search_memory) as already satisfied — do not re-call it manually. This Hard Gate exists to narrow the search space before falling back to raw grep/glob, not to force a fixed number of tool calls; if the hook has already surfaced the relevant files, proceed directly to reading/editing them.

## When to Skip Steps (Exceptions)
- User explicitly names a file path ("Read /path/to/file.php") → go directly to `read_file`.
- User asks for exact symbol match with known name (`grep_search` only).
- Hook already injected context (`## Search Results (Auto-injected)` header present) — do NOT re-search with same keywords.

## Conditional Re-search Rules
- If search_memory results are insufficient for code structure questions, ALWAYS proceed to step 2 (search_code), then step 3 (query_graph). Do NOT jump directly to grep/glob.
- Only skip to step 4 when you have concrete file paths from earlier steps and need exact line numbers or full context.

## Source Attribution — `[출처 : file]` Tags
The `search_memory` summary tags each fact with its source file, e.g. `[출처 : docs/blog-system.md]`. The summary is a compressed view — the tagged file is the ground truth.

- **When you need more detail than the summary gives, `read_file` the tagged file directly.** Do not guess at the missing detail and do not re-run the search — the tag is a verified pointer to a real file in the workspace.
- Multiple files in one tag (`[출처 : a.md, b.md]`) mean the fact spans them; read the first, then the rest only if the first is insufficient.
- A tag lists only paths that were present in the search evidence — if a tag looks wrong, verify with `glob` before relying on it.
- Facts without a tag come from non-file backends (work_memory, graph) — follow steps 2-3 for those.

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

## Execution Principle: Attempt Over Deliberation (Cheaply Reversible Actions)

If failure is cheap to recover from, attempt first — do not pre-verify success by reasoning. For actions with immediate error feedback and easy retry (e.g., file edit): just try the action, then use the actual error message as evidence for the next strategy.

- **No exact-match worry**: whitespace/tabs, unicode variants, full-width/half-width characters — these are things the tool reports on failure, not things to predict by inference before executing.
- **Try the simpler approach first**: when torn between two approaches (e.g., edit vs script splice), try the simpler one and switch only if it fails. If your conclusion is "try A, fall back to B", the deliberation spent reaching that conclusion must never be longer than the conclusion itself.
- **Reasoning budget goes to analysis** (reading code, finding bugs, design decisions), not execution mechanics (how exactly to match a string). Judge execution mechanics from tool-call results.
- **Checklist**: if you find yourself writing multiple paragraphs of "what if this fails?" — stop and just execute.
