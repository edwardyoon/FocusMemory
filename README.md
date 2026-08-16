<div align="center">

# FocusMemory

> **Grep finds code. Vectors find meaning. I remember why.**

**Memory infrastructure for agentic coding.**

</div>

```
       /\_/\   
      ( o.o )   "Grep finds code.
       > ^ <     Vectors find meaning.
      /     \    I remember why."
     | |   | |
     (_)_)(_)=[]=============>  (FocusMemory Katana)
```

Grep finds the code. Vectors find the meaning. Neither remembers the decision that made it true — or why it was written that way in the first place.

FocusMemory turns your workspace into a **living knowledge base** for AI coding agents. It pre-indexes business decisions, project documentation, code structure, and semantic history into Qdrant (vector), Meilisearch (full-text), and a lightweight summary LLM — then exposes them through a single MCP server with intelligent routing.

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
| **Prune** | A local LLM (SUMMARY_LLM — Qwen 2.5 / Gemma) strips noise from raw top-N results before anything reaches the agent prompt. Compresses 10~15 raw hits into core facts. Graceful fallback to raw output if SUMMARY_LLM is unavailable (`utils.js` `pruneAndSummarize()`). | ✅ implemented |
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
| Completion signal | `last_assistant_message` patterns | "테스트 통과", "버그 수정됨", "ready to commit" |
| User confirmation | `decision: ask` → user responds | "예" → `remember_decision` called; "아니오" → skipped, no re-ask on same work unit |

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
User prompt → [HTTP Hook: auto-recall] + [Hard Gate: reset flag]
  → context injected, grep/glob blocked
  → Agent calls search_memory → Hard Gate opens (grep/glob allowed)
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
    │       ├── UserPromptSubmit (cmd)   → reset Hard Gate flag each turn
    │       ├── PreToolUse search_memory → set memoryCalled flag
    │       ├── PreToolUse remember_decision → set decisionRecorded flag
    │       ├── PreToolUse edit/write_file → track code changes, clear decline flag
    │       ├── PreToolUse grep_search/glob → deny if flag not set
    │       └── Stop                     → check-writeback (completion + ask)
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
[Auto-recall] UserPromptSubmit HTTP Hook fires
  → POST http://localhost:3900/v1/context/search
  → FocusMemory searches Qdrant (work_memory + project_facts)
  → SUMMARY_LLM prunes & summarizes results (~400 tokens)
  → additionalContext injected into agent context
  │
  ▼
[Hard Gate] UserPromptSubmit command Hook fires
  → reset-memory-flag.js sets memoryCalled = false
  │
  ▼
[Agent Loop] AGENTS.md Hard Gate rules active + PreToolUse enforcement
  → grep_search/glob blocked until search_memory called (PreToolUse deny)
  → "Hook already injected context? Skip redundant search"
  → Or "New sub-question → call search_memory via MCP tool"
  │
  ▼
[search_memory called] PreToolUse hook fires
  → log-tool-call.js sets memoryCalled = true (Hard Gate opens)
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
  → "예" → remember_decision called; "아니오" → decisionDeclined set, no re-ask on same work unit
