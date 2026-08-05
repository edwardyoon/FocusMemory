import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import fetch, { Request as NodeRequest } from "node-fetch";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createWriteStream } from "fs";
import { extractQueryFeatures, routeQuery, pruneAndSummarize, inferTopicKey } from "./utils.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";

// Log file for tracking Hook vs MCP tool invocations (visible via `tail -f`)
const LOG_FILE = process.env.FOCUS_LOG_FILE;
let logStream = null;
if (LOG_FILE) {
  logStream = createWriteStream(LOG_FILE, { flags: "a" });
}

function log(...args) {
  const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  if (logStream) logStream.write(line);
}
const BGE_URL = process.env.BGE_URL || "http://127.0.0.1:8080/v1/embeddings";

const qdrant = new QdrantClient({ url: QDRANT_URL });

// Send text to bge-m3 embedding server and get back a vector
async function embed(text) {
  const res = await fetch(BGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: text }),
  });
  const data = await res.json();
  if (data.data && Array.isArray(data.data) && data.data[0]) {
    return data.data[0].embedding;
  }
  if (data.embedding) {
    return data.embedding;
  }
  console.error("Failed to parse embedding response:", JSON.stringify(data).substring(0, 300));
  return null;
}

/**
 * Rerank merged results from multiple collections.
 * Combines cosine score with a recency weight for work_memory entries (§1.4 simplified).
 */
function rerankMerged(allResults) {
  const now = Date.now();
  const DAY_MS = 86400000;

  return allResults
    .map((r) => {
      let recencyScore = 0.5; // neutral default for project_facts (no timestamp)
      if (r.payload.timestamp) {
        const ageDays = (now - new Date(r.payload.timestamp).getTime()) / DAY_MS;
        // Exponential decay: fresh = 1.0, 30 days old ≈ 0.5, 90 days ≈ 0.25
        recencyScore = Math.exp(-ageDays / 30);
      } else if (r.payload.ingested_at) {
        const ageDays = (now - new Date(r.payload.ingested_at).getTime()) / DAY_MS;
        recencyScore = Math.exp(-ageDays / 60); // slower decay for docs
      }

      // α=0.7: cosine score dominates, recency is a tiebreaker
      const alpha = 0.7;
      return { ...r, rerank_score: alpha * r.score + (1 - alpha) * recencyScore };
    })
    .sort((a, b) => b.rerank_score - a.rerank_score);
}

/**
 * Format a single result based on its collection type.
 */
function formatResult(r, collection) {
  if (collection === "work_memory") {
    return `[${r.payload.type}] ${r.payload.summary_text}\n  detail: ${r.payload.detail}\n  files: ${(r.payload.related_files || []).join(", ")}\n  score: ${r.score.toFixed(3)} (rerank: ${r.rerank_score?.toFixed(3)})`;
  } else if (collection === "graph") {
    if (r.payload.kind === "graph_node") {
      return `\`${r.payload.name}\` defined at ${r.payload.file}:${r.payload.line} (${r.payload.lang})\n  score: ${r.score.toFixed(3)}`;
    } else if (r.payload.kind === "graph_edge") {
      return `${r.payload.source_file}:${r.payload.caller_line} ← \`${r.payload.caller_name}\` calls → \`${r.payload.target_name}\`\n  score: ${r.score.toFixed(3)}`;
    }
    return `graph result (score: ${r.score.toFixed(3)})`;
  } else if (collection === "project_facts") {
    return `[${r.payload.source_doc}] ${r.payload.content}\n  score: ${r.score.toFixed(3)} (rerank: ${r.rerank_score?.toFixed(3)})`;
  }
  return `score: ${r.score?.toFixed(3)}`;
}

const server = new McpServer({
  name: "work-memory-mcp",
  version: "1.0.0",
});

