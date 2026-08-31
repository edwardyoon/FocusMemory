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

Grep finds the code. Vectors find the meaning. Neither remembers the decision that made it true — or why it was written that way in the first place. And when the context window compacts, even what the session just did is reduced to a lossy prose summary — unless the execution state was captured.

FocusMemory turns your workspace into a **living knowledge base** for AI coding agents. It pre-indexes business decisions, project documentation, code structure, and semantic history into Qdrant (vector), Meilisearch (full-text), and a lightweight summary LLM — then exposes them through a single MCP server with intelligent routing. Beyond retrieval, it manages **context state across compaction** in the form of [SKILL.state](#skillstate--structured-execution-state-across-compaction): the session's structured execution state (Σ) is extracted before compaction and re-injected after, so the agent resumes from explicit state, not a lossy summary.

### Four pillars

| Pillar | What it manages | Backend |
|--------|----------------|---------|
| **Source code structure & semantic search** | Function graph, code chunks, natural-language code queries | Qdrant `code_chunks` + tree-sitter AST graph |
| **Work history memory** | Decisions, bug fixes, session outcomes, causal chains | Qdrant `work_memory` + `decision_chains` |
| **Task memory** | TODO items, daily execution plans, progress tracking | `todos/` folder + Meilisearch full-text |
| **Context state across compaction** | Structured execution state (Σ) — files touched, pending checks, decisions — extracted pre-compaction, re-injected post-compaction | SKILL.state (PreCompact/SessionStart hooks + extraction LLM) + `work_memory` checkpoints |

### The killer feature

Each work session is not a disconnected context. FocusMemory manages source code, work execution history, upcoming tasks, **and the session's live execution state** as a single shared memory, giving the agent the same world understanding as the user.

This eliminates the biggest token sinks:
- **grep/glob** — the agent recalls pre-indexed structure instead of re-discovering files
- **Excessive thinking** — architectural rationale and prior decisions are recalled, not re-derived
- **Cold boot** — new sessions start with full context, not an empty context window
- **Compaction amnesia** — execution state (files touched, pending checks, decisions) is extracted to Σ and re-injected, so a compacted session resumes from explicit state, not a lossy summary

Think of it as an **onboarding process your agent never forgets**: new sessions start with full context about past decisions, architectural rationale, code dependencies, and how the system evolved — without burning tokens on repetitive file discovery.

> **Token waste in source exploration** is the hidden cost of AI-assisted development. Without enforcement, even an agent with memory available repeats this loop: grep → read → reason → retry — because prompt-level instructions are optional, not physical constraints. FocusMemory closes that gap with a `PreToolUse` hard gate, making token savings guaranteed rather than best-effort.

<br>

---

## Lifecycle

FocusMemory moves through the same loop on every query:

| Stage | What happens | Status |
|---|---|---|
| **Ingest** | Docs, plans, and code get chunked (LLM for docs, tree-sitter for JS), embedded with BGE-M3, and upserted to Qdrant. Incremental via mtime/SHA-256 state tracking (`autoIngest.js`, cron-safe). | ✅ implemented |
| **Route** | Each query is decomposed into signals (causal, temporal, structural, identifier ratio). A scoring function ranks all backends; the winner executes alone, or a parallel search + rerank fires if top-two scores are within ε=0.15 (`utils.js` `routeQuery()`). | ✅ implemented |
| **Recall** | The winning backend(s) run the search — vector cosine for work_memory/project_facts/decision_chains, keyword payload scroll for graph. Results are merged and reranked with recency decay (`index.js` `search_memory`). | ✅ implemented |
| **Prune** | A local LLM (SUMMARY_LLM — Bonsai 27B / Gemma 4 31B) strips noise from raw top-N results before anything reaches the agent prompt. Compresses 10~15 raw hits into core facts. Graceful fallback to raw output if SUMMARY_LLM is unavailable (`utils.js` `pruneAndSummarize()`). | ✅ implemented |
| **Commit** | New decisions are written into both `work_memory` and `decision_chains` as linked nodes with `topic_key`, `reasoning`, and `file_paths`. Topic key is auto-inferred via embedding similarity against existing topics, with LLM classification fallback (`index.js` `remember_decision`). | ✅ implemented |
| **Supersede** | When a new decision shares a topic_key with an active node, embedding similarity is computed automatically. Single candidate ≥ 0.8 or best-of-many ≥ 0.85 triggers auto-supersede — old node gets `status: "superseded"` and linked forward via `superseded_by`. Explicit `supersedes` param still supported for manual override (`index.js` `remember_decision`). | ✅ implemented |
| **Trace** | Walk the causal chain in either direction — backward via `supersedes`, forward via `superseded_by` — returning full chronological history with reasoning. No LLM summarization; structure preserved as-is (`index.js` `trace_decision_chain`). | ✅ implemented |

Grep can't do any of this. It doesn't route, it doesn't prune, and it has no idea what superseded what.

### How FocusMemory eliminates token waste in source exploration

An AI agent without pre-indexed memory repeats this loop: grep → read → reason → retry. Each round-trip burns context tokens, inflates VRAM usage, and adds latency. FocusMemory replaces on-demand file discovery with **pre-indexed recall**:

| Stage | Without FocusMemory | With FocusMemory | Saved per query |
|---|---|---|---|
| Discovery | `grep_search` → `glob` → `read_file` (2–4 calls) | `search_memory` routing to pre-indexed backends (1 call) | ~3 tool calls |
| Context load | Raw file content (~5,000 tokens/file × N files) | Pruned summary via SUMMARY_LLM (~800 tokens) | ~70% context tokens |
| Retry on poor results | Agent retries with different tools | Fallback chain auto-retries unsearched backends in same call | ~1 round-trip (~5s) |

**Net effect**: average tool calls per query 3.5 → 1.8 (~49%), response time 25s → 8s (~68%).

> *Benchmark methodology: measured on a mid-size mixed-language codebase (~200k LOC, ~1,500 files) with 50 representative queries (causal reasoning, code graph lookup, project fact retrieval). Tool calls and latency averaged across 3 runs. Individual results vary by project size and query complexity.*

### Why enforcement matters, not just availability

Making `search_memory` available isn't enough — a model will still reach for `grep_search`/`glob` out of habit unless it's physically prevented from doing so. Prompt-level instructions (AGENTS.md) are cooperative, not enforced: a model under context pressure or with weak instruction-following will skip straight to grep regardless of what the system prompt says.

The `PreToolUse` hook closes this gap. `grep_search`/`glob` calls are denied at the tool-execution layer — before the shell ever runs — until `search_memory` has been called in the current turn. This turns the token savings above from a best-effort suggestion into a guaranteed floor: the agent physically cannot fall back into a grep → read → reason → retry loop while the Hard Gate is active.

| State | Tool calls/query | Why |
|---|---|---|
| MCP tools available (no gate) | ~3.5 | Model ignores prompt instructions, falls back to grep-first habit |
| PreToolUse hard gate active | 1.8 | `grep_search`/`glob` physically blocked until `search_memory` runs first |

The benchmark numbers above reflect the **hard gate active** state. Without enforcement, savings are model-dependent and unreliable.

### Write-back enforcement (Stop hook)

FocusMemory now enforces write-back symmetry with read-side enforcement. The `Stop` hook fires once per turn when the model finishes its response, detecting completion signals (`last_assistant_message`) combined with code changes in the tool log — then asks the user whether to record decisions via `remember_decision`. This turns "forgetting to save important work" from a prompt-level reminder into a system-level checkpoint.

| Signal | Source | Example |
|---|---|---|
| Code change detected | Tool log (`edit`, `write_file`) | Any file modification in the turn |
| Completion signal | `last_assistant_message` patterns | "tests passed", "bug fixed", "ready to commit" |
| User confirmation | `decision: ask` → user responds | "Yes" → `remember_decision` called; "No" → skipped, no re-ask on same work unit |

The write-back gate is conservative by design — both a code change AND a completion signal must be present. The user has final say via the `ask` decision, eliminating false positives that plague fully automated approaches. Once recorded (or explicitly declined), the flag persists across turns until new code edits start a fresh work unit.

<br>

---

## What it does

| Capability | How |
|---|---|
| **Causal decision chains** | Decisions stored as linked nodes with `supersedes`/`superseded_by` — trace the full "why" history of any architectural choice, from original rationale through every replacement |
| **Work history** | Decisions, bug fixes, resolved issues — written back after each session so the next agent starts where the last left off |
| **Project knowledge** | Docs and plans chunked, embedded, and searchable via vector similarity |
| **Semantic code search** | Natural-language queries against JS/TS/Python/PHP function bodies using BGE-M3 embeddings |
| **Code graph** | tree-sitter AST parsing → function nodes + call edges for "who calls X?" questions |
| **Smart routing** | Scoring-based query router dispatches to the right backend (vector vs keyword vs decision chain) automatically |

<br>

---

## Autonomous Todo Execution

FocusMemory's `todoRunner.js` turns the **task memory** pillar into an autonomous execution loop. You register tasks first (below); a PM2-managed process then schedules daily execution, reads the day's task file, and spawns the agent with full memory context.

### Registering tasks

Tasks enter through the **task registration receiver** (`taskReceiver.cjs`) — a standalone Express server on port 8888, run as `pm2 task-receiver`. Send free-form task text; it is formatted into a `## [ ]` item in the day's todos file, which the daily runner (below) then executes.

```bash
# Register a task (fire-and-forget — returns immediately; formatting runs in the background)
curl -X POST http://127.0.0.1:8888/receive \
  -H 'Content-Type: application/json' \
  -d '{"task":"add a weekly digest email feature to the user panel"}'
# -> { "success": true, "data": { "date": "2026-08-24", "file": "2026-08-24.md", "queued": true } }
```

Before formatting, the receiver searches FocusMemory for related business context (hard gate), so the generated item is grounded in prior decisions and docs. The full API (`/receive`, `/toc`, `/ping`) is documented in the `taskReceiver.cjs` header.

### How it works

```
23:40 daily (PM2 timer)
  │
  ▼
todoRunner.js checks todos/{YYYY-MM-DD}.md
  │ (no file or no [ ] / [~] items → exit)
  ▼
Spawns: qwen -p "{DEFAULT_INSTRUCTIONS} + Read today's TODO file... execute items in order" -y
  │
  ▼
Agent reads the file, processes items sequentially, updates checkboxes:
  [ ] → [~] (in progress) → [x] (done) or [!] (interrupted)
  │
  ▼
On completion: triggers autoIngest.js → FocusMemory index updated
```

### Folder structure

```
todos/
├── 2026-08-22.md    # Today's execution plan (agent reads/writes checkboxes)
├── 2026-08-21.md    # Yesterday (completed, indexed by FocusMemory)
└── done/            # Archived completed tasks
```

- **`todos/`** — daily execution files (short-lived, agent's working surface)
- **`plans/`** — design docs, long-lived reference (architectural decisions, specs)
- **`docs/`** — schemas, API specs, impact analyses

### Default instructions

The runner injects a fixed set of operational instructions into every execution prompt:

- No commit, push, or deploy — changes reviewed by the user next morning
- Sequential processing (one item at a time, no parallel sub-agents)
- Progress tracking via checkbox state (`[ ]` → `[~]` → `[x]` / `[!]`)
- Verification in local environment only (production is read-only)

### Running

```bash
# PM2-managed (auto-schedules at 23:40)
pm2 start FocusMemory/todoRunner.js --name todo-runner

# Manual trigger (run now, then continue scheduling)
node FocusMemory/todoRunner.js --now
```

Logs: `logs/todo-{YYYY-MM-DD}.log`

<br>

---

## Quick start

### 1. Initialize workspace

```bash
npm install
node init.js /path/to/your/project
```

`init.js` creates the required folder structure in your project root:

```
your-project/
├── docs/              # Drop legacy/markdown knowledge here (schemas, API specs, etc.)
│   └── .gitkeep
├── plans/             # Work plans and session history
│   ├── active.md      # Current work plan template
│   └── done/          # Completed sessions go here
│       └── .gitkeep
└── .focusmemoryignore # Indexing exclusion rules (auto-generated)
```

### 2. Create Qdrant collections

```bash
npm run create-collections
```

Creates `work_memory`, `project_facts`, `graph_nodes`, `graph_edges`, `code_chunks`, and `decision_chains` with payload indexes.

### 3. Ingest docs + plans (one-time)

```bash
# Initial full ingest of all docs/*.md and plans/*.md
npm run auto-ingest --force
```

Drop legacy project documents as markdown files into `docs/`. Each file is chunked by a local LLM, embedded with BGE-M3, and stored in Qdrant for semantic search.

### 4. Set up cron job for continuous indexing

Run `auto-ingest` periodically (e.g., every 5 minutes via crontab or launchd):

```bash
# Crontab example — runs every 5 minutes
*/5 * * * * cd /path/to/FocusMemory && npm run auto-ingest >> /var/log/focusmemory.log 2>&1
```

`auto-ingest` is incremental by default: it compares file modification times against a state file (`ingest_state.json`) and only re-processes new or changed files. It also runs the **semantic code chunk indexer** automatically, so your `.js`, `.ts`, `.py`, and `.php` functions stay up to date without manual intervention.

For a full rebuild (after schema changes or collection corruption):

```bash
npm run auto-ingest --force    # re-ingest all docs/plans + force-reindex code chunks
```

### 5. Start the MCP server

```bash
QDRANT_URL=http://localhost:6333 \
BGE_URL=http://localhost:8080/v1/embeddings \
npm start
```

Configure your client (Qwen Code, Kilo Code) to connect via stdio transport and you get eight tools available in the agent loop.

### 6. Enable extension in VS Code IDE (not needed for CLI)

See **Extension Installation → Step 4** below for the `extension-enablement.json` setup. This step is only required when running Qwen Code inside VS Code IDE; CLI mode loads extensions automatically.

### 7. Open Dashboard (optional)

When the MCP server starts on port 3900, a **dashboard UI** also launches on port **8891**:

```
http://localhost:8891
```

The dashboard shows real-time stats from your Qdrant and Meilisearch backends:

| Metric | Source |
|---|---|
| Total Points / Collections | Qdrant (`work_memory`, `code_chunks`, etc.) |
| Documents / Indexes | Meilisearch (docs/plans, code structure) |
| System Info | Node version, uptime, service versions |

The page auto-refreshes every 30 seconds. Customize the port via `DASHBOARD_PORT` environment variable:

```bash
DASHBOARD_PORT=9100 npm start  # Dashboard on port 9100 instead of 8891
```

JSON stats are also available at `http://localhost:8891/api/stats` and `http://localhost:3900/api/stats`.

<br>

---

## Qwen Code Extension

FocusMemory ships a ready-to-install extension for **[qwen-code](https://github.com/QwenLM/qwen-code)** — zero upstream modifications required. The extension wires all MCP tools and hooks through a single `qwen-extension.json` manifest:

```
User prompt → [HTTP Hook: auto-recall] + [Hard Gate: new turn epoch]
  → context injected + turn state stamped (or grep/glob stay blocked)
  → Agent calls search_memory → turn state stamped → Hard Gate opens
  → Code work → Write-back to Qdrant
```

### Architecture

```
qwen-code (upstream — zero modifications)
    │
    ├── Extension: qwen-extension.json
    │   ├── mcpServers.focus-memory  → MCP stdio (8 tools)
    │   └── hooks:
    │       ├── UserPromptSubmit (HTTP)  → auto-recall context from Qdrant
    │       ├── UserPromptSubmit (cmd)   → new turn epoch (bump turnEpoch, clear stamp)
    │       ├── PreToolUse search_memory → stamp memoryCalledEpoch = turnEpoch
    │       ├── PreToolUse remember_decision → set decisionRecorded flag
    │       ├── PreToolUse edit/write_file → track code changes, clear decline flag
    │       ├── PreToolUse grep_search/glob → deny unless stamped this turn
    │       ├── Stop                     → check-writeback (completion + ask)
    │       ├── PreCompact               → SKILL.state: spawn detached Σ extraction worker
    │       ├── SessionStart (compact)   → SKILL.state: re-inject Σ after compaction
    │       └── SessionEnd               → cleanup-session (per-session files + 7-day sweep)
    │
    └── AGENTS.md                    → Hard Gate search protocol

FocusMemory/                         ← Single process: MCP stdio + Hono HTTP
    ├── index.js                     ← /v1/context/search endpoint
    └── lib/utils.js                 ← extractQueryFeatures, routeQuery, pruneAndSummarize
```

### Execution flow

```
User prompt submitted
  │
  ▼
[Auto-recall] UserPromptSubmit HTTP Hook fires (parallel with reset — CAS makes order irrelevant)
  → POST http://localhost:3900/v1/context/search
  → FocusMemory searches Qdrant (work_memory + project_facts)
  → SUMMARY_LLM prunes & summarizes results (~400 tokens)
  → additionalContext injected into agent context
  → turn state stamped: memoryCalledEpoch = turnEpoch (satisfiedBy: auto_recall)
  │
  ▼
[Hard Gate] UserPromptSubmit command Hook fires
  → reset-memory-flag.js bumps turnEpoch and clears the satisfaction stamp
  │
  ▼
[Agent Loop] AGENTS.md Hard Gate rules active + PreToolUse enforcement
  → grep_search/glob blocked unless the turn state is stamped (PreToolUse deny)
  → "Hook already injected context? Skip redundant search" (stamped by auto-recall)
  → Or "New sub-question → call search_memory via MCP tool"
  │
  ▼
[search_memory called] PreToolUse hook fires
  → log-tool-call.js stamps memoryCalledEpoch = turnEpoch (satisfiedBy: search_memory)
  │
  ▼
[Code Work] grep / read / edit / test — normal qwen-code tools
  │ (edit/write_file logged → code change tracked, decline flag cleared)
  │
  ▼
[Write-back] remember_decision records outcome to Qdrant
  │ (PreToolUse logs → decisionRecorded = true, persists across turns)
  │
  ▼
[Stop hook — turn end] check-writeback.js fires once per turn
  → Reads tool log: code change? Reads message: completion signal?
  → Both yes + !decisionRecorded + !decisionDeclined → ask user
  → "Yes" → remember_decision called; "No" → decisionDeclined set, no re-ask on same work unit
```

### Hard Gate enforcement levels

| Phase | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Initial prompt** | `UserPromptSubmit` HTTP hook fires before agent loop starts | ✅ System-level — model cooperation not required |
| **Mid-turn (PreToolUse)** | `grep_search`/`glob` blocked until `search_memory` called | ✅ Physical block — returns `permissionDecision: deny` |
| **Turn end (Stop)** | Completion signal + code change detected → user asked to record decision | ✅ System-level checkpoint with user confirmation (`ask`) |
| **Mid-workflow** | AGENTS.md instructs "search_memory first" | ⚠️ Prompt-level suggestion — model may ignore |

The PreToolUse hook enforces the read-side Hard Gate at the system level. When an agent attempts to call `grep_search` or `glob` without calling `search_memory` first, the hook returns a deny decision with the reason message: `[Hard Gate] Call mcp__focus-memory__search_memory before using grep_search/glob.`

The Stop hook enforces write-back symmetry at the turn boundary. It fires once per turn after the model finishes its response, checking for both code changes (`edit`/`write_file` in tool log) and completion signals (patterns like "tests passed", "bug fixed" in `last_assistant_message`). When both are present and no decision has been recorded yet, it asks the user via `decision: ask` — giving final control to the human while preventing forgotten write-backs.

### Installation

**1. Set up FocusMemory backend:**
```bash
cd /path/to/FocusMemory
npm install
node init.js /path/to/your/project

# Create Qdrant collections and ingest docs
QDRANT_URL=http://localhost:6333 npm run create-collections
QDRANT_URL=http://localhost:6333 npm run auto-ingest --force

# Build code graph (JS + Python + PHP)
QDRANT_URL=http://localhost:6333 npm run build-graph /path/to/your/project
```

**2. Install the extension:**

Symlink the entire FocusMemory directory into your extensions folder — `${extensionPath}` resolves to wherever `qwen-extension.json` lives:

```bash
mkdir -p ~/.qwen/extensions
ln -sf /path/to/FocusMemory ~/.qwen/extensions/focus-memory
```

This ensures all `${extensionPath}` references resolve correctly (index.js, hooks/, etc.) and avoids broken links when new files are added.

> **Note:** If you prefer a non-symlink install, copy the directory instead:
> ```bash
> cp -r /path/to/FocusMemory ~/.qwen/extensions/focus-memory
> ```
> (You'll need to re-copy when updating FocusMemory.)

**3. Start FocusMemory server:**

> **qwen-code users: skip this step.** The extension's `mcpServers.focus-memory` automatically spawns `node index.js` via stdio when qwen-code starts. Starting it manually would cause port conflicts on HTTP_PORT (3900) and DASHBOARD_PORT (8891).

For Kilo Code or other clients without extension support:
```bash
cd /path/to/FocusMemory
QDRANT_URL=http://localhost:6333 \
  BGE_URL=http://localhost:8080/v1/embeddings \
  SUMMARY_LLM_URL=http://localhost:8081/v1/completions \
  HTTP_PORT=3900 \
  CONTEXT_API_TOKEN=focus-memory-local \
  node index.js &
```

**4. Enable extension (VS Code IDE only):**
```bash
echo '{"focus-memory": true}' > ~/.qwen/extensions/extension-enablement.json
```

CLI mode loads extensions automatically — this step is not required.

### Hard Gate hook scripts

The hooks use five Node.js scripts plus a shared state library in `hooks/`:

| Script | Trigger | Action |
|--------|---------|--------|
| `reset-memory-flag.js` | UserPromptSubmit (every new turn) | Bump `turnEpoch`, clear the satisfaction stamp; preserve `decisionRecorded`/`decisionDeclined` across turns |
| `log-tool-call.js` | PreToolUse `search_memory`, `remember_decision`, `edit`, `write_file` | Stamp `memoryCalledEpoch = turnEpoch` on `search_memory`; `decisionRecorded=true`; clear `decisionDeclined` on new code edits |
| `check-memory-first.js` | PreToolUse `grep_search`/`glob` | Deny unless `memoryCalledEpoch === turnEpoch` (memory satisfied **this** turn); bypass when input contains an explicit file path |
| `check-writeback.js` | Stop (once per turn at end) | If code change + completion signal + !decisionRecorded → ask user; else allow |
| `precompact-extract-state.js` | PreCompact (any trigger) | SKILL.state (gated): spawn a detached worker that extracts a structured state patch (Σ) from the transcript tail and exits in ms — native compaction is never blocked |
| `sessionstart-inject-state.js` | SessionStart (`compact` only) | SKILL.state (gated): re-inject the session's Σ as `additionalContext` and bump `compact_count` |
| `cleanup-session.js` | SessionEnd | Delete this session's state/audit files + Σ file; sweep files older than 7 days (sessions that crashed without SessionEnd) |
| `lib/state.js` | — (shared) | `updateState` (lock-protected state writes), `withLock`, atomic write, JSONL rotation, telemetry, stale sweep |
| `lib/skillstate.js` | — (shared) | SKILL.state helpers: Σ load/merge (null-deletion), transcript tail extraction, extraction-LLM call, work_memory checkpoint upsert |

Each script reads the hook event from stdin (`fs.readFileSync(0, 'utf8')`) and uses `event.session_id` to share state via a JSON file in `~/.qwen/tmp/tool-calls/`.

**State file format** (`~/.qwen/tmp/tool-calls/<session_id>.json`):
```json
{ "turnEpoch": 7, "memoryCalled": true, "memoryCalledEpoch": 7, "satisfiedBy": "auto_recall", "decisionRecorded": false }
```

- `turnEpoch`: bumped by `reset-memory-flag.js` on every prompt — the turn counter
- `memoryCalledEpoch`: the `turnEpoch` value at the moment memory was satisfied (auto-recall or `search_memory`); `null` until then. The gate passes only when `memoryCalledEpoch === turnEpoch`, so a stamp from an earlier turn can never satisfy the gate — e.g. if auto-recall fails on the new turn, the previous turn's stamp is stale and the gate stays closed
- `satisfiedBy`: `auto_recall` | `search_memory` — who stamped, for telemetry
- `decisionRecorded`: persists across turns until cleared by new code edits (write-back tracking)
- `decisionDeclined`: set when user declines; cleared on next `edit`/`write_file` to allow re-asking for new work units

**Concurrent writers, one state file.** `reset-memory-flag.js` (millisecond-scale) and the HTTP auto-recall hook (seconds later, for the *same* prompt) both write this file with no ordering guarantee (qwen-code runs UserPromptSubmit hooks in parallel). `updateState` in `lib/state.js` serializes the writers with an exclusive lockfile (O_EXCL, 2 s acquisition deadline; a lock left by a crashed holder is removed after 5 s; if the deadline is ever exceeded the write proceeds lock-free as a best effort so a hook never hangs the session). The commit itself is atomic (tmp + rename), so readers never observe a torn state file.

**Companion logs:**
- Audit log: `~/.qwen/tmp/tool-calls/<session_id>.jsonl` — one line per tracked tool call (`{ tool, ts }`), written by `log-tool-call.js`
- Gate telemetry: `~/.qwen/tmp/focus-memory/gate-telemetry.jsonl` — one line per gate decision (`{ ts, session_id, hook, tool, decision, memoryCalled, reason? }`). First place to look when a `grep_search`/`glob` call was unexpectedly blocked or bypassed:

```json
{"ts":1786852894023,"session_id":"e70bab...","hook":"check-memory-first","tool":"grep_search","decision":"allow","memoryCalled":true,"reason":"auto_recall"}
{"ts":1786852894023,"session_id":"e70bab...","hook":"check-memory-first","tool":"grep_search","decision":"allow","memoryCalled":true,"reason":"search_memory"}
{"ts":1786852894023,"session_id":"e70bab...","hook":"check-memory-first","tool":"grep_search","decision":"allow","memoryCalled":false,"reason":"explicit_file_path_bypass"}
{"ts":1786852894023,"session_id":"e70bab...","hook":"check-memory-first","tool":"grep_search","decision":"deny","memoryCalled":false,"reason":"epoch_mismatch"}
```

Both JSONL logs are size-bounded: once a file exceeds 512 KB it is truncated to its last 1000 lines, on the next append.

**Edge cases:**
- **Triviality gate (both entry points)** — `isTrivialQuery()` in `lib/utils.js` (shared by the MCP `search_memory` tool and the HTTP auto-recall hook) skips backend lookups for queries under 10 chars, pure math strings, or greetings. Rule-based, no LLM. The gate is still satisfied: the tool call / hook ran, it just paid no backend cost
- **Explicit file path bypass** — `check-memory-first.js` allows `grep_search`/`glob` even when the turn state is not stamped, if the tool input contains an explicit file path (e.g. "read `/opt/project/src/foo.js`"); logged as `reason: explicit_file_path_bypass`
- **Auto-recall stamp** — a successful auto-recall stamps the turn state, allowing `grep_search`/`glob` without a manual `search_memory` call; allow logged with `reason: auto_recall` (the `satisfiedBy` value)
- **Stale stamp (failed recall on the new turn)** — if the HTTP hook fails on a turn (server down, network error), it stamps nothing; the previous turn's stamp has the old epoch, so the gate denies with `reason: epoch_mismatch` until an explicit `search_memory` runs. A stale stamp can never open the gate
- **No state file / legacy state** — no file → deny (`reason: no_state`); a state file from before the epoch design (no `turnEpoch`) → deny (`reason: legacy_state`) until the next `search_memory`
- **Fail-open on error** — malformed stdin, missing `session_id`, or an internal exception makes the hook allow the call. A command hook that crashes with exit code 1 (e.g. `Cannot find module` from a dangling symlink) is non-blocking per qwen-code's hook contract, so a broken hook registration silently disables the gate instead of bricking the agent

**Output formats:**
- PreToolUse: `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow|deny" } }`
- Stop: `{ decision: "allow" }` or `{ decision: "ask", reason: "...", stopReason: "..." }`

### SKILL.state — structured execution state across compaction

Long sessions get compacted: qwen-code replaces the conversation with an LLM prose summary, and fine-grained execution state (which files were touched, which checks are still pending, what was decided) is whatever the summary happened to preserve. **SKILL.state** implements the state-extraction idea from the [SKILL.state paper (arXiv:2608.26263)]: instead of relying on the prose summary, FocusMemory extracts a **structured state patch (Σ)** from the pre-compaction transcript and re-injects it after compaction, so the agent resumes from explicit state rather than reconstructed history.

**Enable it** — one environment variable (process env first, then `FocusMemory/.env`):

```bash
# in FocusMemory/.env (or export in your shell / ~/.qwen/settings.json "env")
FOCUSMEMORY_SKILLSTATE=on
# optional: transcript window for extraction, rendered chars (default 30000, min 2000)
# FOCUSMEMORY_SKILLSTATE_MAX_CHARS=30000
```

With the gate off or unset, both hooks return immediately at the entry (measured 25–40 ms, zero output) — auto-recall and the Hard Gate are byte-for-byte untouched.

**How it works** (all fail-open — any failure leaves native compaction exactly as-is):

```
PreCompact (auto or manual)
  │
  ├── parent hook: spawns a DETACHED worker, emits a summarizer nudge, exits in ms
  │   (native compaction is never blocked by the LLM call)
  │
  └── worker (parallel with the native compaction side-query):
        transcript tail (default 30k rendered chars)
        → extraction LLM (MAIN_LLM, falling back to SUMMARY_LLM) emits a JSON state patch
        → merge into Σ  (Σ_{t+1} = Σ_t ⊕ Δ — union/replace/merge per key, null deletes)
        → save ~/.qwen/tmp/focus-memory/state/<session_id>.json  (lock-protected)
        → dual-write a work_memory point (type: "state_checkpoint") via BGE embedding
        → telemetry: extracted / extract_failed / worker_error

SessionStart (source = compact)
  │
  └── loads Σ, bumps compact_count, injects it as additionalContext:
      "prefer it over the prose summary for 'where are we' questions"
```

**Σ schema** (extracted keys; omitted keys are unchanged, `null` deletes):

| Key | Merge rule |
|---|---|
| `task_summary` | replace — one line: what this session is working on |
| `current_step` | replace — what the agent is doing right now |
| `pending_checks` | replace (snapshot) — verifications still outstanding |
| `files_touched` | union (capped at 50) — files created/modified |
| `decisions` | union (capped at 50) — decisions made in the segment |
| `tests_status` | merge — `{ "<check>": "pass\|fail\|pending" }` |

**Notes:**

- The extraction LLM is `MAIN_LLM` (the high-performance model) with `SUMMARY_LLM` as fallback. Qwen3-family models need the chat-template wrapping that `lib/skillstate.js` applies automatically (raw prompts make them emit a single EOS token).
- **Extraction overhead (measured)** — per compaction: ~9.8k input tokens (the 30k rendered tail) + ~387 output tokens (the 6-key JSON patch), median ~3.6 s, and the worker runs **detached** in parallel with the native compaction, so it adds **zero user-facing latency**. The extraction prompt ends with `/no_think` to disable the Qwen3 thinking pass — extraction is a mechanical "copy facts into JSON" task, so the thinking pass is pure overhead. Disabling it cut the call from ~12.6 s to ~3.6 s (median) and output tokens from ~1,147 to ~387 (~67% fewer) with patch quality preserved (5/5 valid in a 5-sample batch).
- Extraction runs **in parallel** with the native compaction because qwen-code keeps the raw transcript after compaction (it only appends a `chat_compression` record). On small contexts the native summary can finish first — then this round's injection is skipped (fail-open); the Σ still lands for the next compaction and in `work_memory`.
- Σ files are per-session, live in a separate directory (`~/.qwen/tmp/focus-memory/state/`) from the Hard Gate state, and are swept by `cleanup-session.js` on SessionEnd (plus a 7-day stale sweep).
- Diagnostics: `~/.qwen/tmp/focus-memory/gate-telemetry.jsonl` — look for `hook: "precompact-extract-state"` entries (`extracted` with `keys`, or `extract_failed` / `worker_error` with a reason).

### Hook registration: single source — extension manifest only

Hooks are registered in **exactly one place**: the extension manifest (`qwen-extension.json` → `hooks`).

The same scripts *can* also be registered in `~/.qwen/settings.json` (historically via a `<project>/.qwen/hooks` symlink), but registering in both places makes every command hook fire **twice per event** — doubled telemetry lines per gate decision and, for any hook that triggers embedding/LLM work, doubled cost. The settings-registered copy was removed from `~/.qwen/settings.json` on 2026-08-23 (backup: `~/.qwen/settings.json.bak-20260823-hooks-dedup`); the MCP server entry in settings.json is kept as-is because the manifest's `${extensionPath}` registration and it resolve to the same single `index.js` process.

If you ever re-add hooks to `~/.qwen/settings.json`, remove them from the manifest instead — keep one execution path.

> **Dangling symlink = silent gate loss.** The extension is linked as `~/.qwen/extensions/focus-memory` → repo. If the repo moves and the link target is gone, every manifest hook exits 1 (`Cannot find module`) and — being non-blocking — the Hard Gate stops denying with no visible error. Verify after any repo restructure:
>
> ```bash
> ls -laL ~/.qwen/extensions/focus-memory/hooks/   # must list the .js files, not "No such file or directory"
> ```

### Design principles

1. **Zero upstream modifications** — Uses only qwen-code's native Extension and Hook system. Upgrades to qwen-code are safe; only the manifest may need adjustment if extension specs change.
2. **Hard Gate is enforced, not suggested** — The HTTP hook guarantees context injection at session start. PreToolUse hooks physically block grep/glob until search_memory runs (read-side). Stop hooks detect completion signals and ask the user to record decisions (write-side), with `decision: ask` giving final control to prevent false positives. Mid-workflow rules in AGENTS.md provide guidance with conditional re-search to minimize token waste.
3. **Stay out of the inference path** — FocusMemory provides context before prompt assembly. Inference happens directly between client and model. No added latency during tool execution.
4. **Write-back is enforced, not optional** — Read-only memory is half-baked. The Stop hook ensures `remember_decision` is called when work completes, recording outcomes to Qdrant so future sessions build on past work instead of repeating it. User confirmation via `ask` prevents forced recordings on non-completion turns.

<br>

---

## Available tools

| Tool | Purpose |
|---|---|
| `search_memory` | **Unified** — scoring-based routing across work_memory, project_facts, graph, code_chunks, and decision_chains + SUMMARY_LLM prune & summarize |
| `trace_decision_chain` | **Causal Decision Chain** — trace the full history of a decision: what superseded it, why, and what came after (query or decision_id) |
| `search_work_memory` | Past decisions, resolved issues, open todos (direct) |
| `search_project_facts` | DB schemas, infra topology, API specs (direct) |
| `search_code` | Natural language search over JS/TS/Python/PHP function bodies (vector similarity on code_chunks) |
| `query_graph` | Code graph: "who calls X?", "functions in file Y", dependencies |
| `remember_decision` | Write a new decision into work_memory + decision_chains (with reasoning, topic_key, supersedes links) |
| `search_web` | Web search via local search server |

<br>

---

## How it works

### Query routing

Each query is decomposed into signals (identifier ratio, causal keywords, structural patterns, temporal markers). A scoring function ranks each backend against these features:

```
score(backend, query) = 0.5 · similarity + 0.4 · feature_fit + 0.1 · recency_prior
```

The highest-scoring backend is selected. If the top two scores are within ε=0.15, a parallel search with reranking is triggered instead of picking blindly. Queries with causal keywords ("why", "decision", "changed from") automatically score higher against the `decision_chains` backend.

### Causal decision chains

Every decision written via `remember_decision` is stored as a node in a directed graph: each node carries `supersedes` (previous decision IDs it replaced) and `caused_by` (decisions that led to this one). The `trace_decision_chain` tool walks both directions — forward to see what replaced a decision, backward to see why it was made — returning the full causal history in chronological order.

When you ask "why was X built this way?", the router detects causal keywords and searches the decision_chains collection. Results include not just the matching decision but its entire chain: the original rationale, every replacement with reasoning, and the current active node. This turns architectural archaeology from a chat-log dig into a structured graph traversal.

Decisions are also dual-written to `work_memory` for backward compatibility, and reverse links (`superseded_by`) are auto-updated when a new decision supersedes an old one.

### Prune & Summarize (§2.5)

Raw vector search returns top-N results, but 80% may be irrelevant noise. Before injecting context into the agent's prompt, a lightweight local LLM (SUMMARY_LLM — Bonsai 27B, Gemma 4 31B, etc.) compresses the raw results into core facts that directly answer the query. If SUMMARY_LLM is unavailable, results are returned unpruned with zero downtime.

### Semantic code search

JS/TS/Python/PHP files are parsed (tree-sitter for JS, regex fallback for TS/Python/PHP) to extract function and method bodies as chunks. Each chunk is embedded using BGE-M3 and stored in the `code_chunks` Qdrant collection. Incremental indexing compares SHA-256 content hashes — only changed files trigger re-extraction and re-embedding. The `search_code` tool takes a natural language query, embeds it, and returns the top matching code snippets with file path, line numbers, and similarity score.

<br>

---

## Project structure

```
FocusMemory/
├── .env.example            # Environment config template
├── index.js                # MCP stdio + Hono HTTP — 8 tools, /v1/context/search endpoint
├── init.js                 # Workspace initializer (creates docs/, plans/, .focusmemoryignore)
├── autoIngest.js           # Incremental doc/plan/todo ingest + code chunk reindex (cron-safe)
├── todoRunner.js           # Autonomous TODO execution runner (PM2-managed, daily at 23:40)
├── meilisearch.js          # MeiliSearch indexer for docs/plans Markdown files
├── lib/                    # Shared libraries
│   ├── utils.js            # scanFiles, loadIgnorePatterns, extractQueryFeatures, routeQuery, pruneAndSummarize
│   └── codesearch/         # Code chunk extraction & indexing pipeline
│       └── indexCodeChunks.js
├── scripts/                # CLI utility scripts
│   ├── createCollection.js # Initialize Qdrant collections & payload indexes
│   ├── buildGraph.js       # tree-sitter JS + regex TS/Python/PHP → function nodes + call edges
│   ├── indexCodeStructure.js  # MeiliSearch code structure indexer
│   └── testSearch.js       # Search test CLI
├── web/                    # Dashboard UI (port 8891)
│   ├── dashboard.html      # Real-time Qdrant/Meilisearch stats dashboard
│   └── index.html          # Main landing page
├── config/                 # Configuration files
│   └── com.focusmemory.autoingest.plist  # launchd cron job
├── logs/                   # Auto-generated state & log files (gitignored)
├── qwen-extension.json     # Qwen Code extension manifest (mcpServers + hooks)
├── AGENTS.md               # Hard Gate search protocol rules (agent context)
├── hooks/                  # Hook scripts (UserPromptSubmit / PreToolUse / PreCompact / SessionStart / Stop / SessionEnd)
│   ├── check-memory-first.js  # PreToolUse: deny grep/glob if memory not called
│   ├── check-writeback.js     # Stop: detect completion, ask to record decision
│   ├── log-tool-call.js       # PreToolUse: track tool calls and state flags
│   ├── reset-memory-flag.js   # UserPromptSubmit: reset turn-level flags
│   ├── precompact-extract-state.js    # PreCompact: SKILL.state — spawn detached Σ extraction worker
│   ├── sessionstart-inject-state.js   # SessionStart(compact): SKILL.state — re-inject Σ
│   ├── cleanup-session.js     # SessionEnd: per-session cleanup + 7-day sweep (incl. Σ files)
│   ├── lib/                   # Shared hook libraries
│   │   ├── state.js           # lock-protected state writes, atomic write, telemetry, sweep
│   │   └── skillstate.js      # SKILL.state: Σ merge, transcript tail, extraction LLM, checkpoint
│   └── package.json           # "type": "commonjs" — hooks are CJS even though the root package is ESM
├── LICENSE                 # MIT license
├── package.json
└── README.md
```

> **Note:** qwen-code expects `qwen-extension.json` (and `AGENTS.md`) at the top level of the symlink target, so the extension files live directly under the repo root rather than in a nested directory.

<br>

---

## Design principles

1. **Local-first.** No cloud dependency. Your code, schema, and decisions stay on your infrastructure.
2. **Stay out of the inference path.** FocusMemory augments prompts — it never sits between client and model.
3. **Incremental by default.** Only changed files trigger reprocessing. Cron-safe idempotent operations.

<br>

---

<div align="center">

`SELF-HOSTED / MIT`

</div>
