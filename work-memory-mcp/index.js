import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import fetch from "node-fetch";
import { extractQueryFeatures, routeQuery } from "./utils.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
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
      "Intelligently route a query to the best memory backend. Analyzes the query and searches work_memory, project_facts, graph, or any combination — no need to pick manually.",
    inputSchema: {
      query: z.string().describe("Natural language question about the project"),
      limit: z.number().optional().default(5),
    },
  },
  async ({ query, limit }) => {
    // Step 1: extract features and score backends (§1.2)
    const features = extractQueryFeatures(query);
    const route = routeQuery(query, features);

    // Separate targets by search mode
    const vectorTargets = route.targets.filter((t) => t !== "graph");
    const graphTarget = route.targets.includes("graph") ? "graph" : null;

    let allResults = [];

    if (vectorTargets.length > 0) {
      const perCollectionLimit = Math.max(limit, 3);

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
      const graphResults = await searchGraph(query, limit);
      allResults.push(...graphResults);
    }

    // If multiple backends contributed results, rerank (§1.4)
    if (allResults.length > 0 && route.mode === "parallel") {
      allResults = rerankMerged(allResults).slice(0, limit);
    } else if (allResults.length > 0 && vectorTargets.length === 1 && !graphTarget) {
      // Single vector target — keep original order (already sorted by cosine)
      allResults = allResults.slice(0, limit);
    }

    // Build output with routing explanation
    const scoreStr = Object.entries(route.scores)
      .map(([b, s]) => `${b}=${s.toFixed(3)}`)
      .join(", ");
    let output = `Route: ${route.mode} [${route.targets.join(", ")}] | Primary: ${route.primary} | Scores: ${scoreStr}\n`;
    output += `Features: causal=${features.is_causal}, temporal=${features.is_temporal}, structural=${features.is_structural}, id_ratio=${features.identifier_ratio.toFixed(2)}\n\n`;

    if (allResults.length === 0) {
      output += "No matching records found.";
    } else {
      const formatted = allResults.map((r, i) => `#${i + 1} [${r._collection}] ${formatResult(r, r._collection)}`);
      output += formatted.join("\n\n");
    }

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
    description: "Immediately save an important decision or resolved issue to work_memory.",
    inputSchema: {
      summary_text: z.string(),
      detail: z.string().optional().default(""),
      project: z.enum(["업체창고", "골목창고", "llm_infra", "kilo_setup"]),
      type: z.enum(["decision", "bug_resolved", "todo"]),
      related_files: z.array(z.string()).optional().default([]),
    },
  },
  async ({ summary_text, detail, project, type, related_files }) => {
    const vector = await embed(summary_text);
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
    return { content: [{ type: "text", text: "Saved successfully" }] };
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

const transport = new StdioServerTransport();
await server.connect(transport);