// --- Tool 0: unified intelligent search with scoring-based routing (§1.2) ---
server.registerTool(
  "search_memory",
  {
    title: "Search Memory (Unified)",
    description:
      "**ALWAYS call this FIRST before any other tool** (except direct file I/O requests). Intelligently routes a query to the best memory backend — work_memory, project_facts, graph, decision_chains, or any combination. This is the mandatory first step for all tasks: past decisions, architecture knowledge, bug history, code patterns. Only skip for trivial 'read/write this file' requests.",
    inputSchema: {
      query: z.string().describe("Natural language question about the project"),
      limit: z.number().optional().default(5),
    },
  },
  async ({ query, limit }) => {
    log(`[MCP search_memory] source=mcp, query="${query.slice(0, 80)}", limit=${limit}`);

    // Step 1: extract features and score backends (§1.2)
    const features = extractQueryFeatures(query);
    const route = routeQuery(query, features);

    // Separate targets by search mode
    const vectorTargets = route.targets.filter((t) => t !== "graph" && t !== "decision_chains");
    const graphTarget = route.targets.includes("graph") ? "graph" : null;
    const chainTarget = route.primary === "decision_chains" || route.targets.includes("decision_chains")
      ? "decision_chains"
      : null;

    let allResults = [];
    let chainOutput = null;

    // Decision chains: causal query → trace full chain (no BONSAI summary)
    if (chainTarget === "decision_chains") {
      const vector = await embed(query);
      if (vector) {
        const hits = await qdrant.search("decision_chains", { vector, limit: 1 });
        if (hits.length > 0 && hits[0]?.payload?.decision_id) {
          chainOutput = await traceChainInternal(hits[0].payload.decision_id);
        }
      }
    }

    if (vectorTargets.length > 0) {
      // Fetch more raw results for pruning — the LLM will compress them down
      const perCollectionLimit = Math.max(limit * 2, 10);

      // Embed once, reuse for all vector backends
      const vector = await embed(query);

      const searches = vectorTargets.map(async (col) => {
        const results = await qdrant.search(col, {
          vector,
          limit: perCollectionLimit,
          with_payload: true,
        });
        return results.map((r) => ({ ...r, _collection: col }));
      });

      const batches = await Promise.all(searches);
      allResults.push(...batches.flat());
    }

    // Graph backend: keyword-only scroll (§1.4 — no embedding needed)
    if (graphTarget) {
      const graphLimit = Math.max(limit * 2, 10);
      const graphResults = await searchGraph(query, graphLimit);
      allResults.push(...graphResults);
    }

    // If multiple backends contributed results, rerank (§1.4)
    // Note: we do NOT slice here — keep expanded raw set for pruning (§2.5)
    if (allResults.length > 0 && route.mode === "parallel") {
      allResults = rerankMerged(allResults);
    }

    // Build output with routing explanation
    const scoreStr = Object.entries(route.scores)
      .map(([b, s]) => `${b}=${s.toFixed(3)}`)
      .join(", ");
    let output = `Route: ${route.mode} [${route.targets.join(", ")}] | Primary: ${route.primary} | Scores: ${scoreStr}\n`;
    output += `Features: causal=${features.is_causal}, temporal=${features.is_temporal}, structural=${features.is_structural}, id_ratio=${features.identifier_ratio.toFixed(2)}\n\n`;

    // Decision chain output (if causal query matched decision_chains)
    if (chainOutput) {
      output += `## Decision Chain\n${chainOutput}\n`;
    }

    if (allResults.length === 0 && !chainOutput) {
      output += "No matching records found.";
    } else {
      // ── §2.5 Prune & Summarize via lightweight local LLM ──
      const pruned = await pruneAndSummarize(query, allResults);

      if (pruned) {
        output += `## Summary\n${pruned}\n\n`;
      }

      // Always include raw results as reference (sliced to limit)
      // allResults is already sorted (reranked for parallel, cosine-sorted for single target)
      const sliced = allResults.slice(0, limit);

      if (pruned && sliced.length > 3) {
        // When pruned summary exists, show only top-3 raw results as source reference
        const formatted = sliced.slice(0, 3).map((r, i) => `#${i + 1} [${r._collection}] ${formatResult(r, r._collection)}`);
        output += `## Sources (top 3 of ${sliced.length})\n${formatted.join("\n\n")}`;
      } else {
        const formatted = sliced.map((r, i) => `#${i + 1} [${r._collection}] ${formatResult(r, r._collection)}`);
        output += formatted.join("\n\n");
      }
    }

    log(`[MCP search_memory] done, results=${allResults.length}`);
    return { content: [{ type: "text", text: output }] };
  }
);

/**
 * Search the graph backend using keyword payload filters.
 * Extracts function names and file paths from the query to build targeted queries.
 */
