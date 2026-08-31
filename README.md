<div align="center">

# FocusMemory

> **Grep finds code. Vectors find meaning. I remember why — and what to do next.**

**Memory-based agent workflow management.**

Optimized for Qwen Code

</div>

```
       /\_/\
      ( o.o )   "Grep finds code.
       > ^ <     Vectors find meaning.
      /     \    I remember why —
     | |   | |   and what to do next."
     (_)_)(_)=[]=============>  (FocusMemory Katana)
```

Grep finds the code. Vectors find the meaning. Neither remembers why the code exists, which decisions shaped it, or what the agent was doing when the context disappears.

When a long-context session compacts, even the work that just happened can collapse into a lossy prose summary. FocusMemory preserves that missing layer as structured execution state, so the agent can resume from what it actually knew and was doing — not from a reconstruction of what probably happened.

FocusMemory provides a persistent memory and execution-state layer for AI coding agents, combining semantic search, full-text retrieval, project knowledge, and structured session state behind a single MCP server.

Beyond retrieval, FocusMemory maintains **structured execution state (Σ) continuously throughout a long-context session**. Instead of waiting until context exhaustion to extract state, every checkpoint periodically persists the current state to disk. When `PreCompact` finally occurs, FocusMemory performs one final state extraction before compaction:

`50k → Σ₁ → 100k → Σ₂ → 150k → Σ₃ → PreCompact → Σ_final`

If the session crashes or the final extraction loses the race with native compaction, the most recent checkpoint can still be restored at `SessionStart`. The amount of uncompacted execution state that can be lost is therefore bounded by the checkpoint interval, not the entire context window.

This is particularly useful for **extreme long-context local inference**: rather than reserving excessive VRAM for high-precision KV cache, FocusMemory lets the inference engine push the KV cache toward lower-bit quantization. Persisted state acts as a durable checkpoint above that lossy KV layer — information that degrades in aggressively quantized KV cache can be recovered from explicitly persisted state instead.

**Four separated concerns:**

* **KV cache** — maximize working context that fits in VRAM, even with aggressive quantization.
* **Structured state (Σ)** — preserve the session's semantic state independently of the transient context window.
* **PreCompact** — checkpoint state before the context is compacted.
* **MCP knowledge base** — durable project knowledge that doesn't depend on the current context window at all.

### Four pillars

| Pillar | What it manages | Backend |
|--------|----------------|---------|
| **Source code structure & semantic search** | Function graph, code chunks, natural-language code queries | Qdrant `code_chunks` + tree-sitter AST graph |
| **Work history memory** | Decisions, bug fixes, session outcomes, causal chains | Qdrant `work_memory` + `decision_chains` |
| **Task memory** | TODO items, daily execution plans, progress tracking | `todos/` folder + Meilisearch full-text |
| **Context state across compaction** | Structured execution state (Σ) — extracted pre-compaction, re-injected post-compaction | SKILL.state hooks + `work_memory` checkpoints |

Each session shares source code, work history, upcoming tasks, and live execution state as a single memory — the same world-understanding the user has. That cuts the biggest token sinks: repeated grep/glob discovery, re-derived architectural rationale, cold-boot sessions with no context, and compaction amnesia.

> Without enforcement, even an agent with memory available repeats grep → read → reason → retry, because prompt-level instructions are optional, not physical constraints. FocusMemory closes that gap with a `PreToolUse` hard gate.

<br>

---

## Lifecycle

| Stage | What happens |
|---|---|
| **Ingest** | Docs, plans, and code are chunked (LLM for docs, tree-sitter for JS), embedded with BGE-M3, and upserted to Qdrant. Incremental via mtime/SHA-256 state tracking (`autoIngest.js`, cron-safe). |
| **Route** | Each query is decomposed into signals (causal, temporal, structural, identifier ratio). A scoring function ranks all backends; the winner executes alone, or a parallel search + rerank fires if the top two scores are within ε=0.15. |
| **Recall** | The winning backend(s) run the search — vector cosine for work_memory/project_facts/decision_chains, keyword payload scroll for graph. Results merge and rerank with recency decay. |
| **Prune** | A local LLM (SUMMARY_LLM) strips noise from raw top-N results before anything reaches the agent prompt — compresses 10–15 raw hits into core facts. Falls back to raw output if SUMMARY_LLM is unavailable. |
| **Commit** | New decisions are written into `work_memory` and `decision_chains` as linked nodes (`topic_key`, `reasoning`, `file_paths`). Topic key is auto-inferred via embedding similarity, with LLM classification as fallback. |
| **Supersede** | When a new decision shares a `topic_key` with an active node, embedding similarity is computed. Single candidate ≥ 0.8 or best-of-many ≥ 0.85 triggers auto-supersede — the old node is marked `superseded` and linked forward. |
| **Trace** | `trace_decision_chain` walks the causal graph in either direction — backward via `supersedes`, forward via `superseded_by` — returning the full chronological history. |

