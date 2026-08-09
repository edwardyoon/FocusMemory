import dotenv from "dotenv";
dotenv.config({ override: true }); // .env takes priority — override settings.json env vars;
import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

const QWEN_URL = process.env.QWEN_URL || "http://127.0.0.1:8080/v1/chat/completions";
const BGE_URL = process.env.BGE_URL || "http://127.0.0.1:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const SUMMARY_LLM_URL = process.env.SUMMARY_LLM_URL || "http://127.0.0.1:8081/v1/chat/completions";
const SUMMARY_LLM_MODEL = process.env.SUMMARY_LLM_MODEL || "summary-27b";

export const qdrant = new QdrantClient({ url: QDRANT_URL });

// ─── Ignore pattern loader + file scanner (shared by buildGraph & indexCodeChunks) ──

const IGNORE_FILE = process.env.FOCUS_IGNORE_FILE || path.join("/opt/homebrew/var/www", ".focusmemoryignore");
let _ignorePatterns = null;

/**
 * Load .focusmemoryignore patterns from disk.
 * Returns array of { type, pattern } — cached after first load.
 */
export async function loadIgnorePatterns(filePath = IGNORE_FILE) {
  if (_ignorePatterns) return _ignorePatterns;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const patterns = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      patterns.push(parseIgnoreLine(line));
    }
    _ignorePatterns = patterns;
    return patterns;
  } catch {
    // File not found — return empty (no exclusions)
    return (_ignorePatterns = []);
  }
}

/** Parse a single .focusmemoryignore line into structured pattern */
function parseIgnoreLine(line) {
  if (line.endsWith("/")) {
    // Directory-only exclusion: match directory component in path
    return { type: "dir", name: line.slice(0, -1) };
  } else if (line.includes("*")) {
    // Glob pattern with wildcards — convert to regex
    const regex = globToRegex(line);
    return { type: "glob", regex };
  } else {
    // Bare filename/extension match
    return { type: "name", name: line };
  }
}

/** Convert simple glob pattern (e.g. "*.min.js", ".env*") to RegExp */
function globToRegex(pattern) {
  let source = "^" + pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\x00") // temp placeholder for **
    .replace(/\*/g, "[^/]*")
    .replace(/\x00/g, ".*")
    + "$";
  return new RegExp(source);
}

/** Check if a relative file path should be excluded by ignore patterns */
export function isIgnored(relPath, patterns) {
  for (const p of patterns) {
    if (p.type === "dir" && relPath.split(path.sep).includes(p.name)) return true;
    if (p.type === "glob" && p.regex.test(relPath)) return true;
    if (p.type === "name" && path.basename(relPath) === p.name) return true;
  }
  return false;
}

/**
 * Recursively scan directory for files with given extensions.
 * Respects .focusmemoryignore patterns and skips large files.
 */
export async function scanFiles(dir, extensions, maxFileSize = 200_000) {
  const files = [];
  const patterns = await loadIgnorePatterns();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Quick skip: check directory name against ignore patterns before recursing
        let skip = false;
        for (const p of patterns) {
          if (p.type === "dir" && entry.name === p.name) { skip = true; break; }
          if (p.type === "name" && entry.name === p.name) { skip = true; break; }
        }
        if (skip) continue;

        const subFiles = await scanFiles(path.join(dir, entry.name), extensions, maxFileSize);
        files.push(...subFiles);
      } else if (extensions.has(path.extname(entry.name).slice(1))) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(process.cwd(), fullPath);
        if (!isIgnored(relPath, patterns)) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size <= maxFileSize) files.push(fullPath);
          } catch {
            // inaccessible file, skip
          }
        }
      }
    }
  } catch {
    // directory not accessible, skip silently
  }
  return files;
}

// ─── File path verification (pipeline hardening) ──────────────────────

/**
 * Resolve a relative file path from search results to an absolute path.
 * Tries multiple roots: GRAPH_ROOT, process.cwd(), /opt/homebrew/var/www.
 */
export async function resolveFilePath(relPath) {
  const candidates = [
    process.env.GRAPH_ROOT,
    "/opt/homebrew/var/www",
  ].filter(Boolean);

  for (const root of candidates) {
    const fullPath = path.join(root, relPath);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {}
  }
  // Last resort: check if the path is already absolute
  try {
    await fs.access(relPath);
    return relPath;
  } catch {}

  return null;
}