async function searchGraph(query, limit) {
  const results = [];
  const lower = query.toLowerCase();

  // Extract function name: English identifier (camelCase/PascalCase/snake_case, 4+ chars)
  // Handles: "callRestAPIAsync를 호출하는 곳", "getCwd() 함수 정의", "foo bar 함수"
  const fnMatch = query.match(/([a-zA-Z_]\w{3,})/);
  const fileMatch = query.match(/[`'"]?([\w/.-]+\.\w{2,4})[`'"]?/);

  if (fnMatch) {
    // Search graph_nodes by function name
    const nodeRes = await qdrant.scroll("graph_nodes", {
      filter: { must: [{ key: "name", match: { value: fnMatch[1] } }] },
      limit,
      with_payload: true,
    });

    for (const p of nodeRes.points) {
      results.push({
        score: 0.95, // keyword exact match → high synthetic score
        payload: { ...p.payload, kind: "graph_node" },
        _collection: "graph",
      });
    }

    // Also search edges (callers of this function)
    const edgeRes = await qdrant.scroll("graph_edges", {
      filter: { must: [{ key: "target_name", match: { value: fnMatch[1] } }] },
      limit,
      with_payload: true,
    });

    for (const p of edgeRes.points) {
      results.push({
        score: 0.85,
        payload: { ...p.payload, kind: "graph_edge" },
        _collection: "graph",
      });
    }
  } else if (fileMatch) {
    // Search graph_nodes by file path
    const nodeRes = await qdrant.scroll("graph_nodes", {
      filter: { must: [{ key: "file", match: { value: fileMatch[1] } }] },
      limit,
      with_payload: true,
    });

    for (const p of nodeRes.points) {
      results.push({
        score: 0.9,
        payload: { ...p.payload, kind: "graph_node" },
        _collection: "graph",
      });
    }
  } else if (isStructuralQuery(lower)) {
    // Structural query without specific identifier — sample recent graph nodes
    const nodeRes = await qdrant.scroll("graph_nodes", { limit, with_payload: true });
    for (const p of nodeRes.points) {
      results.push({
        score: 0.5,
        payload: { ...p.payload, kind: "graph_node" },
        _collection: "graph",
      });
    }
  }

  return results.slice(0, limit);
}

/** Quick structural signal check for graph fallback */
function isStructuralQuery(lower) {
  const korean = new Set(["호출", "의존", "연결"]);
  return /\b(calls?|caller|depends?\s+on)\b/.test(lower) || [...korean].some((w) => lower.includes(w));
}

/**
 * Internal: trace full causal chain from an anchor decision_id.
 * Returns formatted string (same logic as trace_decision_chain tool).
 */
async function traceChainInternal(anchorId) {
  const chain = [];
  const visited = new Set();

  async function getById(id) {
    const results = await qdrant.scroll("decision_chains", {
      filter: { must: [{ key: "decision_id", match: { value: id } }] },
      limit: 1,
      with_payload: true,
    });
    return results.points[0] || null;
  }

  async function walkBackward(id) {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const node = await getById(id);
    if (!node) return;
    chain.unshift(node);
    if (node.payload.supersedes) await walkBackward(node.payload.supersedes);
  }

  async function walkForward(id) {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const node = await getById(id);
    if (!node) return;
    if (!chain.find((c) => c.id === node.id)) chain.push(node);
    if (node.payload.superseded_by) await walkForward(node.payload.superseded_by);
  }

  await walkBackward(anchorId);
  await walkForward(anchorId);

  const topicKey = chain[0]?.payload?.topic_key || "(unknown)";
  let output = `${topicKey} chain (${chain.length} step${chain.length > 1 ? "s" : ""}):\n\n`;

  for (let i = 0; i < chain.length; i++) {
    const n = chain[i].payload;
    const date = new Date(n.created_at).toISOString().split("T")[0];
    const statusTag = n.status === "superseded" ? " (superseded)" : n.status === "active" ? " ← current" : "";
    output += `${i + 1}. [${date}] ${n.content}${statusTag}\n`;
    if (n.reasoning) {
      output += `   → 이유: ${n.reasoning}\n`;
    }
    if (n.file_paths?.length > 0) {
      output += `   → 파일: ${n.file_paths.join(", ")}\n`;
    }
    if (n.supersedes) {
      const supersededIdx = chain.findIndex((c) => c.payload.decision_id === n.supersedes);
      if (supersededIdx >= 0) {
        output += `   → 대체: #${supersededIdx + 1}\n`;
      }
    }
    output += "\n";
  }

  return output;
}

// --- Tool 1: search past work history and decisions ---
server.registerTool(
  "search_work_memory",
  {
    title: "Search Work Memory",
    description:
      "Search past session work history, decisions, and unresolved issues. Always call this before starting coding tasks.",
    inputSchema: {
      query: z.string().describe("Topic or task to search for"),
      project: z
        .enum(["업체창고", "골목창고", "llm_infra", "kilo_setup"])
        .optional(),
      status: z.enum(["open", "resolved", "any"]).optional().default("open"),
    },
  },
  async ({ query, project, status }) => {
    const vector = await embed(query);
    const must = [];
    if (project) must.push({ key: "project", match: { value: project } });
    if (status !== "any") must.push({ key: "status", match: { value: status } });

    const results = await qdrant.search("work_memory", {
      vector,
      filter: must.length ? { must } : undefined,
      limit: 5,
      with_payload: true,
    });

    const text = results
      .map(
        (r) =>
          `[${r.payload.type}] ${r.payload.summary_text}\n  detail: ${r.payload.detail}\n  files: ${(r.payload.related_files || []).join(", ")}\n  score: ${r.score.toFixed(3)}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: text || "No matching records found" }],
    };
  }
);

// --- Tool 2: search project structural knowledge ---
server.registerTool(
  "search_project_facts",
  {
    title: "Search Project Facts",
    description:
      "Search fixed structural knowledge of the project (DB schemas, infrastructure topology, API specs).",
    inputSchema: {
      query: z.string(),
    },
  },
  async ({ query }) => {
    const vector = await embed(query);
    const results = await qdrant.search("project_facts", {
      vector,
      limit: 5,
      with_payload: true,
    });
    const text = results
      .map((r) => `[${r.payload.source_doc}] ${r.payload.content}`)
      .join("\n\n");
    return { content: [{ type: "text", text: text || "No matching documents found" }] };
  }
);

// --- Tool 3: manual record (maps to /remember command) ---
server.registerTool(
  "remember_decision",
  {
    title: "Remember Decision",
    description:
      "Save an important decision, resolved issue, or design change. Stores in both work_memory and decision_chains for causal chain tracking.",
    inputSchema: {
      summary_text: z.string().describe("Brief summary of the decision"),
      detail: z.string().optional().default("").describe("Detailed explanation"),
      reasoning: z.string().optional().default("").describe("Why this decision was made (causal reasoning)"),
      project: z.enum(["업체창고", "골목창고", "llm_infra", "kilo_setup"]).default("업체창고"),
      type: z.enum(["decision", "bug_resolved", "todo"]).default("decision"),
      related_files: z.array(z.string()).optional().default([]),
      topic_key: z.string().optional().default("").describe("Key that groups decisions on the same topic (e.g. discount_threshold). Auto-inferred if empty."),
      supersedes: z.string().optional().default("").describe("decision_id of a previous decision this replaces"),
      caused_by: z.array(z.string()).optional().default([]).describe("Decision IDs or event IDs that triggered this decision"),
    },
  },
  async ({ summary_text, detail, reasoning, project, type, related_files, topic_key, supersedes, caused_by }) => {
    // Save to work_memory (backward compatible)
    const vector = await embed(summary_text);
    if (vector) {
      await qdrant.upsert("work_memory", {
        points: [
          {
            id: crypto.randomUUID(),
            vector,
            payload: {
              type,
              project,
              summary_text,
              detail,
              related_files,
              status: "open",
              timestamp: new Date().toISOString(),
            },
          },
        ],
      });
    }

    // Save to decision_chains (causal chain)
    const decision_id = crypto.randomUUID();
    const resolvedTopic = topic_key || (await inferTopicKey(summary_text));
    const chainContent = `${summary_text}${reasoning ? "\n" + reasoning : ""}`;
    const chainVector = await embed(chainContent);

    if (chainVector) {
      await qdrant.upsert("decision_chains", {
        points: [
          {
            id: decision_id,
            vector: chainVector,
            payload: {
              decision_id,
              content: summary_text,
              reasoning: reasoning || "",
              supersedes: supersedes || null,
              superseded_by: null,
              caused_by,
              topic_key: resolvedTopic,
              file_paths: related_files,
              status: "active",
              node_type: type === "bug_resolved" ? "bug_report" : "decision",
              created_at: new Date().toISOString(),
            },
          },
        ],
      });

      // Update superseded decision — reverse link + status change
      if (supersedes) {
        await qdrant.setPayload("decision_chains", {
          points: [supersedes],
          payload: { superseded_by: decision_id, status: "superseded" },
        });
      }
    }

    return { content: [{ type: "text", text: `Saved successfully. decision_id: ${decision_id}, topic_key: ${resolvedTopic}` }] };
  }
);

// --- Tool 3b: trace causal decision chain ---
server.registerTool(
  "trace_decision_chain",
  {
    title: "Trace Decision Chain",
    description:
      "Reconstruct the full causal chain of decisions for a given topic or decision ID. Returns the timeline of how and why decisions evolved (no BONSAI summarization — structure preserved as-is).",
    inputSchema: {
      query: z.string().optional().default("").describe("Natural language query, e.g. 'discount_threshold logic'"),
      decision_id: z.string().optional().default("").describe("Start from a specific decision ID (alternative to query)"),
      direction: z.enum(["backward", "forward", "both"]).default("both").describe("Traversal direction along the chain"),
    },
  },
  async ({ query, decision_id, direction }) => {
    // Find anchor node
    let anchor = decision_id || null;

    if (!anchor && query) {
      const vector = await embed(query);
      if (vector) {
        const hits = await qdrant.search("decision_chains", { vector, limit: 1 });
        anchor = hits[0]?.payload?.decision_id || null;
      }
    }

    if (!anchor) {
      return { content: [{ type: "text", text: "No related decisions found." }] };
    }

    const chain = [];
    const visited = new Set();

    async function getById(id) {
      const results = await qdrant.scroll("decision_chains", {
        filter: { must: [{ key: "decision_id", match: { value: id } }] },
        limit: 1,
        with_payload: true,
      });
      return results.points[0] || null;
    }

    async function walkBackward(id) {
      if (!id || visited.has(id)) return;
      visited.add(id);
      const node = await getById(id);
      if (!node) return;
      chain.unshift(node);
      if (node.payload.supersedes) await walkBackward(node.payload.supersedes);
    }

    async function walkForward(id) {
      if (!id || visited.has(id)) return;
      visited.add(id);
      const node = await getById(id);
      if (!node) return;
      if (!chain.find((c) => c.id === node.id)) chain.push(node);
      if (node.payload.superseded_by) await walkForward(node.payload.superseded_by);
    }

    if (direction !== "forward") await walkBackward(anchor);
    if (direction !== "backward") await walkForward(anchor);

    // Format output — preserve structure, no BONSAI summary
    const topicKey = chain[0]?.payload?.topic_key || "(unknown)";
    let output = `${topicKey} chain (${chain.length} step${chain.length > 1 ? "s" : ""}):\n\n`;

    for (let i = 0; i < chain.length; i++) {
      const n = chain[i].payload;
      const date = new Date(n.created_at).toISOString().split("T")[0];
      const statusTag = n.status === "superseded" ? " (superseded)" : n.status === "active" ? " ← current" : "";
      output += `${i + 1}. [${date}] ${n.content}${statusTag}\n`;
      if (n.reasoning) {
        output += `   → 이유: ${n.reasoning}\n`;
      }
      if (n.file_paths?.length > 0) {
        output += `   → 파일: ${n.file_paths.join(", ")}\n`;
      }
      if (n.supersedes) {
        const supersededIdx = chain.findIndex((c) => c.payload.decision_id === n.supersedes);
        if (supersededIdx >= 0) {
          output += `   → 대체: #${supersededIdx + 1}\n`;
        }
      }
      output += "\n";
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// --- Tool 4: query code graph (function definitions, call relationships) ---
server.registerTool(
  "query_graph",
  {
    title: "Query Code Graph",
    description:
      "Search the function/call graph for structural queries: 'who calls X?', 'what functions are in Y file?', 'what does Z depend on?'. Use this for code-level dependency questions.",
    inputSchema: {
      query: z.string().describe("Query about code structure, e.g. 'callRestAPIAsync를 호출하는 곳' or 'blogService.js에 정의된 함수'"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, limit }) => {
    const lower = query.toLowerCase();

    // Detect intent from the query pattern
    let mode = "function"; // default: search function definitions by name
    let targetName = null;
    let targetFile = null;

    // Extract file path if present (e.g. "*.js", "*.php", or specific paths)
    const fileMatch = query.match(/[`'"]?([\w/.-]+\.\w{2,4})[`'"]?/);
    if (fileMatch) {
      targetFile = fileMatch[1];
      mode = "by_file";
    }

    // Extract function name: look for patterns like "X를 호출하는 곳", "X 함수 정의"
    const fnNameMatch = query.match(/([\w]+)(?:\s*(?:함수|function|메서드|method))?/);
    if (fnNameMatch && !fileMatch) {
      targetName = fnNameMatch[1];
      // Check if it's a "who calls X" pattern
      if (/호출하는|calls?|callers?|의존|dependent/.test(lower)) {
        mode = "reverse_call";
      } else if (/정의|defined|definition|위치|where/.test(lower)) {
        mode = "function";
      } else if (/사용|use|depend|dependency|호출.*하는/.test(lower)) {
        mode = "forward_call";
      }
    }

    let output = "";

    // ── Mode: find function definitions by name ──────────────────────
    if (mode === "function" && targetName) {
      const results = await qdrant.scroll("graph_nodes", {
        filter: { must: [{ key: "name", match: { value: targetName } }] },
        limit,
        with_payload: true,
      });

      if (results.points.length === 0) {
        output = `No function "${targetName}" found in graph index.`;
      } else {
        output = `Function "${targetName}" definitions:\n\n`;
        for (const r of results.points) {
          const p = r.payload;
          output += `- ${p.file}:${p.line} (${p.lang})\n`;
        }
      }

      // Also show callers if available
      const edges = await qdrant.scroll("graph_edges", {
        filter: { must: [{ key: "target_name", match: { value: targetName } }] },
        limit,
        with_payload: true,
      });

      if (edges.points.length > 0) {
        output += `\nCalled from (${Math.min(edges.points.length, limit)} of ${edges.points.length}):\n\n`;
        for (const e of edges.points.slice(0, limit)) {
          const p = e.payload;
          output += `- ${p.source_file}:${p.caller_line} ← via \`${p.caller_name}\`\n`;
        }
      }
    }

    // ── Mode: find callers of a function (reverse dependency) ───────
    else if (mode === "reverse_call" && targetName) {
      const edges = await qdrant.scroll("graph_edges", {
        filter: { must: [{ key: "target_name", match: { value: targetName } }] },
        limit,
        with_payload: true,
      });

      if (edges.points.length === 0) {
        output = `No callers found for "${targetName}" in graph index.`;
      } else {
        output = `Callers of "${targetName}" (${edges.points.length} total):\n\n`;
        // Group by source file
        const byFile = {};
        for (const e of edges.points) {
          const f = e.payload.source_file;
          if (!byFile[f]) byFile[f] = [];
          byFile[f].push(e.payload);
        }

        let i = 0;
        for (const [file, callers] of Object.entries(byFile)) {
          output += `\`${file}\` (${callers.length} calls):\n`;
          for (const c of callers) {
            output += `  - line ${c.caller_line}: \`${c.caller_name}()\`\n`;
            i++;
            if (i >= limit) break;
          }
          if (i >= limit) break;
        }
      }
    }

    // ── Mode: find functions defined in a file ───────────────────────
    else if (mode === "by_file" && targetFile) {
      const results = await qdrant.scroll("graph_nodes", {
        filter: { must: [{ key: "file", match: { value: targetFile } }] },
        limit,
        with_payload: true,
      });

      if (results.points.length === 0) {
        output = `No functions found in "${targetFile}" or file not indexed.`;
      } else {
        output = `Functions in \`${targetFile}\` (${results.points.length}):\n\n`;
        for (const r of results.points) {
          const p = r.payload;
          output += `- \`${p.name}\` → line ${p.line}\n`;
        }
      }

      // Also show edges from this file
      const edges = await qdrant.scroll("graph_edges", {
        filter: { must: [{ key: "source_file", match: { value: targetFile } }] },
        limit,
        with_payload: true,
      });

      if (edges.points.length > 0) {
        output += `\nInternal calls (${Math.min(edges.points.length, 5)} of ${edges.points.length}):\n\n`;
        for (const e of edges.points.slice(0, 5)) {
          const p = e.payload;
          output += `- line ${p.caller_line}: \`${p.caller_name}()\` → \`${p.target_name}\`\n`;
        }
      }
    }

    // ── Mode: forward dependency — what does X call? ────────────────
    else if (mode === "forward_call" && targetName) {
      const edges = await qdrant.scroll("graph_edges", {
        filter: { must: [{ key: "caller_name", match: { value: targetName } }] },
        limit,
        with_payload: true,
      });

      if (edges.points.length === 0) {
        output = `No outgoing calls found for "${targetName}" in graph index.`;
      } else {
        // Deduplicate targets
        const uniqueTargets = new Map();
        for (const e of edges.points) {
          const key = `${e.payload.target_name}::${e.payload.source_file}`;
          if (!uniqueTargets.has(key)) {
            uniqueTargets.set(key, e.payload);
          }
        }

        output = `\`${targetName}\` calls (${uniqueTargets.size} unique targets):\n\n`;
        for (const [, p] of uniqueTargets) {
          output += `- \`${p.target_name}\` in ${p.source_file}:${p.caller_line}\n`;
        }
      }
    }

    // ── Default: broad name search across both collections ───────────
    else {
      // Try matching as function name (partial)
      const nodeResults = await qdrant.scroll("graph_nodes", { limit, with_payload: true });
      output = `Graph index contains ${nodeResults.points.length} indexed functions.\n\n`;
      output += `Query patterns:\n`;
      output += `- "X 함수 정의" → find function X\n`;
      output += `- "X를 호출하는 곳" → reverse dependency of X\n`;
      output += `- "X가 호출하는 것" → forward calls from X\n`;
      output += `- "file.js에 정의된 함수" → functions in file.js\n\n`;

      // Show sample nodes
      output += `Sample indexed functions:\n`;
      for (const r of nodeResults.points.slice(0, 5)) {
        const p = r.payload;
        output += `- \`${p.name}\` → ${p.file}:${p.line} (${p.lang})\n`;
      }

      // Count edges too
      const edgeCount = await qdrant.count("graph_edges");
      output += `\nTotal call edges: ${edgeCount.count}`;
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// --- Tool 5: web search via local search server ---
server.registerTool(
  "search_web",
  {
    title: "Search Web",
    description:
      "Search the web using a local search server. Returns results from multiple engines (Wikipedia, Google CSE, etc.). Use for general knowledge questions or when project memory has no matching records.",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5),
    },
  },
  async ({ query, limit }) => {
    const url = new URL("http://localhost:18080/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        return { content: [{ type: "text", text: `Search server returned HTTP ${res.status}` }] };
      }

      const data = await res.json();
      const results = (data.results || []).slice(0, limit);

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No web results for "${query}"` }] };
      }

      const formatted = results.map((r, i) => {
        let line = `#${i + 1} ${r.title}\n  url: ${r.url}`;
        if (r.engine) line += `\n  engine: ${Array.isArray(r.engine) ? r.engine.join(", ") : r.engine}`;
        if (r.score != null) line += ` (score: ${r.score})`;
        if (r.content) line += `\n  content: ${r.content.substring(0, 200)}`;
        return line;
      });

      const text = `Web search results for "${data.query}" (${results.length} results):\n\n${formatted.join("\n\n")}`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Search request failed: ${err.message}` }] };
    }
  }
);

// --- Tool 6: semantic code search (natural language → vector similarity on code_chunks) ---
server.registerTool(
  "search_code",
  {
    title: "Semantic Code Search",
    description:
      "Search the codebase semantically using natural language. Use for questions like 'API 키 생성하는 로직', 'DB 연결 pooling 처리'. For exact symbol lookups, prefer query_graph instead.",
    inputSchema: {
      query: z.string().describe("Natural language code search query (e.g. 'API 인증 토큰 생성')"),
      language: z.string().optional().describe("Language filter: php, javascript, typescript (optional)"),
      entity_type: z.enum(["function", "method", "class"]).optional().describe("Entity type filter (optional)"),
      min_score: z.number().optional().default(0.4).describe("Similarity threshold (default 0.4, Kilo Code baseline)"),
      limit: z.number().optional().default(10).describe("Max results (default 10, max 50)"),
    },
  },
  async ({ query, language, entity_type, min_score = 0.4, limit = 10 }) => {
    log(`[MCP search_code] source=mcp, query="${query.slice(0, 80)}", lang=${language || "any"}, limit=${limit}`);

    const vector = await embed(query);
    if (!vector) {
      return { content: [{ type: "text", text: "Embedding failed — BGE server may be down." }] };
    }

    const must = [];
    if (language) must.push({ key: "language", match: { value: language } });
    if (entity_type) must.push({ key: "entity_type", match: { value: entity_type } });

    try {
      const results = await qdrant.search("code_chunks", {
        vector,
        filter: must.length > 0 ? { must } : undefined,
        score_threshold: min_score,
        limit: Math.min(limit, 50),
        with_payload: true,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `코드베이스에서 "${query}"와 일치하는 결과가 없습니다.` }] };
      }

      const formatted = results.map((r, i) => {
        const p = r.payload;
        const snippetLang = p.language === "javascript" ? "js" : p.language;
        return `#${i + 1} \`${p.entity_name}\` (${p.entity_type})\n  file: ${p.file_path}:${p.start_line}-${p.end_line}\n  lang: ${p.language} | score: ${r.score.toFixed(3)}\n  snippet:\n\`\`\`${snippetLang}\n${p.content.slice(0, 500)}\n\`\`\``;
      });

      const text = `Semantic code search results for "${query}" (${results.length} matches):\n\n${formatted.join("\n\n")}`;
      log(`[MCP search_code] done, results=${results.length}`);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      if (err.message && err.message.includes("not found")) {
        return { content: [{ type: "text", text: "code_chunks 컬렉션이 존재하지 않습니다. 먼저 'npm run create-collections'와 'npm run index-chunks'를 실행하세요." }] };
      }
      throw err;
    }
  }
);

// ─── HTTP Server: Generic Search V1 / UserPromptSubmit Hook endpoint ───

const httpApp = new Hono();
const API_TOKEN = process.env.CONTEXT_API_TOKEN || "focus-memory-local";

/**
 * Shared search core — reused by both MCP tool and HTTP hook.
 * Returns { allResults, route } from Qdrant vector + graph search.
 */
async function doSearch(query) {
  const features = extractQueryFeatures(query);
  const route = routeQuery(query, features);

  const vectorTargets = route.targets.filter((t) => t !== "graph");
  const graphTarget = route.targets.includes("graph") ? "graph" : null;

  let allResults = [];

  // Embed once if any vector backend is targeted (needed for both routeQuery targets and code_chunks)
  const shouldEmbed = vectorTargets.length > 0 || graphTarget;
  let vector = null;
  if (shouldEmbed) {
    vector = await embed(query);
  }

  if (vectorTargets.length > 0) {
    const perCollectionLimit = 10;

    const searches = vectorTargets.map(async (col) => {
      const results = await qdrant.search(col, {
        vector,
        limit: perCollectionLimit,
        with_payload: true,
      });
      return results.map((r) => ({ ...r, _collection: col }));
    });

    const batches = await Promise.all(searches);
    allResults.push(...batches.flat());
  }

  if (graphTarget) {
    const graphResults = await searchGraph(query, 10);
    allResults.push(...graphResults);
  }

  // Also search code_chunks for semantic code matches
  if (vector != null) {
    try {
      const codeChunksResults = await qdrant.search("code_chunks", {
        vector,
        limit: 5,
        score_threshold: 0.4,
        with_payload: true,
      });
      allResults.push(...codeChunksResults.map((r) => ({ ...r, _collection: "code_chunks" })));
    } catch {
      // code_chunks collection may not exist yet — skip silently
    }
  }

  if (allResults.length > 0 && route.mode === "parallel") {
    allResults = rerankMerged(allResults);
  }

  return { allResults, route };
}

/** Format a result title from payload for display */
function getTitleFromPayload(payload) {
  if (!payload) return "";
  if (payload.summary_text) return payload.summary_text;
  if (payload.content) return payload.content.substring(0, 120);
  if (payload.name && payload.file) return `${payload.name} @ ${payload.file}`;
  if (payload.caller_name && payload.target_name) return `${payload.caller_name} → ${payload.target_name}`;
  return JSON.stringify(payload).substring(0, 120);
}

httpApp.post("/v1/context/search", async (c) => {
  // Auth check
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (token !== API_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ hookEventName: "UserPromptSubmit", additionalContext: "" });
  }

  const query = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!query) {
    return c.json({ hookEventName: "UserPromptSubmit", additionalContext: "" });
  }

  log(`[Hook /v1/context/search] source=hook, query="${query.slice(0, 80)}"`);

  // Search core (same logic as search_memory MCP tool)
  let allResults;
  try {
    const result = await doSearch(query);
    allResults = result.allResults;
  } catch (err) {
    log(`[Hook /v1/context/search] search failed: ${err.message}`);
    return c.json({ hookEventName: "UserPromptSubmit", additionalContext: "" });
  }

  if (!allResults || allResults.length === 0) {
    return c.json({ hookEventName: "UserPromptSubmit", additionalContext: "" });
  }

  // BONSAI prune & summarize (graceful fallback)
  let prunedSummary = null;
  try {
    prunedSummary = await pruneAndSummarize(query, allResults);
  } catch (err) {
    log(`[Hook /v1/context/search] prune failed: ${err.message}`);
  }

  log(`[Hook /v1/context/search] done, results=${allResults.length}, summary=${prunedSummary ? 'yes' : 'no'}`);

  // Build UserPromptSubmitOutput.additionalContext
  const sliced = allResults.slice(0, prunedSummary ? 3 : 5);
  let additionalContext = "## 검색 결과 (자동 주입)\n\n";

  if (prunedSummary) {
    additionalContext += `### 요약\n${prunedSummary}\n\n`;
    additionalContext += `### 출처 (top ${Math.min(sliced.length, allResults.length)} of ${allResults.length})\n`;
  }

  sliced.forEach((r, i) => {
    const col = r._collection || "unknown";
    const title = getTitleFromPayload(r.payload);
    additionalContext += `${i + 1}. **${col}** — ${title}\n`;
    if (!prunedSummary) {
      additionalContext += `   ${formatResult(r, col)}\n`;
    }
  });

  return c.json({ hookEventName: "UserPromptSubmit", additionalContext });
});