### Measured impact

| Stage | Without FocusMemory | With FocusMemory |
|---|---|---|
| Discovery | `grep_search` → `glob` → `read_file` (2–4 calls) | `search_memory` routing to pre-indexed backends (1 call) |
| Context load | Raw file content (~5,000 tokens/file × N) | Pruned summary via SUMMARY_LLM (~800 tokens) |
| Retry on poor results | Agent retries with different tools | Fallback chain auto-retries in the same call |

**Net effect**: avg tool calls/query 3.5 → 1.8, response time 25s → 8s.
*(Measured on a ~200k LOC / ~1,500 file mixed-language codebase, 50 representative queries, averaged over 3 runs. Individual results vary by project size and query complexity.)*

Without a physical gate, models still fall back to `grep_search`/`glob` out of habit — prompt-level instructions (AGENTS.md) are cooperative, not enforced. See **Hard Gate** below for how this is closed at the tool-execution layer.

<br>

---

## Hard Gate — enforcement, not suggestion

Two enforcement points, plus one prompt-level convention:

| Phase | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Session/turn start** | `UserPromptSubmit` HTTP hook auto-recalls context from Qdrant before the agent loop starts | System-level — no model cooperation required |
| **Mid-turn (read-side)** | `PreToolUse` denies `grep_search`/`glob` until `search_memory` has run this turn | Physical block (`permissionDecision: deny`) |
| **Turn end (write-side)** | `Stop` hook detects a completed code change + a completion signal, then asks the user whether to `remember_decision` | System-level checkpoint, user has final say (`decision: ask`) |
| Mid-workflow | AGENTS.md instructs "search_memory first" | Prompt-level guidance only — model may ignore |

**Flow:**

```
User prompt → auto-recall (HTTP hook) + turn epoch bump (parallel, order-independent)
  → context injected, turn stamped — or grep/glob stay blocked
  → Agent calls search_memory if not already stamped → turn stamped → gate opens
  → Code work (edit/write_file) → tracked
  → Stop hook: code change + completion signal + no decision recorded yet → ask user
  → "Yes" → remember_decision written to Qdrant
```

**State file** (`~/.qwen/tmp/tool-calls/<session_id>.json`):
```json
{ "turnEpoch": 7, "memoryCalledEpoch": 7, "satisfiedBy": "auto_recall", "decisionRecorded": false }
```
The gate passes only when `memoryCalledEpoch === turnEpoch` — a stamp from an earlier turn can never satisfy a later one (e.g. if auto-recall fails on a new turn, the gate stays closed until an explicit `search_memory` call). Concurrent writers (the millisecond-scale epoch reset and the seconds-later HTTP recall) are serialized through a lockfile in `lib/state.js`; the commit itself is atomic (tmp + rename).

**Known edge cases:**
- Explicit file path in the tool call bypasses the gate (`reason: explicit_file_path_bypass`)
- Queries under 10 chars, pure math, or greetings skip backend lookups entirely (`isTrivialQuery()`) but still count as satisfying the gate
- Any hook crash or malformed input **fails open** — the call is allowed. This includes a dangling symlink from a moved repo: the hook exits 1, and because command hooks are non-blocking, the gate silently stops denying with no visible error. Verify after any repo restructure:
  ```bash
  ls -laL ~/.qwen/extensions/focus-memory/hooks/
  ```
- Telemetry for every gate decision: `~/.qwen/tmp/focus-memory/gate-telemetry.jsonl` (size-bounded, truncated to last 1000 lines past 512 KB)

<br>

---

## SKILL.state — execution state across compaction

Long sessions get compacted: qwen-code replaces the conversation with a lossy prose summary. SKILL.state (based on [arXiv:2608.26263]) extracts a **structured state patch (Σ)** from the pre-compaction transcript and re-injects it after compaction, so the agent resumes from explicit state instead of reconstructed history.

**Enable:**
```bash
# FocusMemory/.env
FOCUSMEMORY_SKILLSTATE=on
# optional, default 30000 (min 2000)
# FOCUSMEMORY_SKILLSTATE_MAX_CHARS=30000
```
Off by default — with the flag unset, both hooks return immediately (25–40 ms, zero output); auto-recall and the Hard Gate are untouched.

**How it works** (fail-open throughout — any failure leaves native compaction exactly as-is):

- **PreCompact** spawns a *detached* worker and exits in milliseconds — native compaction is never blocked. The worker reads the transcript tail (default 30k chars), calls the extraction LLM (MAIN_LLM → SUMMARY_LLM fallback) for a JSON state patch, merges it into Σ (`Σ_{t+1} = Σ_t ⊕ Δ`; null deletes a key), saves it, and dual-writes a `work_memory` checkpoint.
- **Periodic checkpoints**: a `Stop` hook spawns the same worker whenever context grows 50k+ tokens past the last checkpoint (using the `contextUsage` field qwen-code already provides on `Stop`), so a 200k session lands warm checkpoints at ~50k/100k/150k before compaction ever fires.
- **SessionStart** (`compact` only) loads Σ and injects it as `additionalContext`, preferred over the native prose summary for "where are we" questions.

