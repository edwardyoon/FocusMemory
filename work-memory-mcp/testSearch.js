import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";
import { extractQueryFeatures, routeQuery } from "./utils.js";

const BGE_URL = process.env.BGE_URL || "http://127.0.0.1:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";

const qdrant = new QdrantClient({ url: QDRANT_URL });

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

async function search(collection, query, limit = 5) {
  const vector = await embed(query);
  const results = await qdrant.search(collection, {
    vector,
    limit,
    with_payload: true,
  });
  return results.map((r) => ({ ...r, _collection: collection }));
}

/**
 * Search graph backend using keyword filters (no embedding).
 */
async function searchGraph(query, limit = 5) {
  const results = [];
  // Extract English identifier (camelCase/PascalCase/snake_case, 4+ chars)
  const fnMatch = query.match(/([a-zA-Z_]\w{3,})/);
  const fileMatch = query.match(/[`'"]?([\w/.-]+\.\w{2,4})[`'"]?/);

  if (fnMatch) {
    const nodeRes = await qdrant.scroll("graph_nodes", {
      filter: { must: [{ key: "name", match: { value: fnMatch[1] } }] },
      limit, with_payload: true,
    });
    for (const p of nodeRes.points) {
      results.push({ score: 0.95, payload: { ...p.payload, kind: "graph_node" }, _collection: "graph" });
    }
    const edgeRes = await qdrant.scroll("graph_edges", {
      filter: { must: [{ key: "target_name", match: { value: fnMatch[1] } }] },
      limit, with_payload: true,
    });
    for (const p of edgeRes.points) {
      results.push({ score: 0.85, payload: { ...p.payload, kind: "graph_edge" }, _collection: "graph" });
    }
  } else if (fileMatch) {
    const nodeRes = await qdrant.scroll("graph_nodes", {
      filter: { must: [{ key: "file", match: { value: fileMatch[1] } }] },
      limit, with_payload: true,
    });
    for (const p of nodeRes.points) {
      results.push({ score: 0.9, payload: { ...p.payload, kind: "graph_node" }, _collection: "graph" });
    }
  }
  return results.slice(0, limit);
}

/**
 * Rerank merged results from multiple collections (same logic as index.js).
 */
function rerankMerged(allResults) {
  const now = Date.now();
  const DAY_MS = 86400000;

  return allResults
    .map((r) => {
      let recencyScore = 0.5;
      if (r.payload.timestamp) {
        const ageDays = (now - new Date(r.payload.timestamp).getTime()) / DAY_MS;
        recencyScore = Math.exp(-ageDays / 30);
      } else if (r.payload.ingested_at) {
        const ageDays = (now - new Date(r.payload.ingested_at).getTime()) / DAY_MS;
        recencyScore = Math.exp(-ageDays / 60);
      }
      return { ...r, rerank_score: 0.7 * r.score + 0.3 * recencyScore };
    })
    .sort((a, b) => b.rerank_score - a.rerank_score);
}

function printResult(r, i) {
  console.log(`--- #${i + 1} [${r._collection}] (score: ${r.score.toFixed(4)}, rerank: ${r.rerank_score?.toFixed(4)}) ---`);
  if (r.payload.kind === "graph_node") {
    console.log(`function: \`${r.payload.name}\` → ${r.payload.file}:${r.payload.line} (${r.payload.lang})`);
  } else if (r.payload.kind === "graph_edge") {
    console.log(`${r.payload.source_file}:${r.payload.caller_line}: \`${r.payload.caller_name}\` → \`${r.payload.target_name}\``);
  } else {
    if (r.payload.section_title) console.log(`section: ${r.payload.section_title}`);
    if (r.payload.summary_text) console.log(`summary: ${r.payload.summary_text}`);
    if (r.payload.content) console.log(`content: ${r.payload.content.substring(0, 300)}`);
    if (r.payload.detail) console.log(`detail: ${r.payload.detail.substring(0, 200)}`);
    if (r.payload.tags?.length) console.log(`tags: ${(r.payload.tags || []).join(", ")}`);
    if (r.payload.source_doc) console.log(`source: ${r.payload.source_doc}`);
  }
  console.log();
}

async function main() {
  const query = process.argv[2];
  const explicitCollection = process.argv[3]; // optional: force a specific collection

  if (!query) {
    console.log('Usage: node testSearch.js "query" [collection]');
    console.log('  - Omit [collection] to use the query router (auto-detect)');
    console.log('  - Specify a collection name to bypass routing and search directly');
    process.exit(1);
  }

  if (explicitCollection) {
    // Direct mode: skip routing, search specified collection
    console.log(`[direct] Searching "${query}" in "${explicitCollection}"\n`);
    const results = await search(explicitCollection, query);
    results.forEach((r, i) => printResult(r, i));
  } else {
    // Routed mode: scoring-based auto-routing (§1.2)
    console.log(`[router] Query: "${query}"\n`);

    const features = extractQueryFeatures(query);
    const route = routeQuery(query, features);

    console.log("Features:");
    console.log(`  identifier_ratio: ${features.identifier_ratio.toFixed(3)}`);
    console.log(`  is_causal: ${features.is_causal}`);
    console.log(`  is_structural: ${features.is_structural}`);
    console.log(`  is_temporal: ${features.is_temporal}`);

    const scoreStr = Object.entries(route.scores).map(([k,v]) => `${k}=${v.toFixed(3)}`).join(", ");
    console.log(`Scores: ${scoreStr}`);
    console.log(`Route: mode=${route.mode} primary=${route.primary} targets=[${route.targets.join(", ")}]\n`);

    // Separate vector and graph backends
    const vectorTargets = route.targets.filter((t) => t !== "graph");
    const hasGraph = route.targets.includes("graph");

    let allResults = [];

    if (vectorTargets.length > 0) {
      const perLimit = Math.max(5, 3);
      const batches = await Promise.all(
        vectorTargets.map(async (col) => search(col, query, perLimit))
      );
      allResults.push(...batches.flat());
    }

    if (hasGraph) {
      const graphResults = await searchGraph(query, 5);
      allResults.push(...graphResults);
    }

    // Rerank if multiple backends contributed
    if (allResults.length > 0 && route.mode === "parallel") {
      allResults = rerankMerged(allResults).slice(0, 5);
    } else if (allResults.length > 0) {
      allResults = allResults.slice(0, 5);
    }

    if (allResults.length === 0) {
      console.log("No matching records found.");
    } else {
      allResults.forEach((r, i) => printResult(r, i));
    }
  }
}

main().catch(console.error);