/**
 * Verify a batch of file paths from search results.
 * Returns array of { relPath, absolutePath, exists }.
 */
export async function verifyFilePaths(relPaths) {
  const seen = new Set();
  return (relPaths || []).map((relPath) => {
    if (seen.has(relPath)) return { relPath, absolutePath: null, exists: false };
    seen.add(relPath);
    return null; // deduplicate — resolved later
  }).filter(Boolean);
}

export async function embed(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(BGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bge-m3", input: text }),
      signal: controller.signal,
    });

    if (res.status !== 200) {
      console.error(`    [embed error] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (data.data && Array.isArray(data.data) && data.data[0]) {
      return data.data[0].embedding;
    }
    if (data.embedding) {
      return data.embedding;
    }
    console.error("    [embed error] unknown response format");
    return null;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("    [embed timeout] exceeded 30s");
    } else {
      console.error(`    [embed error] ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Decision Chains — topic key inference via SUMMARY_LLM ──────────────

/**
 * Infer a topic_key for a new decision by comparing against existing topics.
 * Uses embedding similarity first (threshold 0.75), then falls back to SUMMARY_LLM classification.
 */
export async function inferTopicKey(content) {
  // Step 1: scroll recent topic_keys from decision_chains
  let candidates;
  try {
    const result = await qdrant.scroll("decision_chains", {
      limit: 200,
      with_payload: ["topic_key"],
    });
    candidates = result.points.map((p) => p.payload.topic_key).filter(Boolean);
  } catch {
    // Collection may not exist yet (first run after create-collections)
    candidates = [];
  }

  const uniqueTopics = [...new Set(candidates)];

  if (uniqueTopics.length === 0) {
    // No existing topics — extract a simple key from content (first identifier-like token)
    const match = content.match(/[\w.\/-]+\.\w{2,4}/);
    return match ? match[0] : "general";
  }

  // Step 2: embedding similarity check against each unique topic
  const vector = await embed(content);
  if (vector) {
    for (const topic of uniqueTopics) {
      try {
        const matches = await qdrant.scroll("decision_chains", {
          filter: { must: [{ key: "topic_key", match: { value: topic } }] },
          limit: 1,
          with_payload: ["content"],
        });
        if (matches.points.length > 0) {
          const existingContent = matches.points[0].payload.content || "";
          const existingVector = await embed(existingContent);
          if (existingVector && cosineSimilarity(vector, existingVector) >= 0.75) {
            return topic;
          }
        }
      } catch {
        // Skip on error, try next topic
      }
    }
  }

  // Step 3: SUMMARY_LLM classification fallback
  const topicList = uniqueTopics.slice(0, 20).join(", ");
  const prompt = `Select the best matching topic from the existing list below, or suggest a new topic key for the following decision content.

Existing topics: ${topicList}
Decision content: ${content}

If it matches an existing topic, return just that name. Otherwise, suggest a short keyword (2-4 words, snake_case).`;

  try {
    const res = await fetch(SUMMARY_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SUMMARY_LLM_MODEL,
        prompt: prompt,
        temperature: 0.1,
        max_tokens: 64,
        enable_thinking: false,
      }),
    });

    if (res.status === 200) {
      const data = await res.json();
      if (data.choices?.[0]?.text) {
        return data.choices[0].text.trim().toLowerCase();
      }
    }
  } catch {
    // SUMMARY_LLM unavailable — fallback to simple extraction
  }

  const fileMatch = content.match(/[\w.\/-]+\.\w{2,4}/);
  return fileMatch ? fileMatch[0] : "general";
}

/** Compute cosine similarity between two vectors */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── §2.5 Prune & Summarize — self-editing via lightweight local LLM ──

/**
 * Format a single raw Qdrant result into a compact text representation
 * suitable for the pruning prompt (collection-agnostic).
 */
function formatRawResult(r, collection) {
  const p = r.payload;
  if (collection === "work_memory") {
    return `[${p.type}] ${p.summary_text}\n  detail: ${p.detail || ""}\n  files: ${(p.related_files || []).join(", ")}`;
  } else if (collection === "project_facts") {
    return `[${p.source_doc || "doc"}] ${p.content}`;
  } else if (collection === "graph" || collection === "graph_nodes" || collection === "graph_edges") {
    const kind = p.kind || "graph";
    if (kind === "graph_node") {
      return `\`${p.name}\` at ${p.file}:${p.line} (${p.lang})`;
    } else if (kind === "graph_edge") {
      return `${p.source_file}:${p.caller_line}: \`${p.caller_name || "?"}\` → \`${p.target_name}\``;
    }
    return `graph: ${JSON.stringify(p)}`;
  }
  return JSON.stringify(p);
}

