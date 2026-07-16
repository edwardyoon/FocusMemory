<div align="center">

# FocusMemory

**Memory infrastructure for agentic coding.**

</div>

<br>

> The bottleneck isn't model intelligence anymore. It's the information architecture in front of it.

FocusMemory cuts round-trips through routing precision, minimizes re-injection through caching and chunking, and stays current through real-time incremental indexing — removing the friction between what the model knows and what the agent can actually do.

<br>

---

## The problem

> Grep finds the code. Vectors find the meaning. Neither remembers the decision that made it true.

| | |
|---|---|
| **01 — Search is stateless** | Every session re-discovers the same files, re-reasons about the same architecture, from scratch. Round-trips accumulate. Context gets re-injected. Tokens burn. |
| **02 — Schema drifts silently** | What the code assumes about your database and what's actually running diverge — and nothing catches it until something breaks. |
| **03 — Decisions vanish** | Why a column was added, why a threshold was chosen — buried in a chat log that's gone the moment the session ends. |

<br>

## What we focus on

| Fixes | |
|---|---|
| `A` **Routing precision** → 01 | Structural queries hit the graph index, semantic queries hit the vector index — one call, not five. |
| `B` **Schema snapshots** → 02 | Real DB state is indexed alongside code, with drift detection surfaced automatically. |
| `C` **Decision log** → 03 | Session outcomes are captured and written back — the next agent starts where the last one left off. |

<br>

---

## Architecture

```
┌───────────────┐        query / write        ┌────────────────────┐        prompt / completion        ┌───────────────┐
│    Clients    │ ───────────────────────────▶ │    FocusMemory     │ ─────────────────────────────────▶ │    Models     │
│ Kilo · Qwen   │ ◀─────────────────────────── │  work history       │                                    │ local · cloud │
│ Chat UI       │        context inject         │  knowledge base     │                                    │               │
└───────────────┘                              └────────────────────┘                                    └───────────────┘
```

FocusMemory is not a proxy in the inference path. Clients query it for context *before* assembling a prompt, and write session outcomes back *after*. Model calls happen directly, client to model — FocusMemory never adds latency to inference itself.

<br>

---

## Current scope (v0)

This project is being built in the open, one honest layer at a time. Here's exactly what exists today — not the whole vision, just what's real right now.

| Layer | Status | Backing |
|---|---|---|
| **Work history** | 🟢 running | `work-memory-mcp/` — MCP server exposing facts + session history via 3 tools |
| **Knowledge base** | 🟢 running | Qdrant — vector index over docs and plans, ingested by CLI scripts |
| **Client adapters** | 🟢 running | Kilo Code (MCP), Qwen Code (MCP) |
| Graph index (structural queries) | ⚪ planned | tree-sitter based symbol/call graph |
| Schema snapshot + drift detector | ⚪ planned | DB introspection, diffed against code assumptions |
| Decision log auto-extraction | ⚪ planned | Session-end summarization, written back with provenance |
| Query router | ⚪ planned | Dispatch by query type — graph / vector / snapshot |
| Freshness metadata | ⚪ planned | `last_verified_at` on every returned fact |

v0 is deliberately narrow: **an MCP server exposing facts and work history, backed by Qdrant, wired into Kilo Code and Qwen Code.** Everything in the philosophy above — routing precision, drift detection, decision logs — is the direction, not a claim about what's shipped.

<br>

# Routing precision & re-injection minimization

Design notes for FocusMemory v0. This covers two of the three core mechanisms from the philosophy statement — routing precision and re-injection minimization — with a rough algorithmic sketch for each. Not production-hardened; this is the shape to build MVP against.

<br>

---

## 1. Routing precision

**Core idea:** decompose the query into a handful of signals, score each backend's confidence against those signals, and route by argmax — falling back to parallel retrieval + rerank when the scores are close.

### 1.1 Feature extraction

```python
def extract_features(query: str) -> dict:
    return {
        "identifier_ratio": count_code_identifier_tokens(query) / len(tokenize(query)),
        # regex: snake_case, camelCase, file-path patterns, etc.
        "is_causal": bool(re.search(r"why|because|threshold|decision", query)),
        "is_structural": bool(re.search(r"calls|caller|impact|depends on", query)),
        "is_temporal": bool(re.search(r"when|latest|version|recent", query)),
    }
```

