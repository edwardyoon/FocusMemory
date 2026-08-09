import dotenv from "dotenv";
dotenv.config({ override: true }); // .env takes priority — override settings.json env vars;
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import Parser from "tree-sitter";
import JSLang from "tree-sitter-javascript";
import { qdrant, scanFiles, embed } from "../utils.js";

// ─── Configuration ──────────────────────────────────────────────

const ROOT_DIR = process.env.GRAPH_ROOT || "/opt/homebrew/var/www";
const MAX_FILE_SIZE = 200_000;
const MAX_CHUNK_CHARS = 4000; // skip chunks larger than this (~safe margin for bge-m3 8192 token limit)
const EMBED_BATCH_DELAY_MS = 100; // throttle between files to avoid BGE server overload

// ─── Parser setup (JS AST, same as buildGraph.js) ──────────────

const jsParser = new Parser();
jsParser.setLanguage(JSLang);

// ─── Chunk extraction: JavaScript (tree-sitter AST) ────────────

function extractChunksFromJS(sourceCode, filePath) {
  const chunks = [];
  const tree = jsParser.parse(sourceCode);

  function walk(node) {
    let entityType = null;
    let entityName = null;

    switch (node.type) {
      case "function_declaration": {
        entityType = "function";
        const nameNode = node.childForFieldName("name");
        if (nameNode) entityName = nameNode.text;
        break;
      }
      case "method_definition": {
        entityType = "method";
        const nameNode = node.childForFieldName("name");
        if (nameNode) entityName = nameNode.text;
        break;
      }
      case "class_declaration": {
        entityType = "class";
        const nameNode = node.childForFieldName("name");
        if (nameNode) entityName = nameNode.text;
        break;
      }
    }

    // If this is a chunkable node, extract the text slice
    if (entityType && entityName) {
      const text = sourceCode.slice(node.startIndex, node.endIndex);
      if (text.length <= MAX_CHUNK_CHARS) {
        chunks.push({
          content: text.trim(),
          entity_type: entityType,
          entity_name: entityName,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
        });
      }
    }

    // Recurse into children (skip already-collected class body for method-level granularity)
    if (entityType !== "class") {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.children[i]);
      }
    } else {
      // For classes, walk children to find methods inside
      for (let i = 0; i < node.childCount; i++) {
        const child = node.children[i];
        if (child.type === "class_body" || child.type === "field") continue;
        walk(child);
      }
    }
  }

  // Second pass: arrow functions assigned to variables
  function extractArrows(node) {
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (nameNode && valueNode && valueNode.type === "arrow_function") {
        const text = sourceCode.slice(valueNode.startIndex, valueNode.endIndex);
        if (text.length <= MAX_CHUNK_CHARS) {
          chunks.push({
            content: text.trim(),
            entity_type: "function",
            entity_name: nameNode.text,
            start_line: valueNode.startPosition.row + 1,
            end_line: valueNode.endPosition.row + 1,
          });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      extractArrows(node.children[i]);
    }
  }

  walk(tree.rootNode);
  extractArrows(tree.rootNode);

  return chunks;
}

// ─── Chunk extraction: TypeScript (regex fallback) ─────────────