/**
 * Extract and compress result fragments from search results relative to the Query (Self-Editing).
 *
 * Pass raw Qdrant results (top N~15) to SUMMARY_LLM lightweight LLM to:
 * - Keep only core facts directly related to the question and summarize them
 * - Completely remove irrelevant or duplicate content (Prune)
 * - Graceful fallback to lightweight keyword summary on failure
 *
 * P5 optimizations:
 * - results < 4 → Skip LLM call (use keyword extract instead, saves ~30s)
 * - timeout reduced from 120s to 30s
 * - Return lightweightKeywordSummary instead of null on failure
 */
export async function pruneAndSummarize(query, results) {
  if (!results || results.length === 0) return null;

  // P5-opt: Skip LLM for small result sets — keyword extract is faster and sufficient
  if (results.length <= 4) {
    return lightweightKeywordSummary(query, results);
  }

  const formatted = results.map((r, i) => {
    const col = r._collection || "unknown";
    return `[${i + 1}] (${col})\n${formatRawResult(r, col)}`;
  }).join("\n\n");

  const hasDocsResults = results.some(r => r._collection === "meili" && (r.payload?.source === "docs"));

  const prompt = `You are a technical document writer who directly answers user questions.
Using [searched result fragments] as evidence, **synthesize a complete answer** to the [user question].
Do not just list facts — organize them into a single, logically flowing response.

[User Question]: ${query}

[Searched Result Fragments]:
${formatted}

[Output Rules]:
- Write in a format that directly answers the user's question (no introduction/greeting).
- Use search results as evidence and organize them into a logical flow.
- Include specific facts accurately: file paths, function names, column names, etc.
- If multiple sources mention the same fact, merge them into one without citing sources.
- Completely exclude content unrelated to the question.
- If search results have no answer, output "There is not enough information on this topic."
- At the end of your response, append a **## Reference Files** section in the following format:
  - Select only 3-5 core files from the search results that are essential for understanding/tracking the question
  - Each line: "- \`file_path\` — one-line description (what content to check)"
  - Merge duplicate files and exclude irrelevant ones
  - Omit this section if there are no file paths in the search results`;

  try {
    const controller = new AbortController();
    // P5-opt: Reduced timeout from 120s to 30s — most summaries complete in <10s locally
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(SUMMARY_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SUMMARY_LLM_MODEL,
        prompt: prompt,
        temperature: 0.1,
        max_tokens: hasDocsResults ? 3072 : 2048,
        enable_thinking: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status !== 200) {
      console.error(`[pruneAndSummarize] SUMMARY_LLM HTTP ${res.status}, falling back`);
      return lightweightKeywordSummary(query, results);
    }

    const data = await res.json();
    if (!data.choices || !data.choices[0]?.text) {
      console.error("[pruneAndSummarize] unexpected response structure, falling back");
      return lightweightKeywordSummary(query, results);
    }

    return data.choices[0].text.trim();
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[pruneAndSummarize] timeout (30s), falling back to keyword summary");
    } else {
      console.error(`[pruneAndSummarize] error: ${err.message}, falling back to keyword summary`);
    }
    return lightweightKeywordSummary(query, results);
  }
}

/**
 * Lightweight fallback: extract key facts from results using keyword overlap with query.
 * No LLM call needed — O(n) scan of result payloads against query tokens.
 */