### 1.2 Routing score function

For each backend $b \in \{\text{lexical}, \text{vector}, \text{history}\}$:

$$
\text{score}(b, q) = w_1 \cdot \text{sim}_b(q) + w_2 \cdot \text{specificity}(q, b) + w_3 \cdot \text{recency\_prior}(b)
$$

where:

- $\text{sim}_b(q)$ — the backend's own top-1 confidence. Normalized BM25 score for lexical, top-1 cosine similarity from Qdrant for vector.
- $\text{specificity}(q, b)$ — fit between extracted query features and the backend (high `identifier_ratio` favors lexical; `is_causal` favors history).
- $\text{recency\_prior}(b)$ — light session-local momentum toward a backend that answered well recently. Can be initialized to 0 for v0.

Route to:

$$
b^* = \arg\max_{b} \; \text{score}(b, q)
$$

### 1.3 MVP simplification

The full scoring function is overkill for v0. A simpler decision tree gets most of the value:

```python
def route(query, features):
    if features["identifier_ratio"] > 0.3:
        return ["lexical_or_qdrant_exact"]  # exact symbol names → exact match first
    if features["is_causal"] or features["is_temporal"]:
        return ["work_history_mcp"]         # "why", "when" → decision log first
    return ["qdrant_vector"]                # default: semantic
```

### 1.4 Ambiguous cases — parallel retrieval + rerank

When two backends' scores fall within a threshold of each other:

$$
|\text{score}(b_1, q) - \text{score}(b_2, q)| < \epsilon \;\Rightarrow\; \text{fetch top-}k \text{ from both, rerank}
$$

For v0, skip a cross-encoder reranker — recompute query–chunk cosine similarity plus a recency weight and combine:

$$
\text{rerank\_score}(r) = \alpha \cdot \cos(\text{embed}(q), \text{embed}(r)) + (1-\alpha) \cdot \text{recency}(r)
$$

<br>

---

## 2. Re-injection minimization

Three levers: **deduplication**, **budget-constrained selection (knapsack)**, and **session-level caching**.

### 2.1 Deduplication against already-injected context

Maintain the embedding set $S$ of chunks already injected this session:

$$
\text{sim\_max}(r_i) = \max_{s \in S} \cos\big(\text{embed}(r_i), \text{embed}(s)\big)
$$

$$
\text{keep}(r_i) = \text{sim\_max}(r_i) < \tau \quad (\tau \approx 0.92)
$$

This filters out semantically redundant information, not just exact string duplicates — stronger than hash-based dedup.

```python
def dedupe(candidates, injected_set, tau=0.92):
    kept = []
    for r in candidates:
        sim_max = max((cos_sim(r.embedding, s.embedding) for s in injected_set), default=0)
        if sim_max < tau:
            kept.append(r)
            injected_set.add(r)
    return kept
```

### 2.2 Budget-constrained selection — knapsack approximation

Given a total context budget $B$ (tokens), candidate $i$ with relevance $rel_i$ and token cost $tok_i$:

$$
\max \sum_i rel_i \cdot x_i \quad \text{subject to} \quad \sum_i tok_i \cdot x_i \le B,\ x_i \in \{0, 1\}
$$

Exact knapsack is unnecessary here — a greedy pass on value density is a good enough approximation:

$$
\text{density}_i = \frac{rel_i}{tok_i}
$$

```python
def select_within_budget(candidates, budget):
    candidates.sort(key=lambda r: r.relevance / r.token_cost, reverse=True)
    selected, used = [], 0
    for r in candidates:
        if used + r.token_cost <= budget:
            selected.append(r)
            used += r.token_cost
    return selected
```

### 2.3 Session-level query cache

Bucket query embeddings (e.g. via LSH) so a near-duplicate query within the same session skips a fresh Qdrant call:

$$
\text{cache\_hit}(q) = \exists\, q' \in \text{session\_cache} : \cos\big(\text{embed}(q), \text{embed}(q')\big) > 0.95
$$

### 2.4 Coupling with inference-engine caching (llama.cpp)