function extractChunksFromTSRegex(sourceCode, filePath) {
  const chunks = [];
  const lines = sourceCode.split("\n");

  // Helper: find matching closing brace for a given opening position
  function findBlockEnd(openPos) {
    let depth = 0;
    let inString = false;
    let stringChar = null;
    for (let i = openPos; i < sourceCode.length; i++) {
      const ch = sourceCode[i];
      if (inString) {
        if (ch === "\\" ) { i++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = true; stringChar = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return i + 1; }
    }
    return sourceCode.length; // fallback: rest of file
  }

  // Find opening brace position for a given line number
  function findOpenBrace(lineNum) {
    const lineStart = lines.slice(0, lineNum).join("\n").length + (lineNum > 0 ? 1 : 0);
    const lineEnd = lineStart + lines[lineNum].length;
    for (let i = lineStart; i < Math.min(lineEnd, sourceCode.length); i++) {
      if (sourceCode[i] === "{") return i;
    }
    // Look ahead a few lines
    for (let j = lineNum + 1; j < Math.min(lineNum + 3, lines.length); j++) {
      const nextLineStart = lines.slice(0, j).join("\n").length + 1;
      for (let i = nextLineStart; i < nextLineStart + lines[j].length; i++) {
        if (sourceCode[i] === "{") return i;
      }
    }
    return -1;
  }

  // Match: (export)? (async)? function name(...)
  const fnRe = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/g;
  let m;
  while ((m = fnRe.exec(sourceCode)) !== null) {
    const lineNum = sourceCode.substring(0, m.index).split("\n").length - 1;
    const openPos = findOpenBrace(lineNum);
    if (openPos > 0) {
      const endPos = findBlockEnd(openPos);
      const text = sourceCode.slice(m.index, endPos).trim();
      if (text.length <= MAX_CHUNK_CHARS && text.length > 20) {
        chunks.push({
          content: text,
          entity_type: "function",
          entity_name: m[1],
          start_line: lineNum + 1,
          end_line: sourceCode.substring(0, endPos).split("\n").length,
        });
      }
    }
  }

  // Match arrow functions: const/let/var name = ... => {
  const arrowRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(.*?\)\s*(?::\s*\S+\s*)?=>\s*\{/g;
  while ((m = arrowRe.exec(sourceCode)) !== null) {
    const lineNum = sourceCode.substring(0, m.index).split("\n").length - 1;
    const openPos = m.index + m[0].length - 1; // position of {
    const endPos = findBlockEnd(openPos);
    const text = sourceCode.slice(m.index, endPos).trim();
    if (text.length <= MAX_CHUNK_CHARS && text.length > 20) {
      chunks.push({
        content: text,
        entity_type: "function",
        entity_name: m[1],
        start_line: lineNum + 1,
        end_line: sourceCode.substring(0, endPos).split("\n").length,
      });
    }
  }

  return chunks;
}

// ─── Chunk extraction: PHP (regex fallback) ────────────────────

function extractChunksFromPHPRegex(sourceCode, filePath) {
  const chunks = [];

  // Helper: find matching closing brace
  function findBlockEnd(openPos) {
    let depth = 0;
    for (let i = openPos; i < sourceCode.length; i++) {
      const ch = sourceCode[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return i + 1; }
    }
    return sourceCode.length;
  }

  // Match: function name( ... ) {
  const fnRe = /(?:public\s+|private\s+|protected\s+|static\s+)*?function\s+(\w+)\s*\(.*?\)\s*\{/g;
  let m;
  while ((m = fnRe.exec(sourceCode)) !== null) {
    const lineNum = sourceCode.substring(0, m.index).split("\n").length - 1;
    const bracePos = m.index + m[0].length - 1; // position of opening {
    const endPos = findBlockEnd(bracePos);
    const text = sourceCode.slice(m.index, endPos).trim();

    if (text.length <= MAX_CHUNK_CHARS && text.length > 20) {
      chunks.push({
        content: text,
        entity_type: "function",
        entity_name: m[1],
        start_line: lineNum + 1,
        end_line: sourceCode.substring(0, endPos).split("\n").length,
      });
    }
  }

  return chunks;
}

// ─── Main indexing pipeline ────────────────────────────────────

async function indexFile(filePath, scanRoot) {
  const relPath = path.relative(scanRoot, filePath);
  const ext = path.extname(filePath).slice(1);
  const sourceCode = await fs.readFile(filePath, "utf-8");
  const hash = crypto.createHash("sha256").update(sourceCode).digest("hex");

  // Check if file content changed since last index
  const existing = await qdrant.scroll("code_chunks", {
    filter: { must: [{ key: "file_path", match: { value: relPath } }] },
    limit: 1,
    with_payload: true,
  });

  if (existing.points.length > 0 && existing.points[0].payload.content_hash === hash) {
    return { skipped: true }; // no change
  }

  // Delete old chunks for this file
  const deleteCount = existing.points.length;
  if (deleteCount > 0) {
    await qdrant.delete("code_chunks", {
      filter: { must: [{ key: "file_path", match: { value: relPath } }] },
    });
  }

  // Extract chunks based on language
  let rawChunks;
  if (ext === "js") {
    rawChunks = extractChunksFromJS(sourceCode, filePath);
  } else if (ext === "ts") {
    rawChunks = extractChunksFromTSRegex(sourceCode, filePath);
  } else if (ext === "php") {
    rawChunks = extractChunksFromPHPRegex(sourceCode, filePath);
  } else {
    return { skipped: true };
  }

  if (rawChunks.length === 0) {
    return { extracted: 0, embedded: 0 };
  }

  // Build embedding texts: "entity_type entity_name:\ncontent"
  const embedTexts = rawChunks.map((c) => `${c.entity_type} ${c.entity_name}:\n${c.content}`);

  // Embed in parallel (each chunk gets its own vector via shared embed())
  const vectors = await Promise.all(embedTexts.map((t) => embed(t)));

  // Filter out failed embeddings
  const validChunks = rawChunks.filter((_, i) => vectors[i] !== null);
  const validVectors = vectors.filter((v) => v !== null);

  if (validChunks.length === 0) {
    return { extracted: rawChunks.length, embedded: 0 };
  }

  // Upsert to Qdrant
  const points = validChunks.map((c, i) => ({
    id: crypto.randomUUID(),
    vector: validVectors[i],
    payload: {
      file_path: relPath,
      entity_type: c.entity_type,
      entity_name: c.entity_name,
      start_line: c.start_line,
      end_line: c.end_line,
      language: ext === "ts" ? "typescript" : ext,
      content: c.content,
      content_hash: hash,
      indexed_at: new Date().toISOString(),
    },
  }));

  // Batch upsert in chunks of 500
  const batchSize = 500;
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    await qdrant.upsert("code_chunks", { points: batch, wait: true });
  }

  // Small delay to throttle BGE server load
  if (EMBED_BATCH_DELAY_MS > 0) {
    await new Promise((r) => setTimeout(r, EMBED_BATCH_DELAY_MS));
  }

  return { extracted: rawChunks.length, embedded: validChunks.length };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--force");
  const targetDir = args.length > 0 ? args[0] : null;
  const force = process.argv.includes("--force");
  const scanRoot = targetDir ? path.resolve(targetDir) : ROOT_DIR;

  console.log("=== Index Code Chunks (semantic_codesearch) ===");
  console.log("[root] %s", scanRoot);
  console.log("[mode] %s", force ? "force reindex" : "incremental");

  if (targetDir) {
    try {
      await fs.access(scanRoot);
    } catch {
      console.error("Error: directory not found — %s", scanRoot);
      process.exit(1);
    }
  }

  // If --force, clear existing collection first
  if (force) {
    const count = await qdrant.count("code_chunks");
    if (count.count > 0) {
      await qdrant.delete("code_chunks", { filter: {} });
      console.log("[clear] removed %d existing points from code_chunks", count.count);
    }
  }

  const extSet = new Set(["js", "ts", "php"]);
  const files = await scanFiles(scanRoot, extSet, MAX_FILE_SIZE);
  console.log("[scan] found %d files\n", files.length);

  let processed = 0;
  let skipped = 0;
  let totalExtracted = 0;
  let totalEmbedded = 0;
  let failed = 0;

  for (const filePath of files) {
    try {
      const result = await indexFile(filePath, scanRoot);
      processed++;

      if (result.skipped) {
        skipped++;
      } else {
        totalExtracted += result.extracted || 0;
        totalEmbedded += result.embedded || 0;
      }

      if (processed % 50 === 0) {
        console.log("  → processed %d files (%d skipped, %d chunks embedded so far)", processed, skipped, totalEmbedded);
      }
    } catch (err) {
      failed++;
      console.error("  ✗ %s — %s", path.relative(scanRoot, filePath), err.message);
    }
  }

  console.log("\n=== Summary ===");
  console.log("  Files processed: %d", processed);
  console.log("  Files skipped (no change): %d", skipped);
  console.log("  Files failed: %d", failed);
  console.log("  Chunks extracted: %d", totalExtracted);
  console.log("  Chunks embedded & upserted: %d", totalEmbedded);
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
