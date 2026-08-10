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

> **Token waste in source exploration** is the hidden cost of AI-assisted development. An agent without memory repeats this loop: grep → read → reason → retry. Each round-trip burns context tokens, inflates VRAM, and adds latency. FocusMemory replaces on-demand discovery with **pre-indexed recall + scoring-based routing**, cutting average tool calls per query from 3.5 to 1.8 (~49% reduction) and response time from 25s to 8s (~68%).

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

### Remaining improvement

1. **Auto-commit via session end hook** — The Qwen Code extension's HTTP hook could detect when a coding task completes (tests pass, PR merged) and auto-extract decisions from the chat transcript. A lightweight LLM prompt summarizes key decisions, infers `topic_key`, and calls `remember_decision` without agent intervention. Currently the Hard Gate in AGENTS.md instructs agents to call `remember_decision` manually at task end; full automation awaits transcript access from the ACP host.

<br>

---

## What it does

| Capability | How |
|---|---|
| **Causal decision chains** | Decisions stored as linked nodes with `supersedes`/`superseded_by` — trace the full "why" history of any architectural choice, from original rationale through every replacement |
| **Work history** | Decisions, bug fixes, resolved issues — written back after each session so the next agent starts where the last left off |
| **Project knowledge** | Docs and plans chunked, embedded, and searchable via vector similarity |
| **Semantic code search** | Natural-language queries against JS/TS/PHP function bodies using BGE-M3 embeddings |
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

`auto-ingest` is incremental by default: it compares file modification times against a state file (`ingest_state.json`) and only re-processes new or changed files. It also runs the **semantic code chunk indexer** automatically, so your `.js`, `.ts`, and `.php` functions stay up to date without manual intervention.

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

If you're using Qwen Code inside VS Code IDE, you need to explicitly enable the extension in `extension-enablement.json` for the AGENTS.md Hard Gate to work:

```bash
echo '{"focus-memory": true}' > ~/.qwen/extensions/extension-enablement.json
```

This step isn't needed in CLI mode, where the extension loads automatically. But without it in VS Code IDE, MCP tools like `search_memory` won't get injected into the system prompt, and the Hard Gate stays disabled.

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
    │       └── PreToolUse grep_search/glob → deny if flag not set
    │
    └── AGENTS.md                    → Hard Gate search protocol

FocusMemory/                         ← Single process: MCP stdio + Hono HTTP
    ├── index.js                     ← /v1/context/search endpoint
    └── utils.js                     ← extractQueryFeatures, routeQuery, pruneAndSummarize
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
  │
  ▼
[Write-back] remember_decision records outcome to Qdrant
```

### Hard Gate enforcement levels

| Phase | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Initial prompt** | `UserPromptSubmit` HTTP hook fires before agent loop starts | ✅ System-level — model cooperation not required |
| **Mid-turn (PreToolUse)** | `grep_search`/`glob` blocked until `search_memory` called | ✅ Physical block — returns `permissionDecision: deny` |
| **Mid-workflow** | AGENTS.md instructs "search_memory first" | ⚠️ Prompt-level suggestion — model may ignore |

The PreToolUse hook enforces the Hard Gate at the system level. When an agent attempts to call `grep_search` or `glob` without calling `search_memory` first, the hook returns a deny decision with the reason message: `[Hard Gate] Call mcp__focus-memory__search_memory before using grep_search/glob.`

### Installation

**1. Set up FocusMemory backend:**
```bash
cd /path/to/FocusMemory
npm install
node init.js /path/to/your/project

# Create Qdrant collections and ingest docs
QDRANT_URL=http://localhost:6333 npm run create-collections
QDRANT_URL=http://localhost:6333 npm run auto-ingest --force

# Build code graph (JS + PHP)
QDRANT_URL=http://localhost:6333 npm run build-graph /path/to/your/project
```

**2. Install the extension:**
```bash
mkdir -p ~/.qwen/extensions/focus-memory

