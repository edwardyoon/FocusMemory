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

Beyond retrieval, FocusMemory maintains **structured execution state (Σ) continuously throughout a long-context session**. Instead of waiting until context exhaustion to extract state, every state-changing turn persists the current state to disk: a `Stop` hook detects when a turn actually changed something (a file edit, a decision recorded) and spawns a detached extraction, with a context-growth fallback for prose-only drift. When `PreCompact` finally occurs, FocusMemory performs one final state extraction before compaction:

`turn: edit → Σ₁ · turn: question → (skip) · 50k growth → Σ₂ · turn: edit → Σ₃ → PreCompact → Σ_final`

While the session runs, a `UserPromptSubmit` hook injects a compact one-line state anchor each turn once the context has grown large enough — and again right after a compaction, until the context regrows — so the model keeps conditioning on explicit state instead of re-deriving it from an ever-growing transcript (or a lossy prose summary).

If the session crashes or the final extraction loses the race with native compaction, the most recent checkpoint can still be restored at `SessionStart`. The amount of uncompacted execution state that can be lost is therefore bounded by the time since the last state-changing turn, not the entire context window.

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
| **Recall** | The winning backend(s) run the search — vector cosine for work_memory/project_facts/decision_chains, keyword payload scroll for graph. Results from multiple backends merge and rerank with intent-aware backend weights + recency decay (decision-style queries rank `decision_chains` above planning docs). |
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
# optional, default 30000 (min 2000) — transcript tail size for extraction
# FOCUSMEMORY_SKILLSTATE_MAX_CHARS=30000
# optional, default 50000 — context growth (tokens) that triggers the Stop fallback
# FOCUSMEMORY_SKILLSTATE_CHECKPOINT_INTERVAL=50000
# optional, default 50000 — context size (tokens) at which the per-turn anchor is injected;
# after a compaction the anchor is injected from compaction until the context regrows past this
# FOCUSMEMORY_SKILLSTATE_INJECT_MIN_TOKENS=50000
```
Off by default — with the flag unset, all hooks return immediately (25–40 ms, zero output); auto-recall and the Hard Gate are untouched.

**How it works** (fail-open throughout — any failure leaves native compaction exactly as-is):

- **Stop (every turn)** records the current context size (`last_input_tokens`, from the `contextUsage` field qwen-code provides on `Stop`) and spawns a *detached* worker when either trigger fires:
  - **state change** (primary) — a mutating tool call (`edit` / `write_file` / `remember_decision`) was logged since the last extraction. Mechanical detection from the tool-call log, no LLM in the hook itself — prose-only turns pay no extraction cost.
  - **context growth** (fallback) — input tokens grew 50k+ past the last extraction, covering semantic drift that touches no file (decisions made in prose only).
- **PreCompact** spawns the same worker as a final pass and exits in milliseconds — native compaction is never blocked. The worker reads the transcript tail (default 30k chars), calls the extraction LLM (MAIN_LLM → SUMMARY_LLM fallback) for a JSON state patch, merges it into Σ (`Σ_{t+1} = Σ_t ⊕ Δ`; null deletes a key), saves it, and dual-writes a `work_memory` checkpoint under a stable per-session point ID — one upserted point, not one per extraction.
- **UserPromptSubmit (every turn)** — once the recorded context size passes the threshold (default 50k input tokens), injects a compact one-line state anchor rendered from Σ (`task | step | pending | files | failing checks`) as `additionalContext`. No LLM call, millisecond-scale — counters lost-in-the-middle dilution in long live sessions. The anchor also covers the post-compaction window: after a compaction the recorded size drops below the threshold, and injection continues until the context regrows past it — exactly the window where the lossy native prose summary is the only "where are we" source. (Context only shrinks via compaction, so once it regrows the plain threshold rule resumes on its own.) If the previous turn's worker is still running, the anchor is one turn stale; harmless, since the live tail of the transcript covers everything since.
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

Internal bookkeeping keys (owned by the hooks, never part of an extraction patch, excluded from the anchor): `last_input_tokens` (context size at the last Stop), `last_checkpoint_tokens` (growth-trigger baseline), `last_extraction_log_bytes` (state-change trigger offset into the tool-call log), `compact_count`.

**Measured overhead:** ~9.8k input tokens (30k rendered tail) per extraction, plus the model's reasoning tokens — runs detached in parallel with native compaction, so it adds no user-facing latency. The extraction calls the chat completions API with `enable_thinking: true`: the model reasons in a separate `reasoning_content` field (discarded) and returns clean JSON in `content`. This replaced the earlier in-prompt `/no_think` token, which the 27B model intermittently ignored — leaking chain-of-thought into the JSON and breaking it (≈20% parse failures on normal tails, ≈100% on tails dominated by prompt-like content). Thinking makes the call slower (tens of seconds vs ~4s) but reliable; the detached worker absorbs the latency.

Extraction can race the native compaction summary; if native compaction finishes first, that round's injection is skipped (fail-open) — Σ still lands for the next compaction and in `work_memory`. Σ files live separately from Hard Gate state (`~/.qwen/tmp/focus-memory/state/`) and are swept by `cleanup-session.js` on `SessionEnd` plus a 7-day stale sweep.

**Observability:** the dashboard (`:8891`) has a dedicated **skill.state** page (sidebar) backed by `GET /api/skillstate` (also on `:3900`) — per-session Σ viewer (the exact injected anchor line, tests pass/fail/pending, full JSON), lifecycle activity counts (Stop checkpoints by trigger, extraction success/failure, anchor injections, post-compact re-injections), and a recent-event timeline. Read-only over the Σ files and the existing gate telemetry JSONL — no extra state, no new write path.

<br>

---

## Declarative Attention (DA)

The auto-recall hook can mark the memory entries it injects as **numbered magic chunks**, so the
[focus-llama](https://github.com/edwardyoon/focus-llama) inference server can restrict the model's
attention to the chunk that actually answers the question. This is the client-side half of the
[Declarative Attention](https://arxiv.org/abs/2609.02737) protocol: FocusMemory assembles the prompt
from its own chunks, so it already knows where each chunk sits — the model decides which chunk to
focus on, and the server enforces it.

**Enable (client side — FocusMemory):**
```bash
# FocusMemory/.env
FOCUSMEMORY_DA=on
```
Off by default — with the flag unset, auto-recall behaves exactly as before (no markers, full
attention). When on, the top up to 5 search entries are wrapped, each truncated to 300 chars.

**How it works** (fail-open throughout — any anomaly leaves the prompt unmarked and the server runs
with full attention):

- **UserPromptSubmit (auto-recall)** — when a search returns 2+ entries, the top entries are wrapped in `[[da:N]]` markers, followed by a `[[da:filler]]` instruction ("identify the chunk containing the answer and output `<focus magic_chunks="N">`") and a `[[da:layout:N]]` footer, appended at the tail of the injected context. The server's `--da-prompt-scan` recovers the chunk-to-token layout from these markers (the legacy `<da:N>`/`<da:filler>`/`<da:layout:N>` form is also accepted server-side; the hook emits the bracket form because angle brackets get mangled by markdown/HTML escaping between the hook and the rendered prompt).
- **Per-session monotonic chunk numbers** — chunk numbers grow monotonically per session, so earlier turns' blocks stay in the conversation history with their own numbers and a chunk number always identifies the same content across turns.
- **Server-side enforcement** — the model emits `<focus magic_chunks="N">` when it commits to a chunk, and the focus-llama server (launched with `--da-prompt-scan`) applies the attention restriction. On the 123 node the server uses backend A (`seq_rm` holes, monotonic).

**Server-side requirement.** DA markers are inert unless the inference server is built from
focus-llama and launched with `--da-prompt-scan` (see the *Production launch* section of the
focus-llama README for the full recommended launch line). Against a stock `llama.cpp` server the
markers are just prompt text — harmless, but no focus is enforced.

**Use `--da-prompt-scan`, not `--da-auto`, for live agent sessions.** The server's `--da-auto`
re-chunks the *entire* conversation on every turn and its tag state machine (tail hold-back +
spec batch cut) has been observed cutting structured output blocks (tool calls) mid-stream — raw
tag text leaks into the response. The hook's marker path is safer: it only marks the injected
memory block at the prompt tail, so DA can never touch the agent's own conversation. Keep
`--da-auto` for headless batch/bench traffic only.

**Skip conditions.** The block is not injected when (a) the flag is off, (b) the search returns
fewer than 2 entries, or (c) any entry's content contains a literal `[[da:` or `<da:` (which would
corrupt the server's numbering check) — in that case the server would fail open anyway, so it is
cleaner to skip the injection.

<br>

---

## Autonomous Todo Execution

`todoRunner.js` turns the task-memory pillar into an autonomous execution loop: register tasks, and a PM2-managed process schedules daily execution, reads the day's task file, and spawns the agent with full memory context.

**Register a task** via the standalone task-registration receiver (`taskReceiver.cjs`, Express on port 8888). The item is appended to the **next day's** todos file (the 06:00 backlog run picks it up in the early morning); the title suffix keeps the actual request date:
```bash
curl -X POST http://127.0.0.1:8888/receive \
  -H 'Content-Type: application/json' \
  -d '{"task":"add a weekly digest email feature to the user panel"}'
# -> { "success": true, "data": { "date": "<next day>", "file": "<next day>.md", "queued": true } }
```
Before formatting, the receiver searches FocusMemory for related context (hard gate), so the generated item is grounded in prior decisions and docs.

**Daily loop (06:00 — backlog run):**
```
06:00 (PM2 timer) → todoRunner.js looks for today's todos/{date}.md
  (the next day's work plan, organized the previous evening)
  → if none: catch-up scan of the last 3 days for unfinished items ([ ]/[~]/[!])
  → spawns qwen agent to process pending items sequentially
  → checkboxes: [ ] → [~] → [x] / [!]
  → final verification: re-reads the file, confirms no pending items remain,
    logs ERROR with the extracted failure reason when any do
  → on completion: autoIngest.js re-indexes
```
The look-back scan picks up the most recent file with unfinished items, so a failed run or a plan written into the previous day's file is never orphaned by a date rollover.

The run time is configurable via `TODO_RUN_TIME=HH:MM` (24h) in `FocusMemory/.env`; unset or invalid values fall back to `06:00`. Changes require `pm2 restart todo-runner`.

**Failure tracking:** `todo_runner_state.json` (next to the runner) keeps `consecutiveFailures`, `lastRun`, and a 30-entry run history — a dead agent is visible in the log and state file instead of silently skipping the day. `--dry-run` reports what the next run would pick up without executing anything.

**Default runner instructions:** no commit/push/deploy (user reviews later the same day), sequential processing only, checkbox progress tracking, local-environment verification only.

```bash
pm2 start FocusMemory/todoRunner.js --name todo-runner   # auto-schedules at TODO_RUN_TIME (default 06:00)
node FocusMemory/todoRunner.js --now                       # manual trigger
node FocusMemory/todoRunner.js --dry-run                   # preview the target file
```

<br>

---

## Garbage collection

Most of the system is self-cleaning: session state files are swept by `cleanup-session.js` (7-day), the gate telemetry JSONL is size-bounded, and every indexer (autoIngest, buildGraph, indexCodeStructure, indexCodeChunks) drops entries for files deleted from disk. Two accumulators are unbounded by design and need time-based retention — `garbageCollect.js` (daily via `config/com.focusmemory.gc.plist`):

| Target | Rule | Why safe |
|---|---|---|
| `todos/YYYY-MM-DD.md` | older than `GC_TODOS_RETENTION_DAYS` → **moved** to `GC_ARCHIVE_DIR/YYYY-MM/` | todos/ is not under version control, so the move keeps it reversible; the archive dir is outside `TODOS_DIR` so autoIngest never re-indexes it, and its deleted-file detection drops the Meilisearch doc. todoRunner only scans the last 3 days. |
| `work_memory` `type=state_checkpoint` | `timestamp` older than `GC_CHECKPOINT_RETENTION_DAYS` → deleted by explicit ID list | one upserted point per session (`checkpointId`); the Σ file on disk is already swept at 7 days, and no recovery path reads checkpoints older than a session's lifetime. |

**Whitelist by construction — never age-pruned:** `decision`/`bug_resolved`/`todo` points and `decision_chains` (causal-chain integrity; `trace_decision_chain` walks `supersedes`/`superseded_by` links, so dropping a node severs the chain — recency decay in reranking already downranks old decisions), and the code index (freshness is managed by file-existence sync, not age).

```
# FocusMemory/.env
GC_ENABLED=on
GC_TODOS_RETENTION_DAYS=30
GC_CHECKPOINT_RETENTION_DAYS=30
GC_ARCHIVE_DIR={your_workspace}/todos_archive
```

```bash
node garbageCollect.js            # live run (requires GC_ENABLED=on)
node garbageCollect.js --dry-run  # report only
```

Every run appends one summary line to `logs/gc.log`. A lock file prevents overlap with a concurrent run (same pattern as autoIngest).

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

**First-time setup without editing `.env` by hand:** once the server is up, open the dashboard → **설정** page, fill in the service URLs (Qdrant, BGE, Meilisearch, LLMs, workspace dirs), press **연결 테스트** to verify each endpoint, then **저장**. Fields that need a restart are flagged, so you know exactly what to restart afterward.

For a full rebuild after schema changes: `npm run auto-ingest --force` (re-ingests all docs/plans and force-reindexes code chunks).

**Dashboard** (auto-launches alongside the MCP server): `http://localhost:8891`, refreshing every 30s. Left sidebar with four pages: **통계** (summary bar + Chart.js overview charts — Qdrant/Meilisearch per-collection bar charts, read hard-gate and write-back-gate doughnuts — plus per-backend collection cards and system info), **skill.state** (Σ lifecycle, see Observability above), **todos** (day TODO TOC from `TODOS_DIR`), and **설정** (settings). Hash-based routing (`#/stats`, `#/skillstate`, `#/todos`, `#/config`) so refresh keeps the current page. Chart.js is vendored locally (`web/chart.umd.min.js`, no CDN). JSON stats at `/api/stats` on both port 8891 and 3900. Override with `DASHBOARD_PORT`.

**Settings page** — edit `.env` from the browser instead of by hand: grouped fields (service URLs, LLM, workspace dirs, SKILL.state, GC, runner/auth) with per-field validation, a **연결 테스트** button that probes Qdrant/Meilisearch/BGE/SUMMARY_LLM/MAIN_LLM/SearXNG (using the form's current values, so a configuration can be validated before saving), and **저장** which rewrites `.env` in place (comments preserved, atomic tmp+rename). Each field is badged with when the change takes effect — **즉시** (hooks/launchd jobs re-read `.env` per run), **재시작** (captured at MCP server start → restart the qwen-code session), or **프로세스** (a PM2 process caches it → the note carries the command, e.g. `pm2 restart todo-runner`). Sensitive values (`MEILI_MASTER_KEY`, `CONTEXT_API_TOKEN`) are masked; leaving them blank keeps the existing value. Save and connection-test require the API token (`CONTEXT_API_TOKEN`), same as `/v1/context/search`; reads stay open. The dashboard binds to `127.0.0.1` by default — set `DASHBOARD_HOST=0.0.0.0` to expose it on the LAN (write endpoints stay token-gated).

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
| `focus` | Fetch the complete original of a designated chunk by `file_path`+`entity_name` (or a point UUID) — the "focus" step after `search_code`'s cheap index; returns just the chunk, not the whole file |
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
The highest-scoring backend wins; if the top two are within ε=0.15, a parallel search runs instead. Causal keywords ("why", "decision", "changed from") score higher against `decision_chains`.

**Reranking** — whenever results come from 2+ backends, they merge and rerank: `cosine × backend_weight × recency`. Weights are intent-aware — for decision-style queries (causal/temporal, non-knowledge) `decision_chains` (1.3) and `work_memory` (1.2) outrank `project_facts` (1.0), so "what did we decide" queries surface decision records above planning docs; all other queries keep `project_facts` at 1.3. Superseded decisions take a ×0.15 penalty.

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
├── garbageCollect.js       # Time-based retention (todos archive + state_checkpoint prune)
├── todoRunner.js           # Autonomous TODO execution runner
├── taskReceiver.cjs        # Task registration HTTP receiver (port 8888)
├── meilisearch.js          # MeiliSearch indexer for docs/plans
├── lib/
│   ├── utils.js             # scanFiles, routeQuery, pruneAndSummarize, extractQueryFeatures
│   ├── config.js            # Dashboard settings: .env read/write (comment-preserving) + connection tests
│   └── codesearch/          # Code chunk extraction & indexing (+ orphan cleanup for deleted files)
├── scripts/                 # createCollection, buildGraph, indexCodeStructure, testSearch
├── web/                      # Dashboard UI (port 8891) — dashboard.html (통계/skill.state/todos/설정) + chart.umd.min.js (vendored Chart.js)
├── config/                   # launchd jobs (autoingest, gc)
├── qwen-extension.json       # Extension manifest (mcpServers + hooks)
├── AGENTS.md                 # Hard Gate search protocol (agent context)
├── hooks/                     # UserPromptSubmit / PreToolUse / PreCompact / SessionStart / Stop / SessionEnd
│   ├── check-memory-first.js  # PreToolUse: deny grep/glob if memory not called
│   ├── check-writeback.js     # Stop: detect completion, ask to record decision
│   ├── log-tool-call.js       # PreToolUse: track tool calls and state flags
│   ├── reset-memory-flag.js   # UserPromptSubmit: reset turn-level flags
│   ├── userprompt-inject-state.js    # SKILL.state: per-turn state anchor injection
│   ├── precompact-extract-state.js   # SKILL.state: spawn detached Σ extraction worker
│   ├── sessionstart-inject-state.js  # SKILL.state: re-inject Σ after compaction
│   ├── stop-checkpoint-state.js      # SKILL.state: per-Stop state-change + growth checkpoints
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