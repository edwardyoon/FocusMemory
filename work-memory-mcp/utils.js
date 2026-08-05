import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

const QWEN_URL = process.env.QWEN_URL || "http://127.0.0.1:8080/v1/chat/completions";
const BGE_URL = process.env.BGE_URL || "http://127.0.0.1:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const BONSAI_URL = process.env.BONSAI_URL || "http://127.0.0.1:8081/v1/chat/completions";
const BONSAI_MODEL = process.env.BONSAI_MODEL || "bonsai-27b";

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

export const DOCS_SYSTEM_PROMPT = `당신은 기술 문서를 RAG 검색용 지식 조각(chunk)으로 변환하는 전문가입니다.

아래 마크다운 문서를 읽고, 독립적으로 검색 가능한 사실(fact) 단위로 쪼개서 JSON 배열로만 출력하세요.

규칙:
1. 각 chunk는 그 자체로 완결된 문장이어야 합니다. "이 값은", "위 표에서" 같은 문맥 의존 표현 금지 — 반드시 무엇을 가리키는지 명시하세요.
2. 하나의 chunk는 하나의 사실/개념만 담습니다.
3. 코드 예시, 설정값, IP 주소, 컬럼명 등 구체적 사실은 절대 누락하거나 요약하지 말고 원문 그대로 보존하세요.
4. 절차/순서가 있는 내용은 하나의 chunk로 유지하되, 너무 길면 논리적 단위로 분리하세요.
5. 각 chunk는 3~6문장 이내로 작성하세요.
6. 잡담, 배경 설명, 중복 내용은 제외하세요.

출력 형식 (JSON만 출력, 다른 텍스트 절대 포함 금지):
[{"content": "...", "section_title": "...", "tags": ["...", "..."]}]`;

export const PLANS_SYSTEM_PROMPT = `You are an expert at converting work plan/history documents into knowledge chunks for the work_memory MCP server.

The markdown document below records work plans, decisions, and completed issues from a past session.
Read the document and split it into independently searchable fact-level chunks, output as a JSON array only.

Rules:
1. Each chunk must be a self-contained sentence. Context-dependent phrases like "this value" or "in the table above" are forbidden — always state explicitly what is being referred to.
2. Each chunk contains exactly one fact or concept.
3. Never omit or summarize concrete details such as file paths, code locations (line numbers), or function names — preserve them verbatim.
4. Keep bug fix details, applied patches, and verification methods as a single chunk, but split into logical units if too long.
5. Each chunk should be no more than 3–6 sentences.
6. Exclude small talk and background explanation.

Output format (JSON only, absolutely no other text):
[{"content": "...", "section_title": "..."}]`;

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

