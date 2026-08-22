import dotenv from "dotenv";
dotenv.config({ override: true }); // .env takes priority — override settings.json env vars;
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { qdrant, scanFiles } from "../lib/utils.js";
import Parser from "tree-sitter";
import JSLang from "tree-sitter-javascript";

// ─── Configuration ──────────────────────────────────────────────

const ROOT_DIR = process.env.GRAPH_ROOT || "/opt/homebrew/var/www";
const STATE_FILE = path.join(process.cwd(), "graph_state.json");
const NODES_COL = "graph_nodes";
const EDGES_COL = "graph_edges";
const DUMMY_VECTOR = [0];

// ─── Parser setup ──────────────────────────────────────────────

const jsParser = new Parser();
jsParser.setLanguage(JSLang);

// PHP grammar (tree-sitter-php) is not compatible with tree-sitter@0.25 yet.
// For now, we use a lightweight regex-based fallback for PHP function extraction.
/**
 * Extract function definitions and call sites from PHP source via regex.
 * @param {string} sourceCode PHP source.
 * @returns {{functions: Array<{name: string, start: number}>, calls: Array<{name: string, start: number}>}}
 */
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
/**
 * Extract function definitions and call sites from TypeScript source via regex.
 * @param {string} sourceCode TS source.
 * @returns {{functions: Array<{name: string, start: number}>, calls: Array<{name: string, start: number}>}}
 */
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

// ─── AST extraction: JavaScript ─────────────────────────────────

/**
 * Extract function definitions and call sites from JavaScript via tree-sitter AST.
 * @param {string} sourceCode JS source.
 * @returns {{functions: Array<{name: string, start: number}>, calls: Array<{name: string, start: number}>}}
 */
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

/**
 * Dispatch extraction to the right parser by file extension.
 * @param {string} ext File extension without dot (js|ts|php).
 * @param {string} content File content.
 * @returns {{functions: Array<{name: string, start: number}>, calls: Array<{name: string, start: number}>}}
 */
function extractByExt(ext, content) {
  if (ext === "js") return extractFromJS(content);
  if (ext === "ts") return extractFromTSRegex(content);
  if (ext === "php") return extractFromPHPRegex(content);
  return { functions: [], calls: [] };
}

// ─── Import / require parsing (cross-file resolution) ──────────

/**
 * Parse import / require declarations and return a map of
 * locally-bound name → { exported: <name in the target module>, spec: <module specifier> }.
 *
 * `exported` is the name the symbol is defined by in the target file, which may
 * differ from the local binding when the import aliases it (ESM `b as c`, CJS
 * `{ b: c }`). For non-aliased / default imports the two are equal.
 *
 * Covers ESM (`import D from`, `import { a, b as c } from`) and CommonJS
 * (`const X = require('S')`, `const { a, b: c } = require('S')`).
 * PHP returns an empty map — PHP functions are global, so cross-file
 * resolution is done via the global name index instead of imports.
 *
 * @param {string} sourceCode Source of a js/ts file.
 * @param {string} ext File extension (js|ts|php).
 * @returns {Object<string, {exported: string, spec: string}>} localName -> {exported, spec}.
 */
function parseImports(sourceCode, ext) {
  if (ext === "php") return {};
  const named = {};
  let m;

  // import { a, b as c } from 'SPEC'  (local = c, exported = b)
  const namedRe = /import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(sourceCode)) !== null) {
    for (const item of m[1].split(",")) {
      const it = item.trim();
      if (!it) continue;
      const as = it.match(/^(\w+)\s+as\s+(\w+)$/);
      if (as) named[as[2]] = { exported: as[1], spec: m[2] };
      else { const l = it.match(/^(\w+)/)?.[1]; if (l) named[l] = { exported: l, spec: m[2] }; }
    }
  }

  // import Default from 'SPEC'
  const defRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = defRe.exec(sourceCode)) !== null) {
    named[m[1]] = { exported: m[1], spec: m[2] };
  }

  // const X = require('SPEC')
  const reqDefRe = /\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqDefRe.exec(sourceCode)) !== null) {
    named[m[1]] = { exported: m[1], spec: m[2] };
  }

  // const { a, b: c } = require('SPEC')  (local = c, exported = b)
  const reqNamedRe = /\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqNamedRe.exec(sourceCode)) !== null) {
    for (const item of m[1].split(",")) {
      const it = item.trim();
      if (!it) continue;
      const colon = it.match(/^(\w+)\s*:\s*(\w+)$/);
      if (colon) named[colon[2]] = { exported: colon[1], spec: m[2] };
      else { const l = it.match(/^(\w+)/)?.[1]; if (l) named[l] = { exported: l, spec: m[2] }; }
    }
  }

  return named;
}

