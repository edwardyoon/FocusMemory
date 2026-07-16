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
| **Work history** | 🟢 running | Custom MCP server — facts + session history, queryable by connected clients |
| **Knowledge base** | 🟢 running | Qdrant — vector index over code and notes |
| **Client adapters** | 🟢 running | Kilo Code, Qwen Code |
| Graph index (structural queries) | ⚪ planned | tree-sitter based symbol/call graph |
| Schema snapshot + drift detector | ⚪ planned | DB introspection, diffed against code assumptions |
| Decision log auto-extraction | ⚪ planned | Session-end summarization, written back with provenance |
| Query router | ⚪ planned | Dispatch by query type — graph / vector / snapshot |
| Freshness metadata | ⚪ planned | `last_verified_at` on every returned fact |

v0 is deliberately narrow: **an MCP server exposing facts and work history, backed by Qdrant, wired into Kilo Code and Qwen Code.** Everything in the philosophy above — routing precision, drift detection, decision logs — is the direction, not a claim about what's shipped.

<br>

---

## Why "memory infrastructure," not another vector DB

Most tools in this space stop at semantic search: embed the code, query it, done. That solves *finding text*. It doesn't solve:

- knowing whether what you found is still true
- knowing why it was built that way
- knowing that the database has already moved on without the code noticing

FocusMemory treats those as first-class problems, not edge cases. Read-only retrieval is the easy 80%. The other 20% — write-back, freshness, provenance — is where the actual value is, and where v0 is headed next.

<br>

---

## Getting started

```bash
git clone https://github.com/<your-org>/focusmemory
cd focusmemory
```

```bash
# point it at your Qdrant instance
focusmemory configure --qdrant-url http://localhost:6333

# register a client
focusmemory connect kilo-code
focusmemory connect qwen-code
```

Full setup docs are being written alongside the code — this section will expand as the CLI stabilizes.

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