```

### Hard Gate enforcement levels

| Phase | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Initial prompt** | `UserPromptSubmit` HTTP hook fires before agent loop starts | ✅ System-level — model cooperation not required |
| **Mid-turn (PreToolUse)** | `grep_search`/`glob` blocked until `search_memory` called | ✅ Physical block — returns `permissionDecision: deny` |
| **Turn end (Stop)** | Completion signal + code change detected → user asked to record decision | ✅ System-level checkpoint with user confirmation (`ask`) |
| **Mid-workflow** | AGENTS.md instructs "search_memory first" | ⚠️ Prompt-level suggestion — model may ignore |

The PreToolUse hook enforces the read-side Hard Gate at the system level. When an agent attempts to call `grep_search` or `glob` without calling `search_memory` first, the hook returns a deny decision with the reason message: `[Hard Gate] Call mcp__focus-memory__search_memory before using grep_search/glob.`

The Stop hook enforces write-back symmetry at the turn boundary. It fires once per turn after the model finishes its response, checking for both code changes (`edit`/`write_file` in tool log) and completion signals (patterns like "테스트 통과", "버그 수정됨" in `last_assistant_message`). When both are present and no decision has been recorded yet, it asks the user via `decision: ask` — giving final control to the human while preventing forgotten write-backs.

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

The PreToolUse and Stop hooks use four Node.js scripts in `hooks/`:

| Script | Trigger | Action |
|--------|---------|--------|
| `reset-memory-flag.js` | UserPromptSubmit (every new turn) | Set `memoryCalled = false`; preserve `decisionRecorded`/`decisionDeclined` across turns |
| `log-tool-call.js` | PreToolUse `search_memory`, `remember_decision`, `edit`, `write_file` | Track flags: `memoryCalled=true`, `decisionRecorded=true`, clear `decisionDeclined` on new code edits |
| `check-memory-first.js` | PreToolUse `grep_search`/`glob` | Deny if `memoryCalled` is false, otherwise allow; bypass when input contains an explicit file path |
| `check-writeback.js` | Stop (once per turn at end) | If code change + completion signal + !decisionRecorded → ask user; else allow |

Each script reads the hook event from stdin (`fs.readFileSync(0, 'utf8')`) and uses `event.session_id` to share state via a JSON file in `~/.qwen/tmp/tool-calls/`.

**State file format** (`~/.qwen/tmp/tool-calls/<session_id>.json`):
```json
{ "memoryCalled": false, "decisionRecorded": false, "decisionDeclined": false }
```

- `memoryCalled`: reset every turn (read-side gate)
- `decisionRecorded`: persists across turns until cleared by new code edits (write-back tracking)
- `decisionDeclined`: set when user declines; cleared on next `edit`/`write_file` to allow re-asking for new work units

**Companion logs:**
- Audit log: `~/.qwen/tmp/tool-calls/<session_id>.jsonl` — one line per tracked tool call (`{ tool, ts }`), written by `log-tool-call.js`
- Gate telemetry: `~/.qwen/tmp/focus-memory/gate-telemetry.jsonl` — one line per gate decision (`{ ts, session_id, hook, tool, decision, memoryCalled, reason? }`). First place to look when a `grep_search`/`glob` call was unexpectedly blocked or bypassed:

```json
{"ts":1786852894023,"session_id":"e70bab...","hook":"check-memory-first","tool":"grep_search","decision":"allow","memoryCalled":true}
{"ts":1786852894023,"session_id":"e70bab...","hook":"check-memory-first","tool":"grep_search","decision":"allow","memoryCalled":false,"reason":"explicit_file_path_bypass"}
```

**Edge cases:**
- **Explicit file path bypass** — `check-memory-first.js` allows `grep_search`/`glob` even with `memoryCalled = false` when the tool input contains an explicit file path (e.g. "read `/opt/project/src/foo.js`"); logged as `reason: explicit_file_path_bypass`
- **No state file** — deny (`reason: no_state`); normally `reset-memory-flag.js` creates the file at turn start
- **Fail-open on error** — malformed stdin, missing `session_id`, or an internal exception makes the hook allow the call. A command hook that crashes with exit code 1 (e.g. `Cannot find module` from a dangling symlink) is non-blocking per qwen-code's hook contract, so a broken hook registration silently disables the gate instead of bricking the agent

**Output formats:**
- PreToolUse: `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow|deny" } }`
- Stop: `{ decision: "allow" }` or `{ decision: "ask", reason: "...", stopReason: "..." }`

### Hook registration: extension manifest vs user settings

The same scripts can be registered in two places — this deployment uses both:

| Registration | Config | Path style | Scope |
|---|---|---|---|
| Extension manifest (primary) | `qwen-extension.json` → `hooks` | `${extensionPath}/hooks/*.js` | Every session where the extension is enabled |
| User settings (legacy) | `~/.qwen/settings.json` → `hooks` | Absolute paths via a `<project>/.qwen/hooks` symlink | Every project for the user |

The user-settings registration routes through a **directory symlink** so the scripts stay in one place:

```bash
ln -s /path/to/FocusMemory/hooks /path/to/project/.qwen/hooks
```

```json
// ~/.qwen/settings.json (abridged)
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [{ "type": "command", "command": "node /path/to/project/.qwen/hooks/reset-memory-flag.js" }] }
  ],
  "PreToolUse": [
    { "matcher": "^mcp__focus-memory__search_memory$",
      "hooks": [{ "type": "command", "command": "node /path/to/project/.qwen/hooks/log-tool-call.js" }] },
    { "matcher": "^(grep_search|glob)$",
      "hooks": [{ "type": "command", "command": "node /path/to/project/.qwen/hooks/check-memory-first.js" }] }
  ]
}
```

For the three hooks registered in both places (`reset-memory-flag`, `search_memory` logging, `grep_search`/`glob` check), each fires twice per event — visible in the gate telemetry as two identical lines per gate decision. The scripts are idempotent (same state file, same flags), so behavior is unaffected. To keep a single execution path, delete the `hooks` block from `~/.qwen/settings.json` and rely on the extension manifest alone.

> **Dangling symlink = silent gate loss.** If the repo moves and the symlink target is gone, every settings-registered hook exits 1 (`Cannot find module`) and — being non-blocking — the Hard Gate stops denying with no visible error. Verify after any repo restructure:
>
> ```bash
> ls -laL /path/to/project/.qwen/hooks/   # must list the .js files, not "No such file or directory"
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

Raw vector search returns top-N results, but 80% may be irrelevant noise. Before injecting context into the agent's prompt, a lightweight local LLM (SUMMARY_LLM — Qwen 2.5, Gemma, etc.) compresses the raw results into core facts that directly answer the query. If SUMMARY_LLM is unavailable, results are returned unpruned with zero downtime.

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
├── autoIngest.js           # Incremental doc/plan ingest + code chunk reindex (cron-safe)
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
├── hooks/                  # PreToolUse + Stop hook scripts
│   ├── check-memory-first.js  # PreToolUse: deny grep/glob if memory not called
│   ├── check-writeback.js     # Stop: detect completion, ask to record decision
│   ├── log-tool-call.js       # PreToolUse: track tool calls and state flags
│   ├── reset-memory-flag.js   # UserPromptSubmit: reset turn-level flags
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