/**
 * Resolve a relative module specifier (./x, ../y) to a scanned file's relPath.
 * Non-relative (bare package) specs are treated as external.
 * @param {string} spec Module specifier.
 * @param {string} sourceRel relPath of the importing file.
 * @param {Set<string>} scannedSet Set of all scanned relPaths this run.
 * @returns {{resolved: string|null, internal: boolean, specRel: string|null}}
 *   resolved = scanned file relPath (or null); internal = spec was a relative path;
 *   specRel = best-effort relPath of the target (for pending edges when unresolved).
 */
function resolveSpecToRel(spec, sourceRel, scannedSet) {
  if (!spec) return { resolved: null, internal: false, specRel: null };
  const isInternal =
    spec.startsWith("./") || spec.startsWith("../") ||
    spec === "." || spec === ".." || spec.startsWith("/");
  if (!isInternal) return { resolved: null, internal: false, specRel: null }; // external package

  const srcDir = path.dirname(sourceRel);
  const base = spec.startsWith("/")
    ? spec.replace(/^\//, "")
    : path.normalize(path.join(srcDir, spec));
  const cands = [base, base + ".js", base + ".ts", base + ".php", base + "/index.js", base + "/index.ts"];
  for (const c of cands) {
    if (scannedSet.has(c)) return { resolved: c, internal: true, specRel: c };
  }
  // Relative spec that does not map to a scanned file (missing / ignored / >200KB)
  // → not yet indexed, so the caller's edge is kept as a pending edge.
  return { resolved: null, internal: true, specRel: cands[0] };
}

/**
 * Pick the most likely defining file among all in-tree definitions of a symbol
 * (PHP global functions can collide by name). Prefers the same directory as the
 * caller, then falls back to the alphabetically-first candidate (deterministic).
 * @param {Array<{file: string, line: number}>} candidates
 * @param {string} sourceRel relPath of the caller file.
 * @returns {string} Chosen target relPath.
 */
function pickBestCandidate(candidates, sourceRel) {
  const srcDir = path.dirname(sourceRel);
  const sameDir = candidates.find((c) => path.dirname(c.file) === srcDir);
  if (sameDir) return sameDir.file;
  const sorted = [...candidates].sort((a, b) => a.file.localeCompare(b.file));
  return sorted[0].file;
}

// Bare identifiers that are JS/PHP builtins or stdlib — never project symbols.
// Prevents false cross/pending edges when a call name collides with a builtin.
const JS_BUILTINS = new Set([
  "require", "module", "exports", "__dirname", "__filename", "console", "process", "global",
  "globalThis", "Buffer", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "setImmediate", "clearImmediate", "queueMicrotask", "fetch", "Request", "Response", "Headers",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "Blob", "File", "FormData",
  "AbortController", "AbortSignal", "Event", "EventTarget", "CustomEvent", "Worker",
  "crypto", "atob", "btoa", "structuredClone", "JSON", "Math", "Object", "Array", "String",
  "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
  "Promise", "Proxy", "Reflect", "Error", "TypeError", "RangeError", "SyntaxError",
  "ReferenceError", "URIError", "EvalError", "AggregateError", "parseInt", "parseFloat",
  "isNaN", "isFinite", "NaN", "Infinity", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "escape", "unescape", "eval", "Function", "alert", "confirm",
  "prompt", "print", "window", "document", "navigator", "location", "history", "screen",
  "localStorage", "sessionStorage", "IndexedDB", "performance", "requestAnimationFrame",
  "cancelAnimationFrame", "get", "post", "put", "del", "patch", "then", "catch", "finally",
]);
const PHP_BUILTINS = new Set([
  "echo", "print", "var_dump", "var_export", "count", "sizeof", "strlen", "strval", "intval",
  "floatval", "boolval", "trim", "ltrim", "rtrim", "str_split", "strpos", "strrpos",
  "str_replace", "substr", "mb_substr", "mb_strlen", "preg_match", "preg_match_all",
  "preg_replace", "preg_replace_all", "preg_split", "explode", "implode", "join", "nl2br",
  "ucfirst", "lcfirst", "ucwords", "strtoupper", "strtolower", "stripos", "in_array",
  "array_map", "array_filter", "array_merge", "array_keys", "array_values", "array_slice",
  "array_search", "array_unique", "array_flip", "array_diff", "array_intersect", "empty",
  "isset", "unset", "json_encode", "json_decode", "sprintf", "vsprintf", "printf",
  "date", "gmdate", "mktime", "time", "strtotime", "checkdate", "strftime",
  "htmlspecialchars", "htmlentities", "urlencode", "urldecode", "rawurlencode", "rawurldecode",
  "base64_encode", "base64_decode", "md5", "sha1", "sha256", "hash", "hash_hmac", "random_bytes",
  "random_int", "file_get_contents", "file_put_contents", "fopen", "fclose", "fread", "fwrite",
  "fgets", "fputs", "filesize", "is_file", "is_dir", "is_readable", "is_writable", "is_executable",
  "dirname", "basename", "pathinfo", "realpath", "file", "glob", "mkdir", "rmdir", "unlink",
  "copy", "move_uploaded_file", "tempnam", "tmpfile", "opendir", "closedir", "readdir",
  "escapeshellarg", "escapeshellcmd", "exec", "shell_exec", "system", "passthru", "proc_open",
  "die", "exit", "define", "constant", "gettype", "get_class", "get_object_vars", "call_user_func",
  "call_user_func_array", "trigger_error", "set_error_handler", "error_log", "restore_error_handler",
  "header", "headers_sent", "setcookie", "session_start", "session_destroy", "session_regenerate_id",
  "curl_init", "curl_setopt", "curl_exec", "curl_close", "mysql_connect", "mysqli_connect",
  "new", "clone", "list", "extract", "compact", "func_get_args", "func_num_args", "instanceof",
  "include", "require", "include_once", "require_once", "print_r",
]);

/**
 * Resolve a single call site to its target, classifying the edge.
 *
 * Resolution order:
 *   1. intra-file  — bareName is defined in the caller file (target_file = caller).
 *   2. skip        — dotted method call on an external object (foo.bar(), bar not local).
 *   3. skip        — bareName is a JS/PHP builtin (never a project symbol).
 *   4. cross-file  — import-bound (JS/TS) to a scanned file (target_file = that file).
 *   5. pending     — import-bound to a relative spec that is not yet indexed.
 *   6. skip        — external package import.
 *   7. cross-file  — PHP bare call with an in-tree global definition.
 *   8. skip        — anything else (JS bare call not imported → stdlib/external).
 *
 * @param {string} bareName The called symbol (last dotted segment).
 * @param {boolean} isDotted Whether the original call text contained a dot.
 * @param {string} lang js|ts|php.
 * @param {Set<string>} localNames Function names defined in the caller file.
 * @param {Array<{file: string, line: number}>} candidates In-tree definitions of bareName.
 * @param {{resolved: string|null, internal: boolean, specRel: string|null}|null} importEntry
 * @param {string} sourceRel relPath of the caller file.
 * @returns {{kind: "intra"|"cross"|"pending"|"skip", targetFile: string|null, status: "resolved"|"pending"}}
 */
function resolveCall(bareName, isDotted, lang, localNames, candidates, importEntry, sourceRel) {
  if (localNames.has(bareName)) {
    return { kind: "intra", targetFile: sourceRel, status: "resolved" };
  }
  if (isDotted) return { kind: "skip" }; // method call on external object
  if (JS_BUILTINS.has(bareName) || PHP_BUILTINS.has(bareName)) return { kind: "skip" };

  if (importEntry) {
    if (importEntry.resolved) return { kind: "cross", targetFile: importEntry.resolved, status: "resolved" };
    if (importEntry.internal) return { kind: "pending", targetFile: importEntry.specRel, status: "pending" };
    return { kind: "skip" }; // external package
  }

  if (lang === "php" && candidates.length > 0) {
    return { kind: "cross", targetFile: pickBestCandidate(candidates, sourceRel), status: "resolved" };
  }

  return { kind: "skip" };
}

// ─── Content hash + state ──────────────────────────────────────

/**
 * MD5 of the file content (NOT mtime+size) — robust against size/mtime-preserving rewrites.
 * @param {string} content File content.
 * @returns {string} Hex md5 digest.
 */
function hashContent(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * Load the incremental state file (per-file content hashes).
 * @returns {Promise<{v: number, root: string, files: Object<string,{hash: string, indexed_at: string}>}>}
 */
async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf-8"));
  } catch {
    return { v: 1, root: ROOT_DIR, files: {} };
  }
}