export async function chunkDocument(docText, systemPrompt, maxRetries = 2) {
  const body = JSON.stringify({
    model: "qwen3.6-27b",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: docText },
    ],
    temperature: 0.1,
    max_tokens: 14096,
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);

    try {
      console.log(`  [LLM request] attempt ${attempt}/${maxRetries}`);

      const res = await fetch(QWEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (res.status !== 200) {
        console.error(`  [LLM error] HTTP ${res.status}`);
        return [];
      }

      const data = await res.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        console.error("  [response structure error]");
        return [];
      }

      let raw = data.choices[0].message.content.trim();
      if (!raw) {
        console.error("  [response content is empty]");
        return [];
      }

      raw = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");

      const parsed = JSON.parse(raw);
      console.log(`  [JSON parsed OK] ${parsed.length} chunks`);
      return parsed;
    } catch (e) {
      if (e.name === "AbortError") {
        console.error(`  [LLM timeout] attempt ${attempt}, exceeded 600s (10 min)`);
      } else if (e.name === "SyntaxError") {
        console.error("  [JSON parse failed]", e.message);
        return [];
      } else {
        console.error(`  [network error] attempt ${attempt}: ${e.message}`);
      }

      if (attempt < maxRetries) {
        console.log(`  → retrying in ${attempt === 1 ? "30s" : "60s"}...`);
        await new Promise((r) => setTimeout(r, attempt === 1 ? 30000 : 60000));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  console.error("  → all retries failed");
  return [];
}

export async function deletePointsByDoc(collection, sourceDoc) {
  await qdrant.delete(collection, {
    filter: {
      must: [{ key: "source_doc", match: { value: sourceDoc } }],
    },
  });
}

// ─── Decision Chains — topic key inference via BONSAI ──────────────

/**
 * Infer a topic_key for a new decision by comparing against existing topics.
 * Uses embedding similarity first (threshold 0.75), then falls back to BONSAI classification.
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

  // Step 3: BONSAI classification fallback
  const topicList = uniqueTopics.slice(0, 20).join(", ");
  const prompt = `아래 결정 내용을 가장 잘 설명하는 주제(topic)를 선택하거나 새 주제를 제안하세요.

기존 주제 목록: ${topicList}
결정 내용: ${content}

기존 주제 중 하나와 일치하면 그 이름만, 아니면 새로운 짧은 키워드(2~4단어, snake_case)로 답하세요.`;

  try {
    const res = await fetch(BONSAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BONSAI_MODEL,
        prompt: prompt,
        temperature: 0.1,
        max_tokens: 64,
      }),
    });

    if (res.status === 200) {
      const data = await res.json();
      if (data.choices?.[0]?.text) {
        return data.choices[0].text.trim().toLowerCase();
      }
    }
  } catch {
    // BONSAI unavailable — fallback to simple extraction
  }

  const fileMatch = content.match(/[\w.\/-]+\.\w{2,4}/);
  return fileMatch ? fileMatch[0] : "general";
}

/** Compute cosine similarity between two vectors */
function cosineSimilarity(a, b) {
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
 * Search result fragments를 Query 관점에서 필요한 내용만 추출/압축 (Self-Editing).
 *
 * Raw Qdrant 결과(top N~15개)를 BONSAI 경량 LLM에 전달하여:
 * - 질문과 직접 관련된 핵심 팩트만 남기고 요약
 * - 무관하거나 중복된内容是 완전히 제거(Prune)
 * - 실패 시 원본 raw 포맷으로 graceful fallback
 */
export async function pruneAndSummarize(query, results) {
  if (!results || results.length === 0) return null;

  const formatted = results.map((r, i) => {
    const col = r._collection || "unknown";
    return `[${i + 1}] (${col})\n${formatRawResult(r, col)}`;
  }).join("\n\n");

  const prompt = `너는 검색 컨텍스트 편집자다.
[사용자 질문]에 답하는 데 **직접적으로 필요한 핵심 팩트**만 검색 결과에서 추출하여 압축 요약하라.
질문과 관련 없거나 중복되는 내용은 완전히 제거(Prune)해라.

[사용자 질문]: ${query}

[검색된 결과 파편들]:
${formatted}

[출력 규칙]:
- 핵심 팩트 위주의 요약된 텍스트만 출력할 것.
- 불필요한 서론/인사말 금지.
- 원본의 파일 경로, 함수명, 컬럼명 등 구체적 사실은 절대 누락하지 말 것.
- 여러 소스가 같은 사실을 언급하면 하나로 병합할 것.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const res = await fetch(BONSAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BONSAI_MODEL,
        prompt: prompt,
        temperature: 0.1,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status !== 200) {
      console.error(`[pruneAndSummarize] BONSAI HTTP ${res.status}, falling back`);
      return null;
    }

    const data = await res.json();
    if (!data.choices || !data.choices[0]?.text) {
      console.error("[pruneAndSummarize] unexpected response structure, falling back");
      return null;
    }

    return data.choices[0].text.trim();
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[pruneAndSummarize] timeout (120s), falling back to raw");
    } else {
      console.error(`[pruneAndSummarize] error: ${err.message}, falling back to raw`);
    }
    return null;
  }
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

  return {
    /** Ratio of code-identifier-like tokens to total tokens */
    identifier_ratio: identifierCount / totalTokens,
    /** Causal signals: why, because, reason, 결정, 이유, 왜, 근거, 바꾼, 대체, 전환 */
    is_causal: /\b(why|because|reason|previously|before\s+we)\b/.test(lower) || [...koreanCausal].some((w) => query.includes(w)),
    /** Structural signals: calls, caller, depends on, uses, connected to, 호출, 의존, 연결 */
    is_structural: /\b(calls?|caller|depends?\s+on|uses?|connected\s+to)\b/.test(lower) || [...koreanStructural].some((w) => query.includes(w)),
    /** Temporal signals: when, latest, version, recent, 최근, 언제, 마지막, 변경 */
    is_temporal: /\b(when|latest|version|recent|changed)\b/.test(lower) || [...koreanTemporal].some((w) => query.includes(w)),
  };
}

// ─── §1.2 Scoring function ──────────────────────────────────────────────

/**
 * Backends and their search modes:
 * - work_memory    : vector search (bge-m3 embedding required)
 * - project_facts  : vector search (bge-m3 embedding required)
 * - graph          : keyword scroll only (no embedding, payload filter)
 * - decision_chains: vector search + chain traversal (causal queries)
 */
const BACKENDS = ["work_memory", "project_facts", "graph", "decision_chains"];

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
  } else if (backend === "project_facts") {
    // Knowledge base: general semantic queries are the primary fit
    spec += 0.2; // baseline affinity for any query
    if (!features.is_causal && !features.is_temporal && !features.is_structural) {
      spec += 0.4; // strong fit for pure semantic/general questions
    }
    if (features.identifier_ratio > 0.3) spec += 0.1; // docs may mention identifiers
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
    } else if (b === "project_facts") {
      // Lower baseline — project_facts should win only when clearly a docs/knowledge query
      if (!features.is_causal && !features.is_temporal && !features.is_structural) {
        spec += 0.5; // general semantic → strong fit
      } else {
        spec += 0.1; // weak baseline when other signals present
      }
      if (features.identifier_ratio > 0.3) spec += 0.1;
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
    // All zeros → default to project_facts
    return { mode: "single", targets: ["project_facts"], scores: rawScores, primary: "project_facts" };
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