**Σ schema:**

| Key | Merge rule |
|---|---|
| `task_summary` | replace |
| `current_step` | replace |
| `pending_checks` | replace (snapshot) |
| `files_touched` | union, capped at 50 |
| `decisions` | union, capped at 50 |
| `tests_status` | merge (`{ "<check>": "pass\|fail\|pending" }`) |

**Measured overhead:** ~9.8k input tokens (30k rendered tail) + ~387 output tokens per extraction, median 3.6s — runs detached in parallel with native compaction, so it adds no user-facing latency. (`/no_think` disables the Qwen3 thinking pass for this mechanical extraction step: cut the call from ~12.6s to ~3.6s and output tokens from ~1,147 to ~387, with patch quality preserved across a 5-sample check.)

Extraction can race the native compaction summary; if native compaction finishes first, that round's injection is skipped (fail-open) — Σ still lands for the next compaction and in `work_memory`. Σ files live separately from Hard Gate state (`~/.qwen/tmp/focus-memory/state/`) and are swept by `cleanup-session.js` on `SessionEnd` plus a 7-day stale sweep.

<br>

---

## Autonomous Todo Execution

`todoRunner.js` turns the task-memory pillar into an autonomous execution loop: register tasks, and a PM2-managed process schedules daily execution, reads the day's task file, and spawns the agent with full memory context.

**Register a task** via the standalone task-registration receiver (`taskReceiver.cjs`, Express on port 8888):
```bash
curl -X POST http://127.0.0.1:8888/receive \
  -H 'Content-Type: application/json' \
  -d '{"task":"add a weekly digest email feature to the user panel"}'
# -> { "success": true, "data": { "date": "...", "file": "....md", "queued": true } }
```
Before formatting, the receiver searches FocusMemory for related context (hard gate), so the generated item is grounded in prior decisions and docs.

**Daily loop:**
```
23:40 (PM2 timer) → todoRunner.js checks todos/{date}.md
  → spawns qwen agent to process [ ] items sequentially
  → checkboxes: [ ] → [~] → [x] / [!]
  → on completion: autoIngest.js re-indexes
```

**Default runner instructions:** no commit/push/deploy (user reviews next morning), sequential processing only, checkbox progress tracking, local-environment verification only.

```bash
pm2 start FocusMemory/todoRunner.js --name todo-runner   # auto-schedules at 23:40
node FocusMemory/todoRunner.js --now                       # manual trigger
```

<br>

---

## Quick start

```bash
# 1. Initialize workspace (creates docs/, plans/, .focusmemoryignore)
npm install
node init.js /path/to/your/project

# 2. Create Qdrant collections
npm run create-collections

# 3. Initial ingest
npm run auto-ingest --force

# 4. Continuous indexing — cron every 5 min (incremental via mtime/SHA-256 state)
*/5 * * * * cd /path/to/FocusMemory && npm run auto-ingest >> /var/log/focusmemory.log 2>&1

# 5. Start the MCP server
QDRANT_URL=http://localhost:6333 \
BGE_URL=http://localhost:8080/v1/embeddings \
npm start
```

For a full rebuild after schema changes: `npm run auto-ingest --force` (re-ingests all docs/plans and force-reindexes code chunks).

**Dashboard** (auto-launches alongside the MCP server): `http://localhost:8891`, refreshing every 30s. JSON stats at `/api/stats` on both port 8891 and 3900. Override with `DASHBOARD_PORT`.

### Qwen Code extension install