If the injected context is placed as a fixed prefix at the start of each turn's prompt, the KV cache can be reused across turns as long as the prefix hasn't changed:

$$
\text{reuse\_kv} = \Big(\text{hash}(\text{injected\_context}_t) = \text{hash}(\text{injected\_context}_{t-1})\Big)
$$

This maps directly onto `llama.cpp`'s `--cache-prompt` flag — the effect should be directly measurable on local inference setups.

<br>

---

## Summary

| Mechanism | Pipeline |
|---|---|
| Routing precision | query → feature extraction → per-backend score → argmax (or parallel + rerank if ambiguous) |
| Re-injection minimization | candidates → embedding-based dedup → budget-constrained greedy selection → session query cache → fixed-prefix KV reuse |

**Suggested build order for v0:** implement §2.1 (dedup) and §2.2 (budget selection) first — highest ROI, lowest complexity. §2.3 (session cache) and §2.4 (KV coupling) are reasonable v0.2 additions once the base loop is proven.

---

## Why "memory infrastructure," not another vector DB

Most tools in this space stop at semantic search: embed the code, query it, done. That solves *finding text*. It doesn't solve:

- knowing whether what you found is still true
- knowing why it was built that way
- knowing that the database has already moved on without the code noticing

FocusMemory treats those as first-class problems, not edge cases. Read-only retrieval is the easy 80%. The other 20% — write-back, freshness, provenance — is where the actual value is, and where v0 is headed next.

<br>

---

## Project structure

```
FocusMemory/
├── README.md
└── work-memory-mcp/          # MCP server (v0 core)
    ├── index.js              # MCP server — 3 tools: search_work_memory, search_project_facts, remember_decision
    ├── createCollection.js   # Initialize Qdrant collections & payload indexes
    ├── ingestDocs.js         # Chunk + embed docs/*.md → project_facts collection
    ├── ingestPlans.js        # Chunk + embed plans/*.md → work_memory collection
    ├── testSearch.js         # Ad-hoc search utility
    └── package.json
```

## Getting started

### 1. Set up Qdrant collections

```bash
cd work-memory-mcp
npm install
QDRANT_URL=http://localhost:6333 npm run create-collections
```

This creates two collections — `work_memory` (session history, decisions) and `project_facts` (docs, schema knowledge) — with payload indexes for filtered search.

### 2. Ingest your project docs

```bash
# Chunk + embed all docs/*.md → project_facts
QDRANT_URL=http://localhost:6333 BGE_URL=http://localhost:8080/v1/embeddings \
  QWEN_URL=http://localhost:8080/v1/chat/completions npm run ingest-docs

# Re-ingest a single file (idempotent — deletes old chunks first)
npm run ingest-docs db-schema.md

# Ingest plans/*.md + plans/done/*.md → work_memory
npm run ingest-plans
```

### 3. Start the MCP server

```bash
QDRANT_URL=http://localhost:6333 BGE_URL=http://localhost:8080/v1/embeddings \
  npm start
```

Configure your client (Kilo Code, Qwen Code) to connect via stdio transport and you get three tools:

| Tool | Purpose |
|---|---|
| `search_work_memory` | Past decisions, resolved issues, open todos |
| `search_project_facts` | DB schemas, infra topology, API specs |
| `remember_decision` | Write a new decision/fact into work_memory |

<br>

---

## Design principles

1. **Local-first.** No mandatory cloud dependency. Your code, your schema, your decisions stay on your infrastructure.
2. **Read fast, write honest.** Retrieval is cheap and instant. Writes (decision logs, schema snapshots) are deliberate and provenance-tagged.
3. **Stay out of the inference path.** FocusMemory augments the prompt. It never sits between client and model.
4. **No feature before its foundation.** Nothing above ships until the layer below it is solid. v0 proves the loop; everything else builds on it.

<br>

---

## Contributing

This project is early and the architecture is still being pressure-tested against real usage. Issues, design critiques, and adapter contributions (new clients, new storage backends) are welcome — especially if you can point at a gap between what's documented here and what the code actually does.

<br>

---

<div align="center">

`FIG.03 / SELF-HOSTED / MIT`

</div>