# Symlink (recommended — changes reflect automatically)
ln -sf /path/to/FocusMemory/qwen-code-extension/qwen-extension.json \
       ~/.qwen/extensions/focus-memory/qwen-extension.json
ln -sf /path/to/FocusMemory/qwen-code-extension/AGENTS.md \
       ~/.qwen/extensions/focus-memory/AGENTS.md
```

Edit `~/.qwen/extensions/focus-memory/qwen-extension.json` and update the MCP server path to match your FocusMemory installation:

```json
{ "mcpServers": { "focus-memory": { "args": ["/path/to/FocusMemory/index.js"] } } }
```

**3. Start FocusMemory server:**
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

The PreToolUse hooks require three Node.js scripts in `.qwen/hooks/`:

| Script | Trigger | Action |
|--------|---------|--------|
| `reset-memory-flag.js` | UserPromptSubmit (every new turn) | Set `memoryCalled = false` |
| `log-tool-call.js` | PreToolUse `search_memory` | Set `memoryCalled = true`, allow |
| `check-memory-first.js` | PreToolUse `grep_search`/`glob` | Deny if `memoryCalled` is false, otherwise allow |

Each script reads the hook event from stdin (`fs.readFileSync(0, 'utf8')`) and uses `event.session_id` to share state via a JSON file in `.qwen/tmp/tool-calls/`. Output format: `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow|deny" } }`.

### Design principles

1. **Zero upstream modifications** — Uses only qwen-code's native Extension and Hook system. Upgrades to qwen-code are safe; only the manifest may need adjustment if extension specs change.
2. **Hard Gate is enforced, not suggested** — The HTTP hook guarantees context injection at session start. PreToolUse hooks physically block grep/glob until search_memory runs. Mid-workflow rules in AGENTS.md provide guidance with conditional re-search to minimize token waste.
3. **Stay out of the inference path** — FocusMemory provides context before prompt assembly. Inference happens directly between client and model. No added latency during tool execution.
4. **Write-back is part of the loop** — Read-only memory is half-baked. `remember_decision` records outcomes to Qdrant so future sessions build on past work instead of repeating it.

<br>

---

## Available tools

| Tool | Purpose |
|---|---|
| `search_memory` | **Unified** — scoring-based routing across work_memory, project_facts, graph, code_chunks, and decision_chains + SUMMARY_LLM prune & summarize |
| `trace_decision_chain` | **Causal Decision Chain** — trace the full history of a decision: what superseded it, why, and what came after (query or decision_id) |
| `search_work_memory` | Past decisions, resolved issues, open todos (direct) |
| `search_project_facts` | DB schemas, infra topology, API specs (direct) |
| `search_code` | Natural language search over JS/TS/PHP function bodies (vector similarity on code_chunks) |
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

JS/TS/PHP files are parsed (tree-sitter for JS, regex fallback for TS/PHP) to extract function and method bodies as chunks. Each chunk is embedded using BGE-M3 and stored in the `code_chunks` Qdrant collection. Incremental indexing compares SHA-256 content hashes — only changed files trigger re-extraction and re-embedding. The `search_code` tool takes a natural language query, embeds it, and returns the top matching code snippets with file path, line numbers, and similarity score.

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
│   ├── buildGraph.js       # tree-sitter JS + regex TS/PHP → function nodes + call edges
│   ├── indexCodeStructure.js  # MeiliSearch code structure indexer
│   └── testSearch.js       # Search test CLI
├── web/                    # Dashboard UI (port 8891)
│   ├── dashboard.html      # Real-time Qdrant/Meilisearch stats dashboard
│   └── index.html          # Main landing page
├── config/                 # Configuration files
│   └── com.focusmemory.autoingest.plist  # launchd cron job
├── logs/                   # Auto-generated state & log files (gitignored)
├── qwen-code-extension/    # Qwen Code extension (manifest + AGENTS.md)
│   ├── qwen-extension.json # Extension manifest (mcpServers + hooks)
│   └── AGENTS.md           # Hard Gate search protocol rules
├── package.json
└── README.md
```

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
