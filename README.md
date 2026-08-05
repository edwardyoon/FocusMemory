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

FocusMemory gives your AI coding agent persistent memory: **causal decision chains**, past decisions, project knowledge, semantic code search, and structural dependency graphs — all backed by Qdrant and exposed through a single MCP server.

> **Causal Decision Chains** — Every decision is stored as a linked chain node with `supersedes`/`superseded_by` relationships. Ask "why was this built this way?" and get back the full causal history: what was decided, why it replaced the previous approach, and what came after.

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
cd work-memory-mcp
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
*/5 * * * * cd /path/to/work-memory-mcp && npm run auto-ingest >> /var/log/focusmemory.log 2>&1
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

### 6. Enable extension in VS Code IDE (CLI는 불필요)

VS Code IDE에서 Qwen Code를 사용할 경우, `extension-enablement.json`에 명시적으로 활성화해야 AGENTS.md Hard Gate가 작동합니다:

```bash
echo '{"focus-memory": true}' > ~/.qwen/extensions/extension-enablement.json
```

CLI 모드에서는 extension이 자동으로 로드되므로 이 단계가 필요 없습니다. 하지만 VS Code IDE에서 설정하지 않으면 `search_memory` 등 MCP 도구가 system prompt에 인젝션되지 않아 Hard Gate가 비활성화됩니다.

<br>

---

## Qwen Code Extension

FocusMemory ships a ready-to-install extension for **[qwen-code](https://github.com/QwenLM/qwen-code)** — zero upstream modifications required:

```
User prompt → [HTTP Hook: auto-recall] → context injected → [Agent Loop + MCP tools] → [Write-back to Qdrant]
```

The extension installs via a single `qwen-extension.json` manifest that wires all MCP tools and an auto-recall HTTP hook. An `AGENTS.md` enforces the Hard Gate search protocol inside the agent loop.

See [`qwen-code-extension/`](qwen-code-extension/) for installation instructions.

<br>

---

## Available tools

| Tool | Purpose |
|---|---|
| `search_memory` | **Unified** — scoring-based routing across work_memory, project_facts, graph, code_chunks, and decision_chains + BONSAI prune & summarize |
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

Raw vector search returns top-N results, but 80% may be irrelevant noise. Before injecting context into the agent's prompt, a lightweight local LLM (BONSAI — Qwen 2.5, Gemma, etc.) compresses the raw results into core facts that directly answer the query. If BONSAI is unavailable, results are returned unpruned with zero downtime.

### Semantic code search

JS/TS/PHP files are parsed (tree-sitter for JS, regex fallback for TS/PHP) to extract function and method bodies as chunks. Each chunk is embedded using BGE-M3 and stored in the `code_chunks` Qdrant collection. Incremental indexing compares SHA-256 content hashes — only changed files trigger re-extraction and re-embedding. The `search_code` tool takes a natural language query, embeds it, and returns the top matching code snippets with file path, line numbers, and similarity score.

<br>

---

## Project structure

```
FocusMemory/
├── README.md
├── qwen-code-extension/      # Qwen Code extension (manifest + AGENTS.md)
│   ├── qwen-extension.json   # Extension manifest (mcpServers + hooks)
│   ├── AGENTS.md             # Hard Gate search protocol rules
│   └── README.md             # Installation & usage guide
└── work-memory-mcp/          # MCP server (core)
    ├── index.js              # MCP stdio + Hono HTTP — 8 tools, /v1/context/search endpoint
    ├── init.js               # Workspace initializer (creates docs/, plans/, .focusmemoryignore)
    ├── createCollection.js   # Initialize Qdrant collections & payload indexes
    ├── buildGraph.js         # tree-sitter JS + regex TS/PHP → function nodes + call edges
    ├── autoIngest.js         # Incremental doc/plan ingest + code chunk reindex (cron-safe)
    ├── semantic_codesearch/  # Code chunk extraction & indexing pipeline
    │   └── indexCodeChunks.js
    └── package.json
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
