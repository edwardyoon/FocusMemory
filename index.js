import dotenv from "dotenv";
import { fileURLToPath } from "url";
const __dirname = new URL(".", import.meta.url).pathname;
dotenv.config({ override: true, quiet: true, path: __dirname + ".env" }); // .env 우선(절대경로). quiet:true 필수 — dotenv v17이 stdout에 배너를 출력하면 MCP stdio JSON-RPC 프레임이 깨진다
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Meilisearch } from "meilisearch";
import { z } from "zod";
import fetch, { Request as NodeRequest } from "node-fetch";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { extractQueryFeatures, routeQuery, pruneAndSummarize, inferTopicKey, cosineSimilarity, resolveFilePath } from "./lib/utils.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const MEILI_HOST = process.env.MEILI_HOST || "http://localhost:7700";
const MEILI_INDEX = process.env.MEILI_INDEX || "docs_plans";
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY;

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

const QDRANT_TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS || "10000", 10);
const MEILI_TIMEOUT_MS = parseInt(process.env.MEILI_TIMEOUT_MS || "8000", 10);

const qdrant = new QdrantClient({ url: QDRANT_URL, timeout: QDRANT_TIMEOUT_MS });

/**
 * Promise.race-based timeout wrapper.
 * Rejects with a descriptive error if the operation exceeds ms.
 */
async function withTimeout(promise, ms, label = "operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compatibility wrapper for Qdrant v1.x — replaces the deleted search() API.
 * Old API:  qdrant.search(col, { vector, filter, limit, with_payload, score_threshold }) → [{ id, score, payload }]
 * New API:  qdrant.query(col,  { query, ...rest }) → { points: [{ id, score, payload }] }
 */
async function qSearch(collection, opts = {}) {
  const { vector, filter, limit, with_payload, score_threshold } = opts;
  const result = await withTimeout(
    qdrant.query(collection, {
      query: vector,
      ...(filter && { filter }),
      ...(limit != null && { limit }),
      ...(with_payload && { with_payload }),
      ...(score_threshold != null && { score_threshold }),
    }),
    QDRANT_TIMEOUT_MS,
    `qSearch(${collection})`
  );
  return (result.points || []).map((p) => ({ id: p.id, score: p.score ?? 0, payload: p.payload }));
}

// Meilisearch client for docs/plans text search
let meiliIndex = null;
if (MEILI_MASTER_KEY) {
  const meiliClient = new Meilisearch({ host: MEILI_HOST, apiKey: MEILI_MASTER_KEY });
  meiliIndex = meiliClient.index(MEILI_INDEX);
}

// Meilisearch client for code structure search
const MEILI_CODE_STRUCTURE_INDEX = process.env.MEILI_CODE_STRUCTURE_INDEX || "code_structure";
let meiliCodeStructureIndex = null;
if (MEILI_MASTER_KEY) {
  const meiliClientForStruct = new Meilisearch({ host: MEILI_HOST, apiKey: MEILI_MASTER_KEY });
  meiliCodeStructureIndex = meiliClientForStruct.index(MEILI_CODE_STRUCTURE_INDEX);
}

/**
 * Search code structure via Meilisearch.
 */
async function searchCodeStructure(query, options = {}) {
  if (!meiliCodeStructureIndex) return [];

  const { language, limit = 10 } = options;
  const filter = language ? `language = '${language}'` : null;

  try {
    const result = await withTimeout(
      meiliCodeStructureIndex.search(query, {
        limit,
        filter,
        attributesToRetrieve: ["filepath", "filename", "dirname", "extension", "language", "entities", "entity_names", "imports", "line_count", "description"],
      }),
      MEILI_TIMEOUT_MS,
      "searchCodeStructure"
    );

    return result.hits.map((h) => ({
      filepath: h.filepath,
      filename: h.filename,
      dirname: h.dirname,
      language: h.language,
      entity_names: h.entity_names || [],
      entities: h.entities || [],
      line_count: h.line_count,
      description: h.description,
    }));
  } catch (err) {
    log(`[searchCodeStructure] error: ${err.message}`);
    return [];
  }
}

/**
 * Search docs/plans via Meilisearch.
 * Returns normalized results compatible with the rest of the pipeline.
 */
async function searchMeili(query, options = {}) {
  if (!meiliIndex) return [];

  const { source, limit = 10 } = options;
  const filter = source ? `source = '${source}'` : null;

  try {
    const result = await withTimeout(
      meiliIndex.search(query, {
        limit,
        filter,
        attributesToRetrieve: ["title", "content", "filepath", "source", "uid"],
      }),
      MEILI_TIMEOUT_MS,
      "searchMeili"
    );

    return result.hits.map((h) => ({
      score: _meiliScoreToCosine(h._formatted?.score ?? h._scoresDetails),
      payload: {
        source_doc: h.filepath,
        content: `${h.title}\n${h.content}`,
        summary_text: h.title,
        detail: h.content.slice(0, 500),
        related_files: [h.filepath],
        type: "doc",
      },
      _collection: source === "plans" ? "work_memory" : "project_facts",
    }));
  } catch (err) {
    log(`[searchMeili] error: ${err.message}`);
    return [];
  }
}

/** Convert Meilisearch relevance to a cosine-like score [0,1] */
function _meiliScoreToCosine() {
  // Meilisearch doesn't expose raw score easily; use 0.85 as baseline for hits
  return 0.85;
}

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

  // Backend-specific weight coefficients — project_facts prioritized over work_memory
  const backendWeights = {
    project_facts: 1.3,
    decision_chains: 1.1,
    work_memory: 1.0,
    graph: 1.0,
    code_structure: 0.9,
  };

  return allResults
    .map((r) => {
      const collection = r._collection || "work_memory";
      const weight = backendWeights[collection] ?? 1.0;

      let recencyScore = 0.5; // neutral default for project_facts (no timestamp)
      if (r.payload.timestamp) {
        const ageDays = (now - new Date(r.payload.timestamp).getTime()) / DAY_MS;
        // Exponential decay: fresh = 1.0, 30 days old ≈ 0.5, 90 days ≈ 0.25
        recencyScore = Math.exp(-ageDays / 30);
      } else if (r.payload.ingested_at) {
        const ageDays = (now - new Date(r.payload.ingested_at).getTime()) / DAY_MS;
        recencyScore = Math.exp(-ageDays / 60); // slower decay for docs
      }

      // Superseded decisions get a hard penalty — outdated but not deleted
      if (r.payload.status === "superseded") {
        recencyScore *= 0.15;
      }

      // α=0.7: cosine score dominates, recency is a tiebreaker
      const alpha = 0.7;
      const weightedScore = (r.score ?? 0) * weight;
      return { ...r, rerank_score: alpha * weightedScore + (1 - alpha) * recencyScore };
    })
    .sort((a, b) => b.rerank_score - a.rerank_score);
}

