import dotenv from "dotenv";
dotenv.config({ override: true }); // .env 최우선 — settings.json env 변수 오버라이드;
import fs from "fs/promises";
import path from "path";
import { qdrant, scanFiles } from "./utils.js";
import Parser from "tree-sitter";
import JSLang from "tree-sitter-javascript";

// ─── Configuration ──────────────────────────────────────────────

const ROOT_DIR = process.env.GRAPH_ROOT || "/opt/homebrew/var/www";
const MAX_FILE_SIZE = 200_000; // skip files > 200KB

// ─── Parser setup ──────────────────────────────────────────────

const jsParser = new Parser();
jsParser.setLanguage(JSLang);

// PHP grammar (tree-sitter-php) is not compatible with tree-sitter@0.25 yet.
// For now, we use a lightweight regex-based fallback for PHP function extraction.
function extractFromPHPRegex(sourceCode) {
  const functions = [];
  const calls = [];

  // Match: function name(), public function name(), private function name()
  const fnRe = /(?:public\s+|private\s+|protected\s+|static\s+)*?function\s+(\w+)\s*\(/g;
  let m;
  while ((m = fnRe.exec(sourceCode)) !== null) {
    functions.push({ name: m[1], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
  }

  // Match method declarations: public function name(), etc. inside classes
  const methodRe = /(->|::)(\w+)\s*\(/g;
  while ((m = methodRe.exec(sourceCode)) !== null) {
    calls.push({ name: m[2], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
  }

  // Match standalone function calls: functionName(
  const callRe = /(?<![->:.])(\w+)\s*\(/g;
  while ((m = callRe.exec(sourceCode)) !== null) {
    // Skip PHP keywords
    if (!/^(if|else|elseif|while|for|foreach|switch|case|return|echo|print|isset|empty|exit|die|include|require|function|class|new|try|catch|throw)$/.test(m[1])) {
      calls.push({ name: m[1], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
    }
  }

  return { functions, calls };
}

// TypeScript grammar (tree-sitter-typescript) is not compatible with tree-sitter@0.25 yet.
// Use regex-based fallback similar to PHP — covers export/async functions, class methods, arrow funcs.
function extractFromTSRegex(sourceCode) {
  const functions = [];
  const calls = [];

  // Match: (export)? (async)? function name(...)
  const fnRe = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/g;
  let m;
  while ((m = fnRe.exec(sourceCode)) !== null) {
    functions.push({ name: m[1], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
  }

  // Match class methods: (public|private|protected)? (async)? methodName(...)
  const methodRe = /(?:^\s+(?:public|private|protected|readonly|static)\s+)*?(?:async\s+)?(\w+)\s*\(.*?\)\s*(?::\s*\S+\s*)?\{/gm;
  while ((m = methodRe.exec(sourceCode)) !== null) {
    if (!/^(if|else|while|for|switch|catch|class)$/.test(m[1])) {
      functions.push({ name: m[1], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
    }
  }

  // Match arrow functions: const/let/var name = ... =>
  const arrowRe = /(?:const|let|var)\s+(\w+)\s*=.*?=>\s*\{/g;
  while ((m = arrowRe.exec(sourceCode)) !== null) {
    functions.push({ name: m[1], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
  }

  // Match calls (same pattern as JS — dot-separated method calls)
  const callRe = /(\w+)\s*\(/g;
  while ((m = callRe.exec(sourceCode)) !== null) {
    if (!/^(if|else|while|for|foreach|switch|case|return|typeof|instanceof|new|try|catch|throw|async|await|import|export|from|class|extends|implements)$/.test(m[1])) {
      calls.push({ name: m[1], start: sourceCode.substring(0, m.index).split("\n").length - 1 });
    }
  }

  return { functions, calls };
}

// ─── File scanning ──────────────────────────────────────────────
// scanFiles() imported from utils.js — respects .focusmemoryignore

// ─── AST extraction: JavaScript/TypeScript ──────────────────────

function extractFromJS(sourceCode) {
  const tree = jsParser.parse(sourceCode);
  const functions = [];
  const calls = [];

  function walk(node) {
    switch (node.type) {
      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functions.push({ name: nameNode.text, start: node.startPosition.row });
        }
        break;
      }
      case "method_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functions.push({ name: nameNode.text, start: node.startPosition.row });
        }
        break;
      }
      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (callee && callee.text.length < 100) {
          calls.push({ name: callee.text, start: node.startPosition.row });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.children[i]);
    }
  }

  // Second pass: variable declarations with arrow functions
  function extractArrows(node) {
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (nameNode && valueNode && valueNode.type === "arrow_function") {
        functions.push({ name: nameNode.text, start: node.startPosition.row });
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      extractArrows(node.children[i]);
    }
  }

  walk(tree.rootNode);
  extractArrows(tree.rootNode);

  return { functions, calls };
}

// ─── Edge building ──────────────────────────────────────────────

function buildEdges(filePath, functions, calls) {
  const localNames = new Set(functions.map((f) => f.name));
  const edges = [];

  for (const call of calls) {
    // Direct match: call name matches a function defined in this file
    if (localNames.has(call.name)) {
      edges.push({ caller_name: call.name, caller_line: call.start + 1, target_name: call.name });
    }

    // Dotted method call: foo.bar() → look for "bar" as local method
    const parts = call.name.split(".");
    if (parts.length > 1) {
      const methodName = parts[parts.length - 1];
      if (localNames.has(methodName)) {
        edges.push({ caller_name: call.name, caller_line: call.start + 1, target_name: methodName });
      }
    }

    // Arrow method call: $obj->method() or self::method() — PHP style
    if (localNames.has(call.name)) {
      // Already covered above for direct matches
    }
  }

  return edges;
}

// ─── Qdrant upsert helpers ──────────────────────────────────────

const DUMMY_VECTOR = [0];

async function clearCollection(name) {
  const countResult = await qdrant.count(name);
  if (countResult.count > 0) {
    // Delete all by using a filter that matches any payload value
    await qdrant.delete(name, {
      wait: true,
      filter: {},
    });
    console.log("[clear] removed %d existing points from %s", countResult.count, name);
  }
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const targetDir = process.argv[2];
  const scanRoot = targetDir ? path.resolve(targetDir) : ROOT_DIR;

  console.log("=== Build Graph Index ===");
  console.log("[root] %s", scanRoot);

  if (targetDir) {
    try {
      await fs.access(scanRoot);
    } catch {
      console.error("Error: directory not found — %s", scanRoot);
      process.exit(1);
    }
  }

  const extSet = new Set(["js", "ts", "php"]);
  const files = await scanFiles(scanRoot, extSet);
  console.log("[scan] found %d files\n", files.length);

  let totalNodes = 0;
  let totalEdges = 0;
  let processed = 0;
  let failed = 0;

  // Collect all points in memory before upsert
  const nodePoints = [];
  const edgePoints = [];

  for (const filePath of files) {
    try {
      const relPath = path.relative(scanRoot, filePath);
      const ext = path.extname(filePath).slice(1);
      const sourceCode = await fs.readFile(filePath, "utf-8");

      let result;
      if (ext === "js") {
        result = extractFromJS(sourceCode);
      } else if (ext === "ts") {
        result = extractFromTSRegex(sourceCode);
      } else if (ext === "php") {
        result = extractFromPHPRegex(sourceCode);
      } else {
        continue;
      }

      const { functions, calls } = result;

      // Upsert function nodes
      for (const fn of functions) {
        nodePoints.push({
          id: crypto.randomUUID(),
          vector: DUMMY_VECTOR,
          payload: {
            name: fn.name,
            file: relPath,
            line: fn.start + 1,
            kind: "function",
            lang: ext,
          },
        });
      }

      // Build edges (intra-file calls)
      const edges = buildEdges(filePath, functions, calls);
      for (const edge of edges) {
        edgePoints.push({
          id: crypto.randomUUID(),
          vector: DUMMY_VECTOR,
          payload: {
            source_file: relPath,
            caller_name: edge.caller_name,
            caller_line: edge.caller_line,
            target_name: edge.target_name,
          },
        });
      }

      processed++;
      totalNodes += functions.length;
      totalEdges += edges.length;

      if (processed % 50 === 0) {
        console.log("  → processed %d files (%d nodes, %d edges so far)", processed, totalNodes, totalEdges);
      }
    } catch (err) {
      failed++;
      console.error("  ✗ %s — %s", path.relative(scanRoot, filePath), err.message);
    }
  }

  // Batch upsert to Qdrant
  if (nodePoints.length > 0) {
    await clearCollection("graph_nodes");
    const chunkSize = 500;
    for (let i = 0; i < nodePoints.length; i += chunkSize) {
      const chunk = nodePoints.slice(i, i + chunkSize);
      await qdrant.upsert("graph_nodes", { points: chunk, wait: true });
    }
    console.log("[upsert] %d nodes to graph_nodes", nodePoints.length);
  }

  if (edgePoints.length > 0) {
    await clearCollection("graph_edges");
    const chunkSize = 500;
    for (let i = 0; i < edgePoints.length; i += chunkSize) {
      const chunk = edgePoints.slice(i, i + chunkSize);
      await qdrant.upsert("graph_edges", { points: chunk, wait: true });
    }
    console.log("[upsert] %d edges to graph_edges", edgePoints.length);
  }

  console.log("\n=== Summary ===");
  console.log("  Files processed: %d", processed);
  console.log("  Files failed: %d", failed);
  console.log("  Function nodes: %d", totalNodes);
  console.log("  Call edges: %d", totalEdges);
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
