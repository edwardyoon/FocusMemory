import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Meilisearch } from "meilisearch";
import Parser from "tree-sitter";
import JSLang from "tree-sitter-javascript";
import { scanFiles, loadIgnorePatterns } from "../lib/utils.js";

// ─── Configuration ──────────────────────────────────────────────

const ROOT_DIR = process.env.GRAPH_ROOT || "/opt/homebrew/var/www";
const STATE_FILE = path.join(process.cwd(), "code_structure_state.json");
const MAX_FILE_SIZE = 200_000;

// Meilisearch
const meiliClient = new Meilisearch({
  host: process.env.MEILI_HOST || "http://localhost:7700",
  apiKey: process.env.MEILI_MASTER_KEY || "",
});
const MEILI_INDEX = process.env.MEILI_CODE_STRUCTURE_INDEX || "code_structure";

// ─── Parser (JS AST) ────────────────────────────────────────────

const jsParser = new Parser();
jsParser.setLanguage(JSLang);

// ─── State management ──────────────────────────────────────────

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { files: {} };
  }
}

async function saveState(state) {
  state.last_run = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ─── Entity extraction (lightweight — no embedding needed) ──────

function extractEntitiesJS(sourceCode) {
  const entities = [];
  const tree = jsParser.parse(sourceCode);

  function walk(node) {
    switch (node.type) {
      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) entities.push({ name: nameNode.text, type: "function", line: node.startPosition.row + 1 });
        break;
      }
      case "method_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode && nameNode.type !== "field") entities.push({ name: nameNode.text, type: "method", line: node.startPosition.row + 1 });
        break;
      }
      case "class_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) entities.push({ name: nameNode.text, type: "class", line: node.startPosition.row + 1 });
        break;
      }
    }

    if (node.type !== "class_declaration") {
      for (let i = 0; i < node.childCount; i++) walk(node.children[i]);
    } else {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.children[i];
        if (child.type === "class_body" || child.type === "field") continue;
        walk(child);
      }
    }
  }

  walk(tree.rootNode);

  // Arrow functions assigned to variables
  function extractArrows(node) {
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (nameNode && valueNode && valueNode.type === "arrow_function") {
        entities.push({ name: nameNode.text, type: "function", line: valueNode.startPosition.row + 1 });
      }
    }
    for (let i = 0; i < node.childCount; i++) extractArrows(node.children[i]);
  }
  extractArrows(tree.rootNode);

  return entities;
}