// ─── Start servers ───

const banner = [
  "       /\\_/\\   ",
  "      ( o.o )   \"Grep finds code.",
  "       > ^ <     Vectors find meaning.",
  "      /     \\    I remember why.\"",
  "     | |   | |",
  "     (_)_)(_)=[]=============>  (FocusMemory Katana)",
  "",
  "  [ focus-memory v0.1.0 — Agentic Memory Runtime ]",
];

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(banner.join("\n"));
console.error("[FocusMemory] MCP stdio server ready");

// HTTP server (parallel — separate TCP port, does not interfere with stdio)
const httpPort = parseInt(process.env.HTTP_PORT || "3900", 10);
try {
  const httpServer = await serve({ fetch: httpApp.fetch, port: httpPort });
  console.error(`[FocusMemory] HTTP server listening on :${httpPort}`);
  // serve() resolves when listen() callback fires, but actual bind errors
  // are emitted asynchronously as 'error' events — catch them to avoid crashing MCP stdio.
  if (httpServer && typeof httpServer.on === "function") {
    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[FocusMemory] HTTP port ${httpPort} already in use — running MCP stdio only`);
      } else {
        console.error("[FocusMemory] HTTP server error:", err.message);
      }
    });
  }
} catch (err) {
  if (err.code === "EADDRINUSE") {
    console.error(`[FocusMemory] HTTP port ${httpPort} already in use — running MCP stdio only`);
  } else {
    console.error("[FocusMemory] HTTP server failed:", err.message);
  }
}