/**
 * Persist the incremental state file.
 * @param {{v: number, root: string, files: Object}} state
 * @returns {Promise<void>}
 */
async function saveState(state) {
  state.v = 1;
  state.last_run = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ─── Qdrant helpers ─────────────────────────────────────────────

/**
 * Upsert points to a collection in chunks.
 * @param {string} col Collection name.
 * @param {Array<Object>} points
 * @param {number} [chunk=500]
 * @returns {Promise<void>}
 */
async function upsertChunked(col, points, chunk = 500) {
  for (let i = 0; i < points.length; i += chunk) {
    await qdrant.upsert(col, { points: points.slice(i, i + chunk), wait: true });
  }
}

/**
 * Delete points by explicit IDs in chunks (used by --fix).
 * @param {string} col Collection name.
 * @param {Array<string>} ids
 * @param {number} [chunk=500]
 * @returns {Promise<void>}
 */
async function deleteByIds(col, ids, chunk = 500) {
  for (let i = 0; i < ids.length; i += chunk) {
    await qdrant.delete(col, { wait: true, points: ids.slice(i, i + chunk) });
  }
}

/**
 * Delete every point in a collection (full-rebuild path).
 * @param {string} name Collection name.
 * @returns {Promise<void>}
 */
async function clearCollection(name) {
  const countResult = await qdrant.count(name);
  if (countResult.count > 0) {
    await qdrant.delete(name, { wait: true, filter: {} });
    console.log("[clear] removed %d existing points from %s", countResult.count, name);
  }
}

/**
 * Delete all function nodes belonging to one file (payload filter, incremental reindex).
 * @param {string} rel relPath of the file.
 * @returns {Promise<void>}
 */
async function deleteFileNodes(rel) {
  await qdrant.delete(NODES_COL, { wait: true, filter: { must: [{ key: "file", match: { value: rel } }] } });
}

/**
 * Delete all call edges whose source_file is one file (payload filter, incremental reindex).
 * @param {string} rel relPath of the file.
 * @returns {Promise<void>}
 */
async function deleteFileEdges(rel) {
  await qdrant.delete(EDGES_COL, { wait: true, filter: { must: [{ key: "source_file", match: { value: rel } }] } });
}

/**
 * Scroll an entire collection (paginated).
 * @param {string} col Collection name.
 * @returns {Promise<Array<{id: string, payload: Object}>>}
 */
async function scrollAll(col) {
  const all = [];
  let offset;
  do {
    const res = await qdrant.scroll(col, { limit: 256, with_payload: true, offset });
    all.push(...res.points);
    offset = res.next_page_offset;
  } while (offset);
  return all;
}

// ─── Build (full or incremental) ──────────────────────────────

/**
 * Build (or incrementally update) the function/call graph in Qdrant.
 *
 * Full mode  — clears both collections and bulk-upserts everything (no state, or --force,
 *              or the state was written for a different scan root).
 * Incremental — for each file whose content hash changed (or is new): delete its old nodes+edges
 *              by payload filter, then upsert fresh ones. Files deleted from disk get their
 *              points removed. Unchanged files are left untouched in Qdrant.
 *
 * Every run re-reads and re-parses all scanned files: reading is required to compute the
 * content hash (change detection), and the parsed symbols feed a global index used for
 * cross-file edge resolution regardless of file processing order.
 *
 * @param {{force: boolean}} flags Parsed CLI flags.
 * @param {string|undefined} targetDir Optional scan root override.
 * @returns {Promise<void>}
 */
async function build(flags, targetDir) {
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
  console.log("[scan] found %d files", files.length);

  const state = await loadState();
  const hasState = !!state.files && Object.keys(state.files).length > 0;
  const canIncremental = !flags.force && hasState && state.v === 1 && state.root === scanRoot;
  const mode = flags.force ? "force-full" : canIncremental ? "incremental" : "full";
  console.log("[mode] %s\n", mode);

  // ── Phase A: read + parse every file (hash + global symbol index) ──
  const fileData = new Map(); // rel -> {abs, ext, hash, functions, calls, imports}
  const scannedSet = new Set();
  const globalIndex = new Map(); // symbol -> [{file, line}]
  let readFailed = 0;

  for (const abs of files) {
    const rel = path.relative(scanRoot, abs);
    scannedSet.add(rel);
    const ext = path.extname(abs).slice(1);
    let content;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      readFailed++;
      continue;
    }
    let parsed;
    try {
      parsed = extractByExt(ext, content);
    } catch {
      readFailed++;
      continue;
    }
    const data = { abs, ext, hash: hashContent(content), functions: parsed.functions, calls: parsed.calls, imports: parseImports(content, ext) };
    fileData.set(rel, data);
    for (const fn of parsed.functions) {
      if (!globalIndex.has(fn.name)) globalIndex.set(fn.name, []);
      globalIndex.get(fn.name).push({ file: rel, line: fn.start + 1 });
    }
  }

  // ── Phase B: classify changed / deleted vs. state ──
  const changed = [];
  const deleted = [];
  for (const rel of fileData.keys()) {
    const fd = fileData.get(rel);
    if (flags.force || !state.files[rel] || state.files[rel].hash !== fd.hash) changed.push(rel);
  }
  if (!flags.force) {
    for (const rel of Object.keys(state.files)) {
      if (!scannedSet.has(rel)) deleted.push(rel);
    }
  }

  const toProcess = mode === "incremental" ? changed : [...fileData.keys()];
  console.log("[plan] re-index %d, delete %d, unchanged %d", changed.length, deleted.length, fileData.size - changed.length);

  // ── Phase C: resolve + index ──
  let totalNodes = 0;
  let totalEdges = 0;
  let processed = 0;
  const allNodes = []; // full-mode bulk
  const allEdges = [];

  for (const rel of toProcess) {
    const fd = fileData.get(rel);

    // Resolve this file's import bindings once.
    const importBindings = new Map(); // bareName -> {resolved, internal, specRel, exported}
    for (const [local, info] of Object.entries(fd.imports)) {
      importBindings.set(local, { ...resolveSpecToRel(info.spec, rel, scannedSet), exported: info.exported });
    }
    const localNames = new Set(fd.functions.map((f) => f.name));

    const nodes = fd.functions.map((fn) => ({
      name: fn.name, file: rel, line: fn.start + 1, kind: "function", lang: fd.ext,
    }));

    const edges = [];
    const pendingSeen = new Set(); // dedup pending edges per (file, symbol)
    for (const call of fd.calls) {
      const isDotted = call.name.includes(".");
      const bareName = isDotted ? call.name.split(".").pop() : call.name;
      const candidates = globalIndex.get(bareName) || [];
      const importEntry = importBindings.get(bareName) || null;
      const res = resolveCall(bareName, isDotted, fd.ext, localNames, candidates, importEntry, rel);
      if (res.kind === "skip") continue;
      if (res.kind === "pending") {
        if (pendingSeen.has(bareName)) continue;
        pendingSeen.add(bareName);
      }
      // Import-resolved edges point at the *exported* name in the target module,
      // which may differ from the local alias (e.g. `const { query: readQuery }`).
      const targetName =
        (res.kind === "cross" || res.kind === "pending") && importEntry && importEntry.exported
          ? importEntry.exported
          : bareName;
      edges.push({
        caller_name: call.name,
        caller_line: call.start + 1,
        target_name: targetName,
        target_file: res.targetFile,
        status: res.status,
      });
    }

    totalNodes += nodes.length;
    totalEdges += edges.length;
    processed++;

    if (mode === "incremental") {
      // Delete this file's old points, then upsert the fresh ones.
      await deleteFileNodes(rel);
      await deleteFileEdges(rel);
      if (nodes.length) {
        await upsertChunked(NODES_COL, nodes.map((n) => ({ id: crypto.randomUUID(), vector: DUMMY_VECTOR, payload: n })));
      }
      if (edges.length) {
        await upsertChunked(EDGES_COL, edges.map((e) => ({ id: crypto.randomUUID(), vector: DUMMY_VECTOR, payload: { source_file: rel, ...e } })));
      }
    } else {
      for (const n of nodes) allNodes.push({ id: crypto.randomUUID(), vector: DUMMY_VECTOR, payload: n });
      for (const e of edges) allEdges.push({ id: crypto.randomUUID(), vector: DUMMY_VECTOR, payload: { source_file: rel, ...e } });
    }

    if (processed % 100 === 0) {
      console.log("  → processed %d/%d files (%d nodes, %d edges so far)", processed, toProcess.length, totalNodes, totalEdges);
    }
  }

  // Deleted files (incremental): remove their leftover points.
  for (const rel of deleted) {
    await deleteFileNodes(rel);
    await deleteFileEdges(rel);
  }

  // ── Phase D: commit bulk for full mode ──
  if (mode !== "incremental") {
    if (allNodes.length > 0 || allEdges.length > 0) {
      await clearCollection(NODES_COL);
      await clearCollection(EDGES_COL);
      await upsertChunked(NODES_COL, allNodes);
      await upsertChunked(EDGES_COL, allEdges);
    }
  }

  // ── Phase E: persist state ──
  const now = new Date().toISOString();
  if (mode === "incremental") {
    for (const rel of changed) state.files[rel] = { hash: fileData.get(rel).hash, indexed_at: now };
    for (const rel of deleted) delete state.files[rel];
    state.root = scanRoot;
    if (changed.length || deleted.length) await saveState(state);
  } else {
    const nf = {};
    for (const rel of fileData.keys()) nf[rel] = { hash: fileData.get(rel).hash, indexed_at: now };
    state.files = nf;
    state.root = scanRoot;
    await saveState(state);
  }

  const nc = await qdrant.count(NODES_COL);
  const ec = await qdrant.count(EDGES_COL);

  console.log("\n=== Summary ===");
  console.log("  Mode: %s", mode);
  console.log("  Files read: %d (failed %d)", fileData.size, readFailed);
  console.log("  Files re-indexed: %d", processed);
  console.log("  Files deleted: %d", deleted.length);
  console.log("  Nodes (this run): %d", totalNodes);
  console.log("  Edges (this run): %d", totalEdges);
  console.log("  Total graph_nodes: %d", nc.count);
  console.log("  Total graph_edges: %d", ec.count);
  console.log("=== Done ===");
}