function extractEntitiesRegex(sourceCode, ext) {
  const entities = [];
  const lines = sourceCode.split("\n");

  function findBlockEnd(openPos) {
    let depth = 0;
    for (let i = openPos; i < sourceCode.length; i++) {
      if (sourceCode[i] === "{") depth++;
      else if (sourceCode[i] === "}") { depth--; if (depth === 0) return i + 1; }
    }
    return sourceCode.length;
  }

  function findOpenBrace(lineNum) {
    const lineStart = lines.slice(0, lineNum).join("\n").length + (lineNum > 0 ? 1 : 0);
    const lineEnd = lineStart + lines[lineNum].length;
    for (let i = lineStart; i < Math.min(lineEnd, sourceCode.length); i++) {
      if (sourceCode[i] === "{") return i;
    }
    for (let j = lineNum + 1; j < Math.min(lineNum + 3, lines.length); j++) {
      const nextStart = lines.slice(0, j).join("\n").length + 1;
      for (let i = nextStart; i < nextStart + lines[j].length; i++) {
        if (sourceCode[i] === "{") return i;
      }
    }
    return -1;
  }

  if (ext === "ts") {
    // TypeScript: function declarations
    const fnRe = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/g;
    let m;
    while ((m = fnRe.exec(sourceCode)) !== null) {
      entities.push({ name: m[1], type: "function", line: sourceCode.substring(0, m.index).split("\n").length });
    }
    // Arrow functions
    const arrowRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(.*?\)\s*(?::\s*\S+\s*)?=>\s*\{/g;
    while ((m = arrowRe.exec(sourceCode)) !== null) {
      entities.push({ name: m[1], type: "function", line: sourceCode.substring(0, m.index).split("\n").length });
    }
  } else if (ext === "php") {
    const fnRe = /(?:public\s+|private\s+|protected\s+|static\s+)*?function\s+(\w+)\s*\(/g;
    let m;
    while ((m = fnRe.exec(sourceCode)) !== null) {
      entities.push({ name: m[1], type: "function", line: sourceCode.substring(0, m.index).split("\n").length });
    }
  }

  return entities;
}

// ─── Import keyword extraction ──────────────────────────────────

function extractImports(sourceCode, ext) {
  const imports = [];

  if (ext === "js" || ext === "ts") {
    // import X from 'module' / require('module')
    const importRe = /(?:import|require)\s*[\('"]([^'")\s]+)/g;
    let m;
    while ((m = importRe.exec(sourceCode)) !== null) imports.push(m[1]);
  } else if (ext === "php") {
    // use Namespace\Class
    const useRe = /^\s*use\s+([\w\\]+)/gm;
    let m;
    while ((m = useRe.exec(sourceCode)) !== null) imports.push(m[1]);
  }

  return [...new Set(imports)].slice(0, 30); // deduplicate, cap at 30
}

// ─── Meilisearch operations ─────────────────────────────────────

let meiliIdx = null;

async function getMeiliIndex() {
  if (meiliIdx) return meiliIdx;
  // client.index() always returns an Index object even if it doesn't exist yet.
  // addDocuments will auto-create the index on first call.
  meiliIdx = meiliClient.index(MEILI_INDEX);
  return meiliIdx;
}

function buildUid(relPath) {
  return `file_${relPath.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function upsertDoc(index, doc) {
  await index.addDocuments([doc], { primaryKey: "uid" });
}

async function deleteDoc(index, uid) {
  await index.deleteDocument(uid);
}

// ─── Main indexing pipeline ─────────────────────────────────────

async function indexFile(filePath, scanRoot) {
  const relPath = path.relative(scanRoot, filePath);
  const ext = path.extname(filePath).slice(1);
  const stat = await fs.stat(filePath);
  const hash = crypto.createHash("md5").update(`${stat.mtimeMs}:${stat.size}`).digest("hex");

  const sourceCode = await fs.readFile(filePath, "utf-8");
  const lineCount = sourceCode.split("\n").length;

  // Extract entities based on language
  let entities;
  if (ext === "js") {
    try {
      entities = extractEntitiesJS(sourceCode);
    } catch {
      entities = extractEntitiesRegex(sourceCode, ext);
    }
  } else {
    entities = extractEntitiesRegex(sourceCode, ext);
  }

  const imports = extractImports(sourceCode, ext);

  // First line comment or meaningful first line
  const firstLines = sourceCode.split("\n").filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*")).slice(0, 1);
  const description = firstLines[0] ? firstLines[0].trim().slice(0, 200) : "";

  return {
    uid: buildUid(relPath),
    filepath: relPath,
    filename: path.basename(filePath),
    dirname: path.dirname(relPath),
    extension: ext,
    language: ext === "ts" ? "typescript" : ext,
    line_count: lineCount,
    size_bytes: stat.size,
    entities: entities.map(e => `${e.type}:${e.name}`),
    entity_names: entities.map(e => e.name),
    imports,
    description,
    content_hash: hash,
    indexed_at: new Date().toISOString(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const targetDir = args.find(a => !a.startsWith("--"));
  const force = args.includes("--force") || args.includes("-f");
  const scanRoot = targetDir ? path.resolve(targetDir) : ROOT_DIR;

  console.log("=== Index Code Structure (Meilisearch) ===");
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

  const state = await loadState();
  const index = await getMeiliIndex();
  const extSet = new Set(["js", "ts", "php"]);
  const files = await scanFiles(scanRoot, extSet, MAX_FILE_SIZE);

  console.log("[scan] found %d files\n", files.length);

  let processed = 0, skipped = 0, updated = 0, failed = 0;
  const currentFiles = new Set();

  for (const filePath of files) {
    try {
      const relPath = path.relative(scanRoot, filePath);
      currentFiles.add(relPath);
      const stat = await fs.stat(filePath);
      const hash = crypto.createHash("md5").update(`${stat.mtimeMs}:${stat.size}`).digest("hex");

      // Incremental: skip if unchanged
      if (!force && state.files[relPath]?.hash === hash) {
        skipped++;
        processed++;
        continue;
      }

      const doc = await indexFile(filePath, scanRoot);
      await upsertDoc(index, doc);
      state.files[relPath] = { hash, indexed_at: new Date().toISOString() };
      updated++;
      processed++;

      if (processed % 100 === 0) {
        console.log("  → processed %d (%d updated, %d skipped)", processed, updated, skipped);
      }
    } catch (err) {
      failed++;
      console.error("  ✗ %s — %s", path.relative(scanRoot, filePath), err.message);
    }
  }

  // Detect deleted files
  const deletedKeys = Object.keys(state.files).filter(k => !currentFiles.has(k));
  if (deletedKeys.length > 0) {
    console.log(`\n[delete] removing ${deletedKeys.length} stale entries`);
    for (const relPath of deletedKeys) {
      try {
        await deleteDoc(index, buildUid(relPath));
      } catch {}
      delete state.files[relPath];
    }
  }

  console.log("\n=== Summary ===");
  console.log("  Files processed: %d", processed);
  console.log("  Updated: %d", updated);
  console.log("  Skipped (unchanged): %d", skipped);
  console.log("  Deleted: %d", deletedKeys.length);
  console.log("  Failed: %d", failed);

  if (force || updated > 0 || deletedKeys.length > 0) {
    await saveState(state);
  }

  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