/**
 * Format a single result based on its collection type.
 */
function formatResult(r, collection) {
  if (collection === "work_memory") {
    const isMeili = r.payload.type === "doc";
    if (isMeili) {
      return `[${r.payload.source_doc}] ${r.payload.summary_text}\n  content: ${String(r.payload.detail || "").slice(0, 200)}\n  score: ${(r.score ?? 0).toFixed(3)}`;
    }
    return `[${r.payload.type}] ${r.payload.summary_text}\n  detail: ${r.payload.detail}\n  files: ${(r.payload.related_files || []).join(", ")}\n  score: ${r.score.toFixed(3)} (rerank: ${r.rerank_score?.toFixed(3)})`;
  } else if (collection === "graph") {
    if (r.payload.kind === "graph_node") {
      return `\`${r.payload.name}\` defined at ${r.payload.file}:${r.payload.line} (${r.payload.lang})\n  score: ${r.score.toFixed(3)}`;
    } else if (r.payload.kind === "graph_edge") {
      return `${r.payload.source_file}:${r.payload.caller_line} ← \`${r.payload.caller_name}\` calls → \`${r.payload.target_name}\`\n  score: ${r.score.toFixed(3)}`;
    }
    return `graph result (score: ${r.score.toFixed(3)})`;
  } else if (collection === "project_facts") {
    const isMeili = r.payload.type === "doc";
    if (isMeili) {
      return `[${r.payload.source_doc}] ${r.payload.summary_text}\n  content: ${String(r.payload.detail || "").slice(0, 200)}\n  score: ${(r.score ?? 0).toFixed(3)}`;
    }
    return `[${r.payload.source_doc}] ${r.payload.content}\n  score: ${r.score.toFixed(3)} (rerank: ${r.rerank_score?.toFixed(3)})`;
  } else if (collection === "code_structure") {
    const abs = r.payload.absolutePath ? ` → ${r.payload.absolutePath}` : '';
    return `[${r.payload.source_doc}] code file\n  entities: ${String(r.payload.detail || "").slice(0, 200)}\n  score: ${(r.score ?? 0).toFixed(3)}${abs}`;
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

    // Explicit file path detection — skip memory search for direct file I/O queries
    const explicitFile = /\/[A-Za-z0-9_\-\.\/]+\.[a-zA-Z0-9]{2,5}(?:\s|$)/.test(query);
    if (explicitFile) {
      return {
        content: [{
          type: "text",
          text: `Skip memory search: query contains explicit file path. Use search_code / query_graph / grep_search for direct code/file lookup instead of memory search.`
        }]
      };
    }

    // Step 1: extract features and score backends (§1.2)
    const features = extractQueryFeatures(query);
    const route = routeQuery(query, features);

    // Separate targets by search mode
    const vectorTargets = route.targets.filter((t) => t !== "graph" && t !== "decision_chains" && t !== "project_facts");
    const graphTarget = route.targets.includes("graph") ? "graph" : null;
    const chainTarget = route.primary === "decision_chains" || route.targets.includes("decision_chains")
      ? "decision_chains"
      : null;
    const factsTarget = route.targets.includes("project_facts") ? "project_facts" : null;

    let allResults = [];
    let chainOutput = null;

    // Cache embedding — compute once, reuse for all vector operations in this call
    let _cachedVector = null;
    async function getVector() {
      if (!_cachedVector) _cachedVector = await embed(query);
      return _cachedVector;
    }

    // ── P6: Knowledge/architecture queries → docs FIRST, then code fallback ──
    const isKnowledgeQuery = features.is_knowledge || (features.identifier_ratio < 0.1 && !features.is_causal && !features.is_structural);

    // Decision chains: causal query → trace full chain (no SUMMARY_LLM summary)
    if (chainTarget === "decision_chains") {
      const vector = await getVector();
      if (vector) {
        const hits = await qSearch("decision_chains", { vector, limit: 1 });
        if (hits.length > 0 && hits[0]?.payload?.decision_id) {
          chainOutput = await walkChain(hits[0].payload.decision_id, "both");
        }
      }
    }

    // P6: For knowledge queries, search Meilisearch docs first with expanded limit
    let meiliDocsResults = [];
    if (isKnowledgeQuery) {
      meiliDocsResults = await searchMeili(query, { source: "docs", limit: Math.max(limit * 3, 10) }).catch(() => []);
      log(`[MCP search_memory] knowledge query → docs first, hits=${meiliDocsResults.length}`);
    }

    if (vectorTargets.length > 0 || !isKnowledgeQuery) {
      // Fetch more raw results for pruning — the LLM will compress them down
      const perCollectionLimit = Math.max(limit * 2, 10);

      // Reuse cached embedding (already computed above if chainTarget ran)
      const vector = await getVector();

      const searches = vectorTargets.map(async (col) => {
        const results = await qSearch(col, {
          vector,
          limit: perCollectionLimit,
          with_payload: true,
        });
        return results.map((r) => ({ ...r, _collection: col }));
      });

      // project_facts target → Meilisearch search with explicit collection tag
      if (factsTarget) {
        const factsSearch = searchMeili(query, { limit: perCollectionLimit }).then(res => 
          res.map(r => ({ ...r, _collection: "project_facts" }))
        ).catch(() => []);
        searches.push(factsSearch);
      } else if (!isKnowledgeQuery || meiliDocsResults.length === 0) {
        // Fallback generic Meilisearch search for docs/plans
        const meiliSearch = searchMeili(query, { limit: perCollectionLimit }).catch(() => []);
        searches.push(meiliSearch);
      }

      // P1: Cross-reference code_structure index — find relevant code files in one call
      const structSearch = searchCodeStructure(query, { limit: Math.min(perCollectionLimit, 8) })
        .then(results => results.map(r => ({
          score: 0.85,
          payload: {
            source_doc: r.filepath,
            content: `${r.filename}${r.description ? ': ' + r.description.slice(0, 200) : ''}`,
            summary_text: r.filename,
            detail: `entities: ${(r.entity_names || []).slice(0, 8).join(', ')}`,
            related_files: [r.filepath],
            type: "code_structure",
            absolutePath: null, // resolved later by fallback chain
          },
          _collection: "code_structure",
        }))).catch(() => []);
      searches.push(structSearch);

      const batches = await Promise.all(searches);
      allResults.push(...batches.flat());
    }

    // P6: prepend docs results for knowledge queries (they take priority)
    if (isKnowledgeQuery && meiliDocsResults.length > 0) {
      allResults = [...meiliDocsResults, ...allResults];
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

    // ── P3: Fallback chain — if no results, retry backends that weren't targeted ──
    const triedBackends = new Set([
      ...vectorTargets.map(t => t),
      graphTarget || null,
      chainTarget || null,
      factsTarget || null,
      "meili", // meili always runs with vector targets
      "code_structure", // P1 always runs with vector targets
    ].filter(Boolean));

    if (allResults.length === 0 && !chainOutput) {
      const fallbackTargets = ["work_memory", "project_facts", "code_chunks", "graph"].filter(t => !triedBackends.has(t));
      for (const fb of fallbackTargets) {
        if (fb === "graph") {
          const fbGraph = await searchGraph(query, 5);
          allResults.push(...fbGraph);
        } else {
          try {
            const fbVector = await getVector();
            if (fbVector) {
              const fbResults = await qSearch(fb, { vector: fbVector, limit: 5, with_payload: true });
              allResults.push(...fbResults.map(r => ({ ...r, _collection: fb })));
            }
          } catch {}
        }
        if (allResults.length > 0) {
          log(`[MCP search_memory] fallback hit on ${fb}, results=${allResults.length}`);
          break; // stop at first successful fallback
        }
      }
      // Also try code_structure as last resort
      if (allResults.length === 0 && !triedBackends.has("code_structure")) {
        const fbStruct = await searchCodeStructure(query, { limit: 5 });
        allResults.push(...fbStruct.map(r => ({
          score: 0.7,
          payload: {
            source_doc: r.filepath,
            content: `${r.filename}${r.description ? ': ' + r.description.slice(0, 200) : ''}`,
            summary_text: r.filename,
            detail: `entities: ${(r.entity_names || []).slice(0, 8).join(', ')}`,
            related_files: [r.filepath],
            type: "code_structure",
          },
          _collection: "code_structure",
        })));
      }
    }

    // ── P7: Deduplicate results by entity name / source_doc ──
    const beforeDedup = allResults.length;
    allResults = deduplicateResults(allResults);
    if (allResults.length < beforeDedup) {
      log(`[MCP search_memory] P7 dedup: ${beforeDedup} → ${allResults.length}`);
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
 * P7: Deduplicate results by entity name or source_doc.
 * Groups results by a stable key (entity_name, summary_text, source_doc), keeping top-2 per group
 * with file diversity (prefer different files within the same group).
 */
function deduplicateResults(results) {
  if (!results || results.length <= 1) return results;

  const groups = new Map();

  for (const r of results) {
    const p = r.payload || {};
    // Build a dedup key: entity_name > summary_text > source_doc filename
    let key = null;
    if (p.entity_name || p.name) {
      key = `entity:${(p.entity_name || p.name).toLowerCase()}`;
    } else if (p.summary_text && p.summary_text.length > 2) {
      key = `summary:${p.summary_text.toLowerCase().slice(0, 80)}`;
    } else if (p.source_doc) {
      const basename = p.source_doc.split("/").pop();
      key = `doc:${basename?.toLowerCase() || p.source_doc.toLowerCase()}`;
    }

    if (!key) continue;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const deduped = [];
  for (const [key, items] of groups) {
    if (items.length === 1) {
      deduped.push(items[0]);
      continue;
    }

    // Keep top-2 with file diversity
    const seenFiles = new Set();
    for (const item of items) {
      const p = item.payload || {};
      const fileKey = p.source_doc || p.file_path || "";
      if (seenFiles.size < 2 && (!fileKey || !seenFiles.has(fileKey))) {
        deduped.push(item);
        if (fileKey) seenFiles.add(fileKey);
      }
    }
  }

  // Re-sort by score descending to preserve ranking
  deduped.sort((a, b) => (b.score || 0) - (a.score || 0));
  return deduped;
}

/**
 * Search the graph backend using keyword payload filters.
 * Extracts function names and file paths from the query to build targeted queries.
 */
async function searchGraph(query, limit) {
  const results = [];
  const lower = query.toLowerCase();

  // Extract function name with priority: camelCase/PascalCase > snake_case > long lowercase
  // Avoids matching English words like "who", "calls", "function", "file"
  const FILE_STOPWORDS = new Set(["who", "what", "which", "where", "how", "why", "calls", "called", "calling", "callers", "function", "functions", "method", "methods", "file", "files", "define", "defined", "definition", "this", "that", "these", "those", "does", "does", "depend", "depends", "dependency", "using", "use", "uses", "return", "returns", "within", "inside", "between", "across", "from", "into", "over", "under"]);

  function extractFunctionName(q) {
    // 1. camelCase / PascalCase (e.g. callRestAPIAsync, getDatabaseConnection)
    const camel = q.match(/\b([a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/);
    if (camel && !FILE_STOPWORDS.has(camel[1].toLowerCase())) return camel[1];
    // 2. snake_case (e.g. call_rest_api, get_db_connection)
    const snake = q.match(/\b([a-z]+(?:_[a-z0-9]+)+)\b/);
    if (snake && !FILE_STOPWORDS.has(snake[1])) return snake[1];
    // 3. Long lowercase identifier (6+ chars, not a stopword)
    const lower = q.match(/\b([a-z][a-z0-9]{5,})\b/);
    if (lower && !FILE_STOPWORDS.has(lower[1])) return lower[1];
    return null;
  }

  const fnName = extractFunctionName(query);
  const fileMatch = query.match(/[`'"]?([\w/.-]+\.\w{2,4})[`'"]?/);

  if (fnName) {
    // Search graph_nodes by function name
    const nodeRes = await qdrant.scroll("graph_nodes", {
      filter: { must: [{ key: "name", match: { value: fnName } }] },
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
      filter: { must: [{ key: "target_name", match: { value: fnName } }] },
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
 * Shared: trace full causal chain from an anchor decision_id.
 * Returns formatted string with direction control.
 * Used by both search_memory (internal) and trace_decision_chain tool.
 */
async function walkChain(anchorId, direction = "both") {
  const chain = [];
  const visited = new Set();

  async function getById(id) {
    const results = await withTimeout(
      qdrant.scroll("decision_chains", {
        filter: { must: [{ key: "decision_id", match: { value: id } }] },
        limit: 1,
        with_payload: true,
      }),
      QDRANT_TIMEOUT_MS,
      "decision_chains.getById"
    );
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

  if (direction !== "forward") await walkBackward(anchorId);
  if (direction !== "backward") await walkForward(anchorId);

  const topicKey = chain[0]?.payload?.topic_key || "(unknown)";
  let output = `${topicKey} chain (${chain.length} step${chain.length > 1 ? "s" : ""}):\n\n`;

  for (let i = 0; i < chain.length; i++) {
    const n = chain[i].payload;
    const date = new Date(n.created_at).toISOString().split("T")[0];
    const statusTag = n.status === "superseded" ? " (superseded)" : n.status === "active" ? " ← current" : "";
    output += `${i + 1}. [${date}] ${n.content}${statusTag}\n`;
    if (n.reasoning) {
      output += `   → Reason: ${n.reasoning}\n`;
    }
    if (n.file_paths?.length > 0) {
      output += `   → Files: ${n.file_paths.join(", ")}\n`;
    }
    if (n.supersedes) {
      const supersededIdx = chain.findIndex((c) => c.payload.decision_id === n.supersedes);
      if (supersededIdx >= 0) {
        output += `   → Replaces: #${supersededIdx + 1}\n`;
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
      project: z.string().optional().describe("Project name filter (e.g. my-app, backend). Omit to search all projects."),
      status: z.enum(["open", "resolved", "any"]).optional().default("open"),
    },
  },
  async ({ query, project, status }) => {
    // Meilisearch text search on plans (source="plans")
    const meiliResults = await searchMeili(query, { source: "plans", limit: 5 });

    // If Qdrant is available and we need additional filtering by project/status, also search there
    let qdrantResults = [];
    try {
      const vector = await embed(query);
      if (vector) {
        const must = [];
        if (project) must.push({ key: "project", match: { value: project } });
        if (status !== "any") must.push({ key: "status", match: { value: status } });
        qdrantResults = await qSearch("work_memory", {
          vector,
          filter: must.length ? { must } : undefined,
          limit: 5,
          with_payload: true,
        }).then(r => r.map(x => ({ ...x, _collection: "work_memory" }))).catch(() => []);
      }
    } catch {}

    const allResults = [...qdrantResults, ...meiliResults];

    if (allResults.length === 0) {
      return { content: [{ type: "text", text: "No matching records found." }] };
    }

    const formatted = allResults.map((r, i) => `#${i + 1} [${r._collection}] ${formatResult(r, r._collection)}`);
    return { content: [{ type: "text", text: formatted.join("\n\n") }] };
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
    // Meilisearch text search on docs (source="docs")
    const meiliResults = await searchMeili(query, { source: "docs", limit: 5 });

    if (meiliResults.length === 0) {
      return { content: [{ type: "text", text: "No matching documents found." }] };
    }

    const formatted = meiliResults.map((r, i) => `#${i + 1} [${r._collection}] ${formatResult(r, r._collection)}`);
    return { content: [{ type: "text", text: formatted.join("\n\n") }] };
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
      project: z.string().optional().default("").describe("Project name (e.g. my-app, backend). Leave empty if not applicable."),
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

    // Auto-supersede detection: if no explicit supersedes, check for active nodes with same topic_key
    let effectiveSupersedes = supersedes || null;
    if (!supersedes && chainVector) {
      try {
        const activeNodes = await qdrant.scroll("decision_chains", {
          filter: {
            must: [
              { key: "topic_key", match: { value: resolvedTopic } },
              { key: "status", match: { value: "active" } },
            ],
          },
          limit: 10,
          with_payload: ["content", "decision_id"],
        });

        if (activeNodes.points.length === 1) {
          // Single active node — compute similarity to decide auto-supersede
          const existingContent = activeNodes.points[0].payload.content || "";
          const existingVector = await embed(existingContent);
          if (existingVector && cosineSimilarity(chainVector, existingVector) >= 0.8) {
            effectiveSupersedes = activeNodes.points[0].payload.decision_id;
            log(`[auto-supersede] topic=${resolvedTopic}, similarity=${cosineSimilarity(chainVector, existingVector).toFixed(3)}, superseding ${effectiveSupersedes}`);
          }
        } else if (activeNodes.points.length > 1) {
          // Multiple active nodes — find the highest-similarity candidate
          let bestSim = 0;
          let bestId = null;
          for (const pt of activeNodes.points) {
            const ec = pt.payload.content || "";
            const ev = await embed(ec);
            if (ev) {
              const sim = cosineSimilarity(chainVector, ev);
              if (sim > bestSim) { bestSim = sim; bestId = pt.payload.decision_id; }
            }
          }
          // Require higher threshold when multiple candidates exist
          if (bestSim >= 0.85) {
            effectiveSupersedes = bestId;
            log(`[auto-supersede] topic=${resolvedTopic}, similarity=${bestSim.toFixed(3)}, superseding ${bestId} among ${activeNodes.points.length} active`);
          }
        }
      } catch (err) {
        log(`[auto-supersede] scroll failed: ${err.message}`);
      }
    }

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
              supersedes: effectiveSupersedes,
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
      if (effectiveSupersedes) {
        await qdrant.setPayload("decision_chains", {
          points: [effectiveSupersedes],
          payload: { superseded_by: decision_id, status: "superseded" },
        });
      }
    }

    const autoNote = effectiveSupersedes && !supersedes ? ` (auto-superseded ${effectiveSupersedes.slice(0, 8)})` : "";
    return { content: [{ type: "text", text: `Saved successfully. decision_id: ${decision_id}, topic_key: ${resolvedTopic}${autoNote}` }] };
  }
);

// --- Tool 3b: trace causal decision chain ---
server.registerTool(
  "trace_decision_chain",
  {
    title: "Trace Decision Chain",
    description:
      "Reconstruct the full causal chain of decisions for a given topic or decision ID. Returns the timeline of how and why decisions evolved (no SUMMARY_LLM summarization — structure preserved as-is).",
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
        const hits = await qSearch("decision_chains", { vector, limit: 1 });
        anchor = hits[0]?.payload?.decision_id || null;
      }
    }

    if (!anchor) {
      return { content: [{ type: "text", text: "No related decisions found." }] };
    }

    const output = await walkChain(anchor, direction);
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
      query: z.string().describe("Query about code structure, e.g. 'who calls callRestAPIAsync' or 'functions defined in blogService.js'"),
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

    // Extract function name: look for patterns like "X caller", "X function definition"
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
      output += `- "X function definition" → find function X\n`;
      output += `- "who calls X" → reverse dependency of X\n`;
      output += `- "what X calls" → forward calls from X\n`;
      output += `- "functions in file.js" → functions defined in file.js\n\n`;

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
    const searxngUrl = process.env.SEARXNG_URL || "http://localhost:18080";
    const url = new URL(`${searxngUrl}/search`);
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
      "Search the codebase semantically using natural language. Use for questions like 'API key generation logic', 'DB connection pooling'. For exact symbol lookups, prefer query_graph instead.",
    inputSchema: {
      query: z.string().describe("Natural language code search query (e.g. 'API auth token generation')"),
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
      const results = await qSearch("code_chunks", {
        vector,
        filter: must.length > 0 ? { must } : undefined,
        score_threshold: min_score,
        limit: Math.min(limit, 50),
        with_payload: true,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No matching results for "${query}" in codebase.` }] };
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
        return { content: [{ type: "text", text: "code_chunks collection does not exist. Run 'npm run create-collections' and 'npm run index-chunks' first." }] };
      }
      throw err;
    }
  }
);

// --- Tool 7: file structure search (Meilisearch code_structure index) ---
server.registerTool(
  "search_file_structure",
  {
    title: "Search File Structure",
    description:
      "Search code files by name, function names, imports, or keywords. Use when you need to find where a specific file lives, what functions a file contains, or which files reference a given module. Returns exact filepaths — use with read_file for content.",
    inputSchema: {
      query: z.string().describe("Search query: filename, function name, import keyword (e.g. 'redis', 'cache', 'connectRedis')"),
      language: z.string().optional().describe("Language filter: javascript, typescript, php (optional)"),
      limit: z.number().optional().default(10).describe("Max results (default 10, max 50)"),
    },
  },
  async ({ query, language, limit }) => {
    log(`[MCP search_file_structure] source=mcp, query="${query.slice(0, 80)}", lang=${language || "any"}, limit=${limit}`);

    const results = await searchCodeStructure(query, { language, limit: Math.min(limit, 50) });

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No matching code files for "${query}". Run 'npm run index-structure' first to build the structure index.` }] };
    }

    // Verify file paths exist and resolve to absolute paths
    const verified = await Promise.all(results.map(async (r) => ({
      ...r,
      absolutePath: await resolveFilePath(r.filepath),
    })));

    const formatted = verified.map((r, i) => {
      let line = `#${i + 1} ${r.filepath}`;
      if (r.absolutePath) {
        line += `\n  abs: ${r.absolutePath}`;
      } else {
        line += " ⚠️ file not found";
      }
      line += `\n  filename: ${r.filename} | language: ${r.language} | lines: ${r.line_count}\n`;
      if (r.entity_names && r.entity_names.length > 0) {
        line += `  entities: ${r.entity_names.slice(0, 12).join(", ")}${r.entity_names.length > 12 ? " ..." : ""}`;
      }
      if (r.description) {
        line += `\n  desc: ${r.description.slice(0, 150)}`;
      }
      return line;
    });

    const text = `File structure search results for "${query}" (${results.length} matches):\n\n${formatted.join("\n\n")}`;
    log(`[MCP search_file_structure] done, results=${results.length}`);
    return { content: [{ type: "text", text }] };
  }
);

// --- Tool 8: get_context_bundle — file + related chunks + caller/callee in one call (P2) ---
server.registerTool(
  "get_context_bundle",
  {
    title: "Get Context Bundle",
    description:
      "Returns a complete context bundle for a file: full content, relevant code chunks from semantic search, caller/callee graph edges, and related decisions. Use this INSTEAD of separate read_file + search_code calls to save round trips.",
    inputSchema: {
      filepath: z.string().describe("Relative or absolute file path (e.g. 'verbally_server/redis.js')"),
      include_chunks: z.boolean().optional().default(true).describe("Include semantically related code chunks from Qdrant"),
      include_graph: z.boolean().optional().default(true).describe("Include caller/callee edges from graph backend"),
      chunk_limit: z.number().optional().default(5).describe("Max chunks to include (default 5)"),
    },
  },
  async ({ filepath, include_chunks = true, include_graph = true, chunk_limit = 5 }) => {
    log(`[MCP get_context_bundle] source=mcp, filepath="${filepath}", chunks=${include_chunks}, graph=${include_graph}`);

    // Resolve path
    const absPath = await resolveFilePath(filepath);
    if (!absPath) {
      return { content: [{ type: "text", text: `⚠️ File not found: ${filepath}\n\nUse search_file_structure to find the correct path.` }] };
    }

    let output = `## File: ${filepath}\n`;
    output += `Path: ${absPath}\n\n`;

    // Read file content (with line limit to avoid token explosion)
    try {
      const content = await fs.readFile(absPath, "utf-8");
      const lines = content.split("\n");
      const lineCount = lines.length;
      output += `Lines: ${lineCount}\n\n`;

      // Show first 100 lines as preview, summarize rest
      if (lineCount <= 200) {
        output += `\`\`\`${path.extname(absPath).slice(1)}\n${content}\n\`\`\`\n`;
      } else {
        output += `*(Large file — showing first 100 lines)*\n\n\`\`\`${path.extname(absPath).slice(1)}\n${lines.slice(0, 100).join("\n")}\n... (${lineCount - 100} more lines)\n\`\`\`\n`;
      }
    } catch (err) {
      output += `⚠️ Failed to read file: ${err.message}\n\n`;
    }

    // Include related code chunks from Qdrant (P2: semantic match on filename + entities)
    if (include_chunks) {
      try {
        const vector = await embed(filepath);
        if (vector) {
          const chunkResults = await qSearch("code_chunks", {
            vector,
            filter: { must: [{ key: "file_path", match: { value: filepath } }] },
            limit: chunk_limit,
            with_payload: true,
          }).catch(() => []);

          if (chunkResults.length > 0) {
            output += `\n## Related Chunks in this file (${chunkResults.length})\n`;
            for (const [i, r] of chunkResults.entries()) {
              const p = r.payload;
              output += `#${i + 1} \`${p.entity_name}\` (${p.entity_type}) at line ${p.start_line}-${p.end_line} (score: ${r.score.toFixed(3)})\n`;
            }
          }
        }
      } catch {}
    }

    // Include caller/callee graph edges (P2: dependency context)
    if (include_graph) {
      try {
        const fnMatch = filepath.match(/[^/]+\.(\w+)$/);
        const baseName = fnMatch ? path.basename(filepath, '.' + fnMatch[1]) : null;

        if (baseName) {
          // Find graph nodes for this file
          const nodeRes = await qdrant.scroll("graph_nodes", {
            filter: { must: [{ key: "file", match: { value: filepath } }] },
            limit: 10,
            with_payload: true,
          }).catch(() => ({ points: [] }));

          if (nodeRes.points.length > 0) {
            output += `\n## Graph Nodes in this file (${nodeRes.points.length})\n`;
            for (const p of nodeRes.points) {
              output += `- \`${p.payload.name}\` at line ${p.payload.line} (${p.payload.lang})\n`;

              // Find callers for each function
              const edgeRes = await qdrant.scroll("graph_edges", {
                filter: { must: [{ key: "target_name", match: { value: p.payload.name } }] },
                limit: 5,
                with_payload: true,
              }).catch(() => ({ points: [] }));

              if (edgeRes.points.length > 0) {
                output += `  ← called by:\n`;
                for (const e of edgeRes.points.slice(0, 3)) {
                  output += `    - \`${e.payload.caller_name}\` at ${e.payload.source_file}:${e.payload.caller_line}\n`;
                }
              }
            }
          }
        }
      } catch {}
    }

    log(`[MCP get_context_bundle] done for ${filepath}`);
    return { content: [{ type: "text", text: output }] };
  }
);

// --- Tool 9: trace_references — multi-hop caller/callee tracing (P4) ---
server.registerTool(
  "trace_references",
  {
    title: "Trace References",
    description:
      "Traces multi-hop caller/callee references for a function or file. Follows the call chain up to N hops, showing who calls whom and where. Use this instead of repeated search_code calls to build dependency chains.",
    inputSchema: {
      target: z.string().describe("Function name or file path to trace (e.g. 'callRestAPIAsync' or 'redis.js')"),
      direction: z.enum(["callers", "callees", "both"]).optional().default("both").describe("Trace direction: callers (who calls it), callees (what it calls), or both"),
      max_hops: z.number().optional().default(2).describe("Max hops to follow (default 2, max 4)"),
    },
  },
  async ({ target, direction = "both", max_hops = 2 }) => {
    log(`[MCP trace_references] source=mcp, target="${target}", direction=${direction}, max_hops=${max_hops}`);

    const hops = Math.min(max_hops, 4);
    const visited = new Set();
    const chain = [];

    // Step 1: Find anchor nodes (functions matching the target)
    let anchors = [];

    // Try as function name first
    const fnRes = await qdrant.scroll("graph_nodes", {
      filter: { must: [{ key: "name", match: { value: target } }] },
      limit: 5,
      with_payload: true,
    }).catch(() => ({ points: [] }));

    if (fnRes.points.length > 0) {
      anchors = fnRes.points.map(p => p.payload);
    } else {
      // Try as file path
      const fileRes = await qdrant.scroll("graph_nodes", {
        filter: { must: [{ key: "file", match: { value: target } }] },
        limit: 10,
        with_payload: true,
      }).catch(() => ({ points: [] }));

      anchors = fileRes.points.map(p => p.payload);
    }

    if (anchors.length === 0) {
      // Fallback: search code_structure for the target
      const structResults = await searchCodeStructure(target, { limit: 3 });
      if (structResults.length > 0) {
        return { content: [{ type: "text", text: `No graph nodes found, but found ${structResults.length} files in code structure:\n\n${structResults.map(r => `- \`${r.filepath}\` → entities: ${(r.entity_names || []).join(', ')}`).join("\n")}\n\n→ Run index-structure to build the latest graph.` }] };
      }
      return { content: [{ type: "text", text: `⚠️ No node found for '${target}'.\n\nUse search_file_structure to find the correct function or file name.` }] };
    }

    let output = `## Trace: ${target}\n`;
    output += `Anchors found: ${anchors.length} | Direction: ${direction} | Max hops: ${hops}\n\n`;

    // Step 2: Walk the graph for each hop
    async function getCallers(funcName) {
      const res = await qdrant.scroll("graph_edges", {
        filter: { must: [{ key: "target_name", match: { value: funcName } }] },
        limit: 10,
        with_payload: true,
      }).catch(() => ({ points: [] }));
      return res.points.map(p => p.payload);
    }

    async function getCallees(funcName) {
      const res = await qdrant.scroll("graph_edges", {
        filter: { must: [{ key: "caller_name", match: { value: funcName } }] },
        limit: 10,
        with_payload: true,
      }).catch(() => ({ points: [] }));
      return res.points.map(p => p.payload);
    }

    let currentNodes = anchors;

    for (let hop = 0; hop < hops; hop++) {
      const hopLabel = hop === 0 ? "Anchor" : `Hop ${hop}`;
      output += `--- ${hopLabel} (${currentNodes.length} node${currentNodes.length > 1 ? "s" : ""}) ---\n`;

      for (const node of currentNodes) {
        const nodeId = `${node.name}@${node.file || "?"}`;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        output += `\n### \`${node.name}\` (${node.file}:${node.line})\n`;

        // Show callers
        if (direction === "callers" || direction === "both") {
          const callers = await getCallers(node.name);
          if (callers.length > 0) {
            output += `  ← called by:\n`;
            for (const c of callers.slice(0, 5)) {
              output += `    - \`${c.caller_name}\` at ${c.source_file || "?"}:${c.caller_line || "?"}\n`;
            }
          }
        }

        // Show callees
        if (direction === "callees" || direction === "both") {
          const callees = await getCallees(node.name);
          if (callees.length > 0) {
            output += `  → calls:\n`;
            for (const c of callees.slice(0, 5)) {
              output += `    - \`${c.target_name}\` at ${c.target_file || "?"}:${c.target_line || "?"}\n`;
            }
          }
        }

        if (!callers.length && !callees.length) {
          output += `  (leaf node — no edges)\n`;
        }
      }

      // Collect next-hop nodes (unique, unvisited)
      const nextNodes = [];
      for (const node of currentNodes) {
        if (direction === "callers" || direction === "both") {
          const callers = await getCallers(node.name);
          for (const c of callers) {
            const cid = `${c.caller_name}@${c.source_file || "?"}`;
            if (!visited.has(cid)) {
              visited.add(cid);
              nextNodes.push({ name: c.caller_name, file: c.source_file, line: c.caller_line });
            }
          }
        }
        if (direction === "callees" || direction === "both") {
          const callees = await getCallees(node.name);
          for (const c of callees) {
            const cid = `${c.target_name}@${c.target_file || "?"}`;
            if (!visited.has(cid)) {
              visited.add(cid);
              nextNodes.push({ name: c.target_name, file: c.target_file, line: c.target_line });
            }
          }
        }
      }

      currentNodes = nextNodes.slice(0, 15); // cap to avoid explosion
      if (currentNodes.length === 0) break;
    }

    output += `\n## Summary\nTotal unique nodes visited: ${visited.size}\n`;

    log(`[MCP trace_references] done, visited=${visited.size}`);
    return { content: [{ type: "text", text: output }] };
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

  // Only real Qdrant vector collections — project_facts lives in Meilisearch, not Qdrant.
  // Routing a query to project_facts must not trigger qSearch("project_facts") (collection absent → throw).
  const QDRANT_VECTOR_BACKENDS = ["work_memory", "decision_chains"];
  const vectorTargets = route.targets.filter((t) => QDRANT_VECTOR_BACKENDS.includes(t));
  const graphTarget = route.targets.includes("graph") ? "graph" : null;
  const meiliTarget = route.targets.includes("project_facts");

  let allResults = [];

  // Embed once if any vector backend is targeted (needed for both routeQuery targets and code_chunks)
  const shouldEmbed = vectorTargets.length > 0 || graphTarget;
  let vector = null;
  if (shouldEmbed) {
    vector = await embed(query);
  }

  if (vectorTargets.length > 0 || meiliTarget) {
    const perCollectionLimit = 10;

    const searches = vectorTargets.map(async (col) => {
      const results = await qSearch(col, {
        vector,
        limit: perCollectionLimit,
        with_payload: true,
      });
      return results.map((r) => ({ ...r, _collection: col }));
    });

    // Also search Meilisearch for docs/plans text matches
    const meiliSearch = searchMeili(query, { limit: perCollectionLimit }).catch(() => []);
    searches.push(meiliSearch);

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
      const codeChunksResults = await qSearch("code_chunks", {
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

  // Skip trivial queries — no point running full search + LLM summary for "hi" or "2+2"
  if (query.length < 10 || /^[\d+\-*/().\s=]+$/.test(query) || /^(hi|hello|hey|yo|ok|thanks|done|yes|no)\s*[!.]?\s*$/i.test(query)) {
    log(`[Hook /v1/context/search] skip trivial query: "${query}"`);
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

  // SUMMARY_LLM prune & summarize (graceful fallback)
  let prunedSummary = null;
  try {
    prunedSummary = await pruneAndSummarize(query, allResults);
  } catch (err) {
    log(`[Hook /v1/context/search] prune failed: ${err.message}`);
  }

  log(`[Hook /v1/context/search] done, results=${allResults.length}, summary=${prunedSummary ? 'yes' : 'no'}`);

  // Build UserPromptSubmitOutput.additionalContext
  const sliced = allResults.slice(0, prunedSummary ? 3 : 5);
  let additionalContext = "## Search Results (Auto-injected)\n\n";

  if (prunedSummary) {
    additionalContext += `### Summary\n${prunedSummary}\n\n`;
    additionalContext += `### Sources (top ${Math.min(sliced.length, allResults.length)} of ${allResults.length})\n`;
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

// ─── Dashboard: shared stats collector (used by both HTTP port and dashboard) ───

async function collectDashboardStats() {
  const stats = { qdrant: {}, meilisearch: {}, system: {} };

  // Qdrant collections — use getCollection for accurate counts (SDK v1.x auto-unwraps result)
  try {
    const colls = await qdrant.getCollections();
    const collectionList = colls.collections || [];
    stats.qdrant.collections = {};
    for (const col of collectionList) {
      const name = col.name;
      let info = {};
      try {
        info = await qdrant.getCollection(name);
      } catch {}
      // SDK v1.x already unwraps result, so info has points_count directly
      const count = info.points_count || 0;
      const indexedVectors = info.indexed_vectors_count || count;
      stats.qdrant.collections[name] = {
        count,
        vectors: indexedVectors,
        vectorSize: (info.config?.params?.vectors?.size) || "-",
        indexedOrStatus: info.status || "green",
      };
    }
  } catch (err) {
    stats.qdrant.error = err.message;
  }

  // Meilisearch indexes — getIndexes() in v1.x returns minimal info; use stats endpoint per index for counts
  try {
    if (MEILI_MASTER_KEY) {
      const meiliClientForDash = new Meilisearch({ host: MEILI_HOST, apiKey: MEILI_MASTER_KEY });
      const indexList = await meiliClientForDash.getIndexes().catch(() => ({ results: [] }));
      stats.meilisearch.indexes = {};
      for (const idx of (indexList.results || [])) {
        let docCount = 0;
        let fieldDist = {};
        try {
          const indexObj = await meiliClientForDash.getIndex(idx.uid);
          const s = await indexObj.getStats();
          docCount = s.numberOfDocuments || 0;
          fieldDist = s.fieldDistribution || {};
        } catch {}
        stats.meilisearch.indexes[idx.uid] = {
          documentCount: docCount,
          fieldCount: Object.keys(fieldDist).length,
          indexedDocumentCount: docCount,
          isIndexing: false,
        };
      }
    } else {
      stats.meilisearch.error = "MEILI_MASTER_KEY not set";
    }
  } catch (err) {
    stats.meilisearch.error = err.message;
  }

  // System info — Qdrant version
  try {
    const qdInfo = await fetch(QDRANT_URL + "/").catch(() => null);
    const qdJson = qdInfo ? await qdInfo.json().catch(() => ({})) : {};
    stats.system.qdrant_version = qdJson.version || "unknown";
  } catch {
    stats.system.qdrant_status = "unreachable";
  }

  // System info — Meilisearch version
  try {
    const msInfo = await fetch(MEILI_HOST + "/").catch(() => null);
    const msJson = msInfo ? await msInfo.json().catch(() => ({})) : {};
    stats.system.meilisearch_version = msJson.version || "unknown";
  } catch {
    stats.system.meilisearch_status = "unreachable";
  }

  stats.system.node_version = process.version;
  stats.system.uptime = `${Math.floor(process.uptime() / 60)}m`;

  return stats;
}

// ─── Dashboard API: /api/stats (on main HTTP port) ───

httpApp.get("/api/stats", async (c) => {
  const stats = await collectDashboardStats();
  return c.json(stats);
});

/** Shared: read and aggregate gate telemetry JSONL */
async function readGateStats() {
  const fsSync = await import("fs");
  const pathMod = await import("path");
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const telemetryPath = pathMod.default.join(home, ".qwen", "tmp", "focus-memory", "gate-telemetry.jsonl");
  if (!fsSync.default.existsSync(telemetryPath)) {
    return { total: 0, memoryGate: { allow: 0, deny: 0 }, writeBackGate: { ask: 0, allow: 0, skip: 0 }, userResponses: { yes: 0, no: 0 } };
  }
  const lines = fsSync.default.readFileSync(telemetryPath, "utf-8").trim().split("\n").filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const memoryGate = { allow: 0, deny: 0 };
  const writeBackGate = { ask: 0, allow: 0, skip: 0 };
  let yes = 0, no = 0;
  for (const e of entries) {
    if (e.hook === "check-memory-first") {
      if (e.decision === "allow") memoryGate.allow++;
      else if (e.decision === "deny") memoryGate.deny++;
    } else if (e.hook === "check-writeback") {
      if (e.decision === "ask") writeBackGate.ask++;
      else if (e.decision === "allow") writeBackGate.allow++;
      else if (e.decision === "skip") writeBackGate.skip++;
    }
    if (e.event === "user_response") {
      if (e.decision === "yes") yes++;
      else if (e.decision === "no") no++;
    }
  }
  return { total: entries.length, memoryGate, writeBackGate, userResponses: { yes, no } };
}

httpApp.get("/api/gate-stats", async (c) => {
  try {
    return c.json(await readGateStats());
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── Dashboard UI: serve on port 8891 ───

const dashboardPort = parseInt(process.env.DASHBOARD_PORT || "8891", 10);
try {
  const fsSync = await import("fs");
  const dashboardHtml = fsSync.default.readFileSync(__dirname + "/web/dashboard.html", "utf-8");

  const dashApp = new Hono();
  dashApp.get("/", (c) => c.html(dashboardHtml));
  dashApp.get("/api/stats", async (cD) => {
    const stats = await collectDashboardStats();
    return cD.json(stats);
  });
  dashApp.get("/api/gate-stats", async (cD) => {
    try {
      return cD.json(await readGateStats());
    } catch (err) {
      return cD.json({ error: err.message }, 500);
    }
  });

  const dashServer = await serve({ fetch: dashApp.fetch, port: dashboardPort });
  console.error(`[FocusMemory] Dashboard UI listening on :${dashboardPort}`);

  if (dashServer && typeof dashServer.on === "function") {
    dashServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[FocusMemory] Dashboard port ${dashboardPort} already in use`);
      } else {
        console.error("[FocusMemory] Dashboard server error:", err.message);
      }
    });
  }
} catch (err) {
  if (err.code === "EADDRINUSE") {
    console.error(`[FocusMemory] Dashboard port ${dashboardPort} already in use`);
  } else {
    console.error("[FocusMemory] Dashboard server failed:", err.message);
  }
}

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