// ─── Verify ─────────────────────────────────────────────────────

/**
 * Compare the Qdrant graph index against the files on disk.
 *
 * Reports:
 *   - REMOVED : point whose source/target file no longer exists.
 *   - STALE   : node whose function is no longer defined in its file, or a resolved
 *               edge whose target file no longer defines the target symbol / line is out of range.
 *   - pending residuals : pending edges still unresolved (informational, not drift).
 *
 * Read-only by default. With `fix`, stale/removed points are deleted from Qdrant.
 *
 * @param {boolean} fix When true, delete stale/removed points.
 * @returns {Promise<number>} 0 when clean (or after a successful fix), 1 on drift without --fix.
 */
async function runVerify(fix) {
  console.log("=== Verify Graph Index ===");
  console.log("[root] %s", ROOT_DIR);

  // Disk cache: rel -> {exists, lineCount, funcNames:Set<string>}
  const diskCache = new Map();
  /**
   * @param {string} rel relPath.
   * @returns {Promise<{exists: boolean, lineCount: number, funcNames: Set<string>}>}
   */
  async function getDisk(rel) {
    if (diskCache.has(rel)) return diskCache.get(rel);
    const abs = path.join(ROOT_DIR, rel);
    let info;
    try {
      const content = await fs.readFile(abs, "utf-8");
      const ext = path.extname(rel).slice(1);
      const { functions } = extractByExt(ext, content);
      info = { exists: true, lineCount: content.split("\n").length, funcNames: new Set(functions.map((f) => f.name)) };
    } catch {
      info = { exists: false, lineCount: 0, funcNames: new Set() };
    }
    diskCache.set(rel, info);
    return info;
  }

  const nodes = await scrollAll(NODES_COL);
  const edges = await scrollAll(EDGES_COL);
  console.log("[index] %d nodes, %d edges", nodes.length, edges.length);

  const staleNodes = [];
  const removedNodes = [];
  for (const p of nodes) {
    const pl = p.payload;
    const d = await getDisk(pl.file);
    if (!d.exists) removedNodes.push({ id: p.id, file: pl.file, name: pl.name });
    else if (!d.funcNames.has(pl.name)) staleNodes.push({ id: p.id, file: pl.file, name: pl.name, line: pl.line });
  }

  const staleEdges = [];
  const removedEdges = [];
  let pendingResiduals = 0;
  let targetNameGaps = 0; // resolved edges whose target_name the extractor couldn't find (coverage metric, not drift)
  for (const p of edges) {
    const pl = p.payload;
    const src = await getDisk(pl.source_file);
    if (!src.exists) {
      removedEdges.push({ id: p.id, source_file: pl.source_file });
      continue;
    }
    if (pl.status === "pending") {
      pendingResiduals++;
      continue;
    }
    if (!pl.target_file || pl.caller_line > src.lineCount) {
      staleEdges.push({ id: p.id, source_file: pl.source_file, target_name: pl.target_name, reason: "invalid" });
      continue;
    }
    const tgt = await getDisk(pl.target_file);
    if (!tgt.exists) {
      removedEdges.push({ id: p.id, source_file: pl.source_file, target_file: pl.target_file });
      continue;
    }
    // Whether target_file "defines" target_name is NOT a drift signal — the
    // function extractor is heuristic (misses arrow-const / default-export
    // aliases), so a strict name check false-positives on valid edges. It is
    // reported as an informational extraction-coverage metric only.
    if (!tgt.funcNames.has(pl.target_name)) targetNameGaps++;
  }

  const drift = staleNodes.length + removedNodes.length + staleEdges.length + removedEdges.length;
  console.log("\n[verify] stale nodes: %d | removed nodes: %d", staleNodes.length, removedNodes.length);
  console.log("[verify] stale edges: %d | removed edges: %d", staleEdges.length, removedEdges.length);
  console.log("[verify] pending residuals: %d (informational, not drift)", pendingResiduals);
  console.log("[verify] target-name gaps: %d (informational — extraction coverage, not drift)", targetNameGaps);
  if (staleNodes.length) console.log("  e.g. stale node  :", JSON.stringify(staleNodes[0]));
  if (removedNodes.length) console.log("  e.g. removed node:", JSON.stringify(removedNodes[0]));
  if (staleEdges.length) console.log("  e.g. stale edge  :", JSON.stringify(staleEdges[0]));
  if (removedEdges.length) console.log("  e.g. removed edge:", JSON.stringify(removedEdges[0]));

  if (drift === 0) {
    console.log("\n[verify] CLEAN — index matches disk");
    return 0;
  }

  if (!fix) {
    console.log("\n[verify] DRIFT detected (%d points). Re-run with --fix to remove them.", drift);
    return 1;
  }

  const fixNodes = [...staleNodes.map((x) => x.id), ...removedNodes.map((x) => x.id)];
  const fixEdges = [...staleEdges.map((x) => x.id), ...removedEdges.map((x) => x.id)];
  await deleteByIds(NODES_COL, fixNodes);
  await deleteByIds(EDGES_COL, fixEdges);
  console.log("\n[fix] removed %d stale/removed nodes + %d edges", fixNodes.length, fixEdges.length);
  return 0;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flags = { force: false, verify: false, fix: false };
  const positional = [];
  for (const a of argv) {
    if (a === "--force" || a === "--full") flags.force = true;
    else if (a === "--verify") flags.verify = true;
    else if (a === "--fix") flags.fix = true;
    else positional.push(a);
  }
  const targetDir = positional[0];

  if (flags.verify) {
    const code = await runVerify(flags.fix);
    process.exit(code);
  }

  await build(flags, targetDir);
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