```bash
mkdir -p ~/.qwen/extensions
ln -sf /path/to/FocusMemory ~/.qwen/extensions/focus-memory
```
`${extensionPath}` references in the manifest resolve relative to this symlink. qwen-code spawns `node index.js` via stdio automatically — don't start the server manually (port conflicts on 3900/8891). VS Code IDE users additionally need:
```bash
echo '{"focus-memory": true}' > ~/.qwen/extensions/extension-enablement.json
```
(CLI mode loads extensions automatically; this step isn't needed there.)

For Kilo Code or other clients without extension support, start the HTTP server directly:
```bash
QDRANT_URL=http://localhost:6333 BGE_URL=http://localhost:8080/v1/embeddings \
SUMMARY_LLM_URL=http://localhost:8081/v1/completions HTTP_PORT=3900 \
CONTEXT_API_TOKEN=focus-memory-local node index.js &
```

> **Hooks are registered in exactly one place** — the extension manifest (`qwen-extension.json`). Registering the same scripts again in `~/.qwen/settings.json` fires every command hook twice per event (doubled telemetry, doubled LLM cost for embedding/extraction hooks). Keep one execution path.

<br>

---

## Available tools

| Tool | Purpose |
|---|---|
| `search_memory` | Unified — scoring-based routing across work_memory, project_facts, graph, code_chunks, decision_chains + prune & summarize |
| `trace_decision_chain` | Walk a decision's full causal history (what superseded it, why, what came after) |
| `search_work_memory` | Past decisions, resolved issues, open todos (direct) |
| `search_project_facts` | DB schemas, infra topology, API specs (direct) |
| `search_code` | Natural-language search over JS/TS/Python/PHP function bodies |
| `query_graph` | Code graph: "who calls X?", functions in file Y, dependencies |
| `remember_decision` | Write a new decision into work_memory + decision_chains (reasoning, topic_key, supersedes links) |
| `search_web` | Web search via local search server |

<br>

---

## How routing & pruning work

**Query routing** — each query is scored per backend:
```
score(backend, query) = 0.5 · similarity + 0.4 · feature_fit + 0.1 · recency_prior
```
The highest-scoring backend wins; if the top two are within ε=0.15, a parallel search with reranking runs instead. Causal keywords ("why", "decision", "changed from") score higher against `decision_chains`.

**Causal decision chains** — every decision written via `remember_decision` becomes a graph node carrying `supersedes` (what it replaced) and `caused_by` (what led to it). `trace_decision_chain` walks both directions, returning the full history with reasoning — architectural archaeology as a graph traversal instead of a chat-log dig. Decisions are dual-written to `work_memory` for backward compatibility; reverse links (`superseded_by`) update automatically.

**Semantic code search** — JS/TS/Python/PHP files are parsed (tree-sitter for JS, regex fallback otherwise) into function/method chunks, embedded with BGE-M3, and stored in `code_chunks`. Incremental indexing compares SHA-256 content hashes — only changed files re-embed.

<br>

---

## Project structure

```
FocusMemory/
├── index.js                # MCP stdio + Hono HTTP — 8 tools, /v1/context/search
├── init.js                 # Workspace initializer
├── autoIngest.js           # Incremental doc/plan/todo ingest + code chunk reindex
├── todoRunner.js           # Autonomous TODO execution runner
├── taskReceiver.cjs        # Task registration HTTP receiver (port 8888)
├── meilisearch.js          # MeiliSearch indexer for docs/plans
├── lib/
│   ├── utils.js             # scanFiles, routeQuery, pruneAndSummarize, extractQueryFeatures
│   └── codesearch/          # Code chunk extraction & indexing
├── scripts/                 # createCollection, buildGraph, indexCodeStructure, testSearch
├── web/                      # Dashboard UI (port 8891)
├── config/                   # launchd cron job
├── qwen-extension.json       # Extension manifest (mcpServers + hooks)
├── AGENTS.md                 # Hard Gate search protocol (agent context)
├── hooks/                     # UserPromptSubmit / PreToolUse / PreCompact / SessionStart / Stop / SessionEnd
│   ├── check-memory-first.js  # PreToolUse: deny grep/glob if memory not called
│   ├── check-writeback.js     # Stop: detect completion, ask to record decision
│   ├── log-tool-call.js       # PreToolUse: track tool calls and state flags
│   ├── reset-memory-flag.js   # UserPromptSubmit: reset turn-level flags
│   ├── precompact-extract-state.js   # SKILL.state: spawn detached Σ extraction worker
│   ├── sessionstart-inject-state.js  # SKILL.state: re-inject Σ after compaction
│   ├── stop-checkpoint-state.js      # SKILL.state: periodic warm checkpoints
│   ├── cleanup-session.js     # SessionEnd: per-session + 7-day sweep
│   └── lib/                   # state.js (locking, atomic write, telemetry), skillstate.js (Σ merge, extraction)
├── docs/ plans/               # Project knowledge inputs (created by init.js)
└── LICENSE, package.json, README.md
```

> qwen-code expects `qwen-extension.json` and `AGENTS.md` at the top level of the symlink target — that's why the extension files live directly under the repo root.

<br>

---

## Design principles

1. **Local-first** — no cloud dependency; code, schema, and decisions stay on your infrastructure.
2. **Zero upstream modifications** — uses only qwen-code's native Extension/Hook system; upgrades are safe.
3. **Hard Gate is enforced, not suggested** — read-side via PreToolUse blocks, write-side via Stop-hook prompts with user confirmation.
4. **Stay out of the inference path** — context is prepared before prompt assembly; no added latency during tool execution.
5. **Incremental by default** — only changed files trigger reprocessing; cron-safe idempotent operations.

<br>

---

<div align="center">

`SELF-HOSTED / MIT`

</div>