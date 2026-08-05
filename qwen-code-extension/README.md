# FocusMemory — qwen-code Extension

**Grep finds code. Vectors find meaning. I remember why.**

This extension connects [FocusMemory](https://github.com/edwardyoon/FocusMemory) — a Qdrant-based memory backend with BONSAI prune & summarize — to **[qwen-code](https://github.com/QwenLM/qwen-code)** via its native Extension system. Zero upstream modifications required.

---

## What this extension does

It gives qwen-code six MCP tools and an auto-recall HTTP hook, all wired through a single `qwen-extension.json` manifest:

| Tool | Purpose |
|------|---------|
| `search_memory` | Unified routing — scoring-based backend selection + parallel rerank + BONSAI prune & summarize |
| `query_graph` | Code graph queries — "who calls X?", "functions in file Y" |
| `remember_decision` | Decision/fact write-back to Qdrant (automatic or manual) |
| `search_work_memory` | Past work history, resolved issues, open todos (direct) |
| `search_project_facts` | DB schemas, infrastructure topology, API specs (direct) |
| `search_web` | Web search via local search server |

Plus an **auto-recall HTTP hook** that fires on every user prompt submission, injecting relevant context before the agent loop even starts.

---

## Architecture

```
qwen-code (upstream — zero modifications)
    │
    ├── Extension: qwen-extension.json
    │   ├── mcpServers.focus-memory  → MCP stdio (6 tools)
    │   └── hooks.UserPromptSubmit   → HTTP Hook (auto-recall)
    │
    └── AGENTS.md                    → Hard Gate search protocol

FocusMemory/work-memory-mcp/         ← Single process: MCP stdio + Hono HTTP
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
  → BONSAI prunes & summarizes results (~400 tokens)
  → additionalContext injected into agent context
  │
  ▼
[Agent Loop] AGENTS.md Hard Gate rules active
  → "Hook already injected context? Skip redundant search"
  → Or "New sub-question → call search_memory via MCP tool"
  │
  ▼
[Code Work] grep / read / edit / test — normal qwen-code tools
  │
  ▼
[Write-back] remember_decision records outcome to Qdrant
```

### The Hard Gate concept

| Phase | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Initial prompt** | `UserPromptSubmit` HTTP hook fires before agent loop starts | ✅ System-level — model cooperation not required |
| **Mid-workflow** | AGENTS.md instructs "search_memory first" | ⚠️ Prompt-level suggestion — model may ignore |

The auto-recall hook guarantees context is available at the start of every session. The AGENTS.md rules guide the agent during multi-step work with conditional re-search logic to avoid redundant queries and token waste.

---

## Prerequisites

- **Node.js >= 22** (ESM requirement)
- **qwen-code** installed via npm or git
- **Qdrant** running on `localhost:6333`
- **BGE-M3 embedding server** (e.g., Ollama, vLLM)
- **FocusMemory MCP server** set up and running

---

## Installation

### 1. Set up FocusMemory backend

```bash
cd /path/to/FocusMemory/work-memory-mcp
npm install

# Create Qdrant collections
QDRANT_URL=http://localhost:6333 npm run create-collections

# Index project docs
QDRANT_URL=http://localhost:6333 \
  BGE_URL=http://localhost:8080/v1/embeddings \
  QWEN_URL=http://localhost:8080/v1/chat/completions \
  npm run ingest-docs

# Build code graph (JS + PHP)
QDRANT_URL=http://localhost:6333 npm run build-graph /path/to/your/project
```

### 2. Install the extension

Create the extension directory under `~/.qwen/extensions/focus-memory/` and symlink or copy the files:

```bash
mkdir -p ~/.qwen/extensions/focus-memory

# Option A: Symlink (recommended — changes reflect automatically)
ln -sf /path/to/FocusMemory/qwen-code-extension/qwen-extension.json \
       ~/.qwen/extensions/focus-memory/qwen-extension.json
ln -sf /path/to/FocusMemory/qwen-code-extension/AGENTS.md \
       ~/.qwen/extensions/focus-memory/AGENTS.md

# Option B: Copy (for independent deployment)
cp /path/to/FocusMemory/qwen-code-extension/* \
   ~/.qwen/extensions/focus-memory/
```

### 3. Configure paths

Edit `~/.qwen/extensions/focus-memory/qwen-extension.json` and update the MCP server path to match your FocusMemory installation:

```json
{
  "mcpServers": {
    "focus-memory": {
      "command": "node",
      "args": ["/path/to/FocusMemory/work-memory-mcp/index.js"],
      ...
    }
  },
  ...
}
```

### 4. Start FocusMemory server

The extension's MCP server and HTTP hook share a single process:

```bash
cd /path/to/FocusMemory/work-memory-mcp

QDRANT_URL=http://localhost:6333 \
  BGE_URL=http://localhost:8080/v1/embeddings \
  BONSAI_URL=http://localhost:8081/v1/chat/completions \
  HTTP_PORT=3900 \
  CONTEXT_API_TOKEN=focus-memory-local \
  node index.js &
```

`BONSAI_URL` points to a lightweight LLM for prune & summarize. If unavailable, the server falls back gracefully to raw results.

### 5. Enable the extension

**CLI 모드**: extension이 자동으로 로드됩니다. 별도 설정 불필요.

**VS Code IDE 모드**: `extension-enablement.json`에서 명시적으로 활성화해야 합니다:

```bash
echo '{"focus-memory": true}' > ~/.qwen/extensions/extension-enablement.json
```

활성화하지 않으면 VS Code IDE에서 AGENTS.md가 system prompt에 인젝션되지 않아, Hard Gate가 작동하지 않습니다. CLI는 자동으로 로드되므로 이 단계가 필요 없습니다.

### 6. Run qwen-code

```bash
cd /path/to/qwen-code
npm run dev -- "Explain the current project structure"
```

The extension loads automatically — no extra configuration needed.

---

## Quick start

```bash
# 1. Install the extension files
mkdir -p ~/.qwen/extensions/focus-memory
cp /path/to/FocusMemory/qwen-code-extension/* ~/.qwen/extensions/focus-memory/

# 2. Fix the MCP server path in qwen-extension.json
#    Edit args[0] to point to your FocusMemory/work-memory-mcp/index.js

# 3. Start the FocusMemory server (MCP stdio + HTTP hook, single process)
cd /path/to/FocusMemory/work-memory-mcp
QDRANT_URL=http://localhost:6333 \
  BGE_URL=http://localhost:8080/v1/embeddings \
  CONTEXT_API_TOKEN=focus-memory-local \
  node index.js &

# 4. Enable extension (VS Code IDE 모드 필수, CLI는 자동)
echo '{"focus-memory": true}' > ~/.qwen/extensions/extension-enablement.json

# 5. Run qwen-code — extension loads automatically
cd /path/to/qwen-code
npm run dev -- "Your question here"
```

That's it. Every prompt triggers an auto-recall HTTP hook (context injected before the agent loop), and all six MCP tools are available during the session.

> **VS Code IDE에서 사용 시**: Step 4의 `extension-enablement.json` 설정이 필수입니다. 없으면 AGENTS.md Hard Gate가 작동하지 않습니다.

---

## Extension manifest overview

`qwen-extension.json` defines two integration points:

**MCP Servers block**: Registers `FocusMemory/work-memory-mcp/index.js` as a stdio MCP server, exposing six tools to the agent loop.

**Hooks block**: Registers an HTTP hook on `UserPromptSubmit`. Before every user prompt is processed, qwen-code sends a POST request to `/v1/context/search`. The response's `additionalContext` field is injected into the agent context automatically.

---

## Design principles

1. **Zero upstream modifications** — Uses only qwen-code's native Extension and Hook system. Upgrades to qwen-code are safe; only the manifest may need adjustment if extension specs change.
2. **Hard Gate, not suggestion** — The HTTP hook enforces context injection at the system level before the agent loop starts. Mid-workflow rules in AGENTS.md provide guidance with conditional re-search to minimize token waste.
3. **Stay out of the inference path** — FocusMemory provides context before prompt assembly. Inference happens directly between client and model. No added latency during tool execution.
4. **Write-back is part of the loop** — Read-only memory is half-baked. `remember_decision` records outcomes to Qdrant so future sessions build on past work instead of repeating it.

---

## Related projects

| Project | Role | Link |
|---------|------|------|
| **FocusMemory** | Memory backend — MCP server, Qdrant indexing, BONSAI pruning | [github.com/edwardyoon/FocusMemory](https://github.com/edwardyoon/FocusMemory) |
| **qwen-code** | Upstream agent runtime (no modifications needed) | [github.com/QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) |
