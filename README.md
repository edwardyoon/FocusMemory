<div align="center">

# FocusMemory

```
       /\_/\   
      ( o.o )   "Grep finds code.
       > ^ <     Vectors find meaning.
      /     \    I remember why."
     | |   | |
     (_)_)(_)=[]=============>  (FocusMemory Katana)
```

**Memory infrastructure for agentic coding.**

</div>

<br>

Grep finds the code. Vectors find the meaning. Neither remembers the decision that made it true — or why it was written that way in the first place.

FocusMemory gives your AI coding agent persistent memory: past decisions, project knowledge, semantic code search, and structural dependency graphs — all backed by Qdrant and exposed through a single MCP server.

<br>

---

## What it does

| Capability | How |
|---|---|
| **Work history** | Decisions, bug fixes, resolved issues — written back after each session so the next agent starts where the last left off |
| **Project knowledge** | Docs and plans chunked, embedded, and searchable via vector similarity |
| **Semantic code search** | Natural-language queries against JS/TS/PHP function bodies using BGE-M3 embeddings |
| **Code graph** | tree-sitter AST parsing → function nodes + call edges for "who calls X?" questions |
| **Smart routing** | Scoring-based query router dispatches to the right backend (vector vs keyword) automatically |

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

Creates `work_memory`, `project_facts`, `graph_nodes`, `graph_edges`, and `code_chunks` with payload indexes.

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

Configure your client (Qwen Code, Kilo Code) to connect via stdio transport and you get seven tools available in the agent loop.

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
| `search_memory` | **Unified** — scoring-based routing across work_memory, project_facts, graph, and code_chunks + BONSAI prune & summarize |
| `search_work_memory` | Past decisions, resolved issues, open todos (direct) |
| `search_project_facts` | DB schemas, infra topology, API specs (direct) |
| `search_code` | Natural language search over JS/TS/PHP function bodies (vector similarity on code_chunks) |
| `query_graph` | Code graph: "who calls X?", "functions in file Y", dependencies |
| `remember_decision` | Write a new decision/fact into work_memory |
| `search_web` | Web search via local search server |

<br>

---

## How it works

### Query routing

Each query is decomposed into signals (identifier ratio, causal keywords, structural patterns, temporal markers). A scoring function ranks each backend against these features:

```
score(backend, query) = 0.5 · similarity + 0.4 · feature_fit + 0.1 · recency_prior
```

The highest-scoring backend is selected. If the top two scores are within ε=0.15, a parallel search with reranking is triggered instead of picking blindly.

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
    ├── index.js              # MCP stdio + Hono HTTP — 7 tools, /v1/context/search endpoint
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