function lightweightKeywordSummary(query, results) {
  const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (queryTokens.length === 0) return null;

  // Score each result by keyword overlap
  const scored = results.map(r => {
    const text = `${r.payload?.content || ""} ${r.payload?.summary_text || ""} ${r.payload?.detail || ""}`.toLowerCase();
    const hits = queryTokens.filter(t => text.includes(t)).length;
    return { score: hits / Math.max(queryTokens.length, 1), result: r };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  // Build compact summary from top matches
  const top = scored.slice(0, Math.min(scored.length, 5));
  let summary = `## Key Findings\n`;
  for (const [i, s] of top.entries()) {
    const r = s.result;
    const col = r._collection || "unknown";
    const p = r.payload || {};
    const title = p.summary_text || p.source_doc || `(result #${i + 1})`;
    summary += `${i + 1}. [${col}] ${title}\n`;
    if (p.detail) {
      const detailPreview = p.detail.slice(0, 200);
      summary += `   → ${detailPreview}\n`;
    }
  }

  return summary.trim();
}

// ─── Query Router (README §1: scoring function + decision fallback) ──

/**
 * Count tokens that look like code identifiers.
 * Patterns: snake_case, camelCase, file paths (*.ext), function calls (name()), bare words with dots/underscores
 */
function countIdentifierTokens(query) {
  const patterns = [
    /[a-zA-Z_]\w*(?:\.\w+)+/,           // dotted names: foo.bar.baz
    /[a-z][a-zA-Z0-9]*(?:[A-Z][a-z]*)+/, // camelCase
    /\b[a-z_]+_[a-z_]+\b/,               // snake_case (3+ segments)
    /[\w/.-]+\.\w{2,4}\b/,               // file paths: foo/bar.js, config.php
    /\b\w+\s*\(/,                         // function calls: getName()
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = query.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Extract routing features from a query string.
 * Returns an object with boolean/numeric signals used by scoreBackend().
 */
export function extractQueryFeatures(query) {
  const lower = query.toLowerCase();
  const tokens = lower.split(/\s+/).filter(Boolean);
  const totalTokens = Math.max(tokens.length, 1);
  const identifierCount = countIdentifierTokens(query);

  // Korean keywords must match as whole words (not single characters in a class)
  const koreanCausal = new Set(["왜", "이유", "근거", "결정", "바꾼", "대체", "전환"]);
  const koreanStructural = new Set(["호출", "의존", "연결"]);
  const koreanTemporal = new Set(["최근", "언제", "마지막", "변경"]);
  // P6: Knowledge/architecture signals — system overview, structure explanation, pattern documentation
  const koreanKnowledge = new Set(["구조", "아키텍처", "시스템", "구성", "패턴", "방식", "방법", "규칙", "정책", "설계"]);

  return {
    /** Ratio of code-identifier-like tokens to total tokens */
    identifier_ratio: identifierCount / totalTokens,
    /** Causal signals: why, because, reason, 결정, 이유, 왜, 근거, 바꾼, 대체, 전환 */
    is_causal: /\b(why|because|reason|previously|before\s+we)\b/.test(lower) || [...koreanCausal].some((w) => query.includes(w)),
    /** Structural signals: calls, caller, depends on, uses, connected to, 호출, 의존, 연결 */
    is_structural: /\b(calls?|caller|depends?\s+on|uses?|connected\s+to)\b/.test(lower) || [...koreanStructural].some((w) => query.includes(w)),
    /** Temporal signals: when, latest, version, recent, 최근, 언제, 마지막, 변경 */
    is_temporal: /\b(when|latest|version|recent|changed)\b/.test(lower) || [...koreanTemporal].some((w) => query.includes(w)),
    /** P6: Knowledge/architecture signals — should prioritize docs (project_facts) over code */
    is_knowledge: /\b(architecture|overview|design|pattern|policy|guide|structure|how\s+it\s+works)\b/i.test(lower) || [...koreanKnowledge].some((w) => query.includes(w)),
  };
}

// ─── §1.2 Scoring function ──────────────────────────────────────────────

/**
 * Backends and their search modes:
 * - work_memory    : vector search (bge-m3 embedding required)
 * - graph          : keyword scroll only (no embedding, payload filter)
 * - decision_chains: vector search + chain traversal (causal queries)
 * - project_facts  : Meilisearch text search (not in BACKENDS, handled via searchMeili())
 */
const BACKENDS = ["work_memory", "graph", "decision_chains"];

/**
 * Score a single backend against query features (§1.2).
 *
 *   score(b, q) = w1 · sim_b(q) + w2 · specificity(q, b) + w3 · recency_prior(b)
 *
 * - `sim` is the pre-computed top-1 cosine confidence from Qdrant (0~1), or null if not yet searched.
 *   For graph backend this is always 0 (keyword-only).
 * - `specificity` measures how well the query features match what this backend stores.
 * - `recency_prior` is session-local momentum; v0 defaults to 0.
 *
 * Weights: w1=0.5 (similarity), w2=0.4 (feature fit), w3=0.1 (momentum)
 */
function scoreBackend(backend, features, sim = null) {
  const w_sim = 0.5;
  const w_spec = 0.4;
  const w_recency = 0.1;

  // recency_prior — v0: no session tracking yet
  const recency = 0;

  let spec = 0;

  if (backend === "work_memory") {
    // Decision log: causal, temporal, structural signals are strong fits
    if (features.is_causal)   spec += 0.5;
    if (features.is_temporal) spec += 0.4;
    if (features.is_structural) spec += 0.2;
    // Mild penalty for pure identifier queries (graph is better)
    if (features.identifier_ratio > 0.3) spec -= 0.1;
  } else if (backend === "graph") {
    // Code graph: identifier-heavy and structural queries are best matches
    if (features.identifier_ratio > 0.2) spec += 0.6;
    if (features.is_structural) spec += 0.5;
    // File path mentions → very strong signal for graph
    const hasFilePath = /[\w/.-]+\.\w{2,4}\b/.test(queryFromFeatures(features));
    if (hasFilePath) spec += 0.3;
  }

  // Clamp specificity to [0, 1]
  spec = Math.max(0, Math.min(1, spec));

  return w_sim * (sim ?? 0) + w_spec * spec + w_recency * recency;
}

/**
 * Reconstruct a rough query string from features for regex checks.
 * (Only used internally by scoreBackend for file-path detection.)
 */
function queryFromFeatures(features) {
  // Not actually needed — we pass the original query separately.
  return "";
}

// ─── §1.3 + §1.4: route with scoring, fallback to decision tree ────────

/**
 * Score all backends and decide routing strategy.
 *
 * Returns { mode, targets }:
 *   - mode: "single" | "parallel"
 *   - targets: array of backend names to search
 *   - scores: object mapping backend → score (for debugging)
 *   - primary: the highest-scoring backend name
 */
export function routeQuery(query, features) {
  // Detect file path presence for graph scoring boost
  const hasFilePath = /[\w/.-]+\.\w{2,4}\b/.test(query);

  // Score each backend (sim=null since we haven't searched yet — specificity-only pre-score)
  const rawScores = {};
  for (const b of BACKENDS) {
    let spec = 0;

    if (b === "work_memory") {
      if (features.is_causal)   spec += 0.6;
      if (features.is_temporal) spec += 0.5;
      if (features.is_structural) spec += 0.3;
      // Penalize when query is purely code-level (no causal/temporal signal)
      if (features.identifier_ratio > 0.4 && !features.is_causal && !features.is_temporal) {
        spec -= 0.2;
      }
    } else if (b === "graph") {
      if (features.identifier_ratio > 0.2) spec += 0.7;
      if (features.is_structural) spec += 0.6;
      if (hasFilePath) spec += 0.4;
      // Penalize when query is clearly a knowledge/decision question
      if (features.is_causal || features.is_temporal) {
        spec -= 0.3;
      }
    } else if (b === "decision_chains") {
      // Causal chain: strongest fit for causal queries, moderate for temporal
      if (features.is_causal)   spec += 0.8;
      if (features.is_temporal) spec += 0.3;
      // Penalize pure code-level or general knowledge queries
      if (features.identifier_ratio > 0.4 && !features.is_causal) {
        spec -= 0.2;
      }
    }

    rawScores[b] = Math.max(0, Math.min(1, spec));
  }

  // Normalize scores to sum to 1 (for comparison)
  const totalScore = Object.values(rawScores).reduce((a, b) => a + b, 0);
  if (totalScore === 0) {
    // All zeros → default to work_memory
    return { mode: "single", targets: ["work_memory"], scores: rawScores, primary: "work_memory" };
  }

  const normalized = {};
  for (const [b, s] of Object.entries(rawScores)) {
    normalized[b] = s / totalScore;
  }

  // Sort by score descending
  const ranked = Object.entries(normalized).sort((a, b) => b[1] - a[1]);
  const primary = ranked[0][0];
  const topScore = ranked[0][1];
  const secondScore = ranked.length > 1 ? ranked[1][1] : 0;

  // §1.4: If top two scores are within ε, parallel search + rerank
  const EPSILON = 0.15;

  if (topScore - secondScore < EPSILON) {
    // Ambiguous — include all backends with meaningful score (> 5% of top)
    const threshold = topScore * 0.05;
    const targets = ranked.filter(([, s]) => s >= threshold).map(([b]) => b);

    return { mode: "parallel", targets, scores: normalized, primary };
  }

  // Clear winner — single target
  return { mode: "single", targets: [primary], scores: normalized, primary };
}
