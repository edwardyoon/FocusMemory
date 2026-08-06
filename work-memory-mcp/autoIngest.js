import dotenv from "dotenv";
dotenv.config({ override: true }); // .env 최우선 — settings.json env 변수 오버라이드;
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { qdrant, embed, chunkDocument, deletePointsByDoc, DOCS_SYSTEM_PROMPT, PLANS_SYSTEM_PROMPT } from "./utils.js";

const STATE_FILE = path.join(process.cwd(), "ingest_state.json");
const DOCS_DIR = process.env.DOCS_DIR || path.join(process.cwd(), "..", "docs");
const PLANS_DIR_ROOT = process.env.PLANS_DIR || path.join(process.cwd(), "..", "plans");

// ─── State management ───────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { last_run: null, files: {} };
  }
}

async function saveState(state) {
  state.last_run = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function getFileKey(filePath, type) {
  // Normalized key: relative path from root (docs/ or plans/)
  return `${type}:${path.relative(type === "docs" ? DOCS_DIR : PLANS_DIR_ROOT, filePath)}`;
}

// ─── File scanning ──────────────────────────────────────────────────

async function scanDir(dir, pattern = "*.md") {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g., plans/done/, docs/ui-design/)
        const subFiles = await scanDir(fullPath, pattern);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    console.error(`[scan] directory not found: ${dir}`);
  }
  return files;
}

async function getFileMtime(filePath) {
  const stat = await fs.stat(filePath);
  return stat.mtime.toISOString();
}

// ─── Ingest logic (single file) ─────────────────────────────────────

async function ingestDocFile(filePath) {
  const fileName = path.basename(filePath);
  const docText = await fs.readFile(filePath, "utf-8");

  console.log(`[docs] Processing: ${fileName} (${docText.length} chars)`);

  await deletePointsByDoc("project_facts", fileName);
  console.log(`  → deleted existing points for '${fileName}'`);

  const chunks = await chunkDocument(docText, DOCS_SYSTEM_PROMPT);
  if (chunks.length === 0) {
    console.log("  → no chunks extracted, skipped\n");
    return false;
  }
  console.log(`  → extracted ${chunks.length} chunks`);

  const points = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const vector = await embed(chunk.content);
    if (!vector) {
      console.error(`    [skip] embedding failed for chunk ${i}`);
      continue;
    }
    points.push({
      id: crypto.randomUUID(),
      vector,
      payload: {
        content: chunk.content,
        section_title: chunk.section_title || "",
        tags: chunk.tags || [],
        source_doc: fileName,
        ingested_at: new Date().toISOString(),
      },
    });
  }

  if (points.length > 0) {
    await qdrant.upsert("project_facts", { points });
    console.log(`  → saved ${points.length} points to project_facts\n`);
  } else {
    console.log("  → no points saved, skipped\n");
  }

  return true;
}

function extractFilePaths(text) {
  const patterns = [
    /[`']([^`\']*\.js)[`']/g,
    /[`']([^`\']*\.php)[`']/g,
    /[`']([^`\']*\.css)[`']/g,
    /[`']([^`\']*\.html)[`']/g,
  ];
  const files = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      files.add(match[1]);
    }
  }
  return [...files];
}

async function ingestPlanFile(filePath) {
  const fileName = path.basename(filePath);
  const docText = await fs.readFile(filePath, "utf-8");
  const isDone = filePath.includes("/done/");
  const sourceDoc = `${isDone ? 'done/' : ''}${fileName}`;

  console.log(`[plans] Processing: ${sourceDoc} (${docText.length} chars)`);

  await deletePointsByDoc("work_memory", sourceDoc);
  console.log(`  → deleted existing points for '${sourceDoc}'`);

  const chunks = await chunkDocument(docText, PLANS_SYSTEM_PROMPT);
  if (chunks.length === 0) {
    console.log("  → no chunks extracted, skipped\n");
    return false;
  }
  console.log(`  → extracted ${chunks.length} chunks`);

  const points = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const vector = await embed(chunk.content);
    if (!vector) {
      console.error(`    [skip] embedding failed for chunk ${i}`);
      continue;
    }

    const relatedFiles = extractFilePaths(docText);
    points.push({
      id: crypto.randomUUID(),
      vector,
      payload: {
        type: "decision",
        project: "",
        summary_text: chunk.section_title || fileName,
        detail: chunk.content,
        related_files: relatedFiles,
        status: isDone ? "resolved" : "open",
        source_doc: sourceDoc,
        timestamp: new Date().toISOString(),
      },
    });
  }

  if (points.length > 0) {
    await qdrant.upsert("work_memory", { points });
    console.log(`  → saved ${points.length} points to work_memory\n`);
  } else {
    console.log("  → no points saved, skipped\n");
  }

  return true;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const forceAll = process.argv.includes("--force") || process.argv.includes("-f");
  const docsOnly = process.argv.includes("--docs-only");
  const plansOnly = process.argv.includes("--plans-only");

  console.log("=== Auto Ingest ===");
  if (forceAll) console.log("[mode] FORCE: re-ingesting all files\n");

  const state = await loadState();
  const previousRun = state.last_run || "never";
  console.log(`[state] last run: ${previousRun}`);
  console.log(`[state] tracked files: ${Object.keys(state.files).length}\n`);

  let totalNew = 0, totalModified = 0, totalUnchanged = 0;
  let successCount = 0, failCount = 0;
  const currentFiles = new Set();

  // ── Scan docs/ ────────────────────────────────────────────────
  if (!plansOnly) {
    console.log("--- Scanning docs/ ---");
    const docFiles = await scanDir(DOCS_DIR);

    for (const filePath of docFiles) {
      const fileKey = getFileKey(filePath, "docs");
      currentFiles.add(fileKey);
      const mtime = await getFileMtime(filePath);
      const prev = state.files[fileKey];

      if (!prev) {
        console.log(`  [new] ${path.basename(filePath)}`);
        totalNew++;
      } else if (forceAll || new Date(mtime) > new Date(prev.mtime)) {
        console.log(`  [modified] ${path.basename(filePath)} (mtime: ${mtime})`);
        totalModified++;
      } else {
        continue; // unchanged
      }

      try {
        const ok = await ingestDocFile(filePath);
        if (ok) {
          state.files[fileKey] = { mtime, ingested_at: new Date().toISOString(), type: "docs" };
          successCount++;
        } else {
          failCount++;
        }
      } catch (err) {
        console.error(`  ✗ failed: ${path.basename(filePath)} — ${err.message}\n`);
        failCount++;
      }
    }

    if (!docFiles.length) {
      console.log("  (no .md files found)\n");
    } else {
      console.log(`  Found ${docFiles.length} docs files\n`);
    }
  }

  // ── Scan plans/ ───────────────────────────────────────────────
  if (!docsOnly) {
    console.log("--- Scanning plans/ ---");
    const planFiles = await scanDir(PLANS_DIR_ROOT);

    for (const filePath of planFiles) {
      const fileKey = getFileKey(filePath, "plans");
      currentFiles.add(fileKey);
      const mtime = await getFileMtime(filePath);
      const prev = state.files[fileKey];

      if (!prev) {
        console.log(`  [new] ${path.relative(PLANS_DIR_ROOT, filePath)}`);
        totalNew++;
      } else if (forceAll || new Date(mtime) > new Date(prev.mtime)) {
        console.log(`  [modified] ${path.relative(PLANS_DIR_ROOT, filePath)} (mtime: ${mtime})`);
        totalModified++;
      } else {
        continue; // unchanged
      }

      try {
        const ok = await ingestPlanFile(filePath);
        if (ok) {
          state.files[fileKey] = { mtime, ingested_at: new Date().toISOString(), type: "plans" };
          successCount++;
        } else {
          failCount++;
        }
      } catch (err) {
        console.error(`  ✗ failed: ${path.relative(PLANS_DIR_ROOT, filePath)} — ${err.message}\n`);
        failCount++;
      }
    }

    if (!planFiles.length) {
      console.log("  (no .md files found)\n");
    } else {
      console.log(`  Found ${planFiles.length} plan files\n`);
    }
  }

  // ── Detect deleted files ──────────────────────────────────────
  const deletedKeys = [];
  for (const key of Object.keys(state.files)) {
    if (!currentFiles.has(key)) {
      deletedKeys.push(key);
    }
  }
  if (deletedKeys.length) {
    console.log(`--- Removed ${deletedKeys.length} deleted file entries ---`);
    for (const key of deletedKeys) {
      console.log(`  [removed] ${key}`);
      delete state.files[key];
    }
    console.log("");
  }

  // ── Code chunk indexing (incremental, unless --force) ─────────
  console.log("--- Indexing code chunks ---");

  const indexScript = path.join(path.dirname(new URL(import.meta.url).pathname), "semantic_codesearch", "indexCodeChunks.js");
  const codeArgs = [indexScript];
  if (process.env.GRAPH_ROOT) {
    codeArgs.push(process.env.GRAPH_ROOT);
  }
  if (forceAll) {
    codeArgs.push("--force");
  }

  await new Promise((resolve, reject) => {
    const child = spawn("node", codeArgs, {
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`indexCodeChunks exited with code ${code}`));
    });
    child.on("error", reject);
  });

  console.log("");

  // ── Summary ───────────────────────────────────────────────────
  totalUnchanged = Object.keys(state.files).filter(k => currentFiles.has(k)).length - totalModified;
  if (totalUnchanged < 0) totalUnchanged = 0;

  console.log("=== Summary ===");
  console.log(`  New files: ${totalNew}`);
  console.log(`  Modified files: ${totalModified}`);
  console.log(`  Unchanged skipped: ${totalUnchanged}`);
  console.log(`  Successful ingests: ${successCount}`);
  console.log(`  Failed ingests: ${failCount}`);

  if (forceAll || totalNew > 0 || totalModified > 0) {
    await saveState(state);
    console.log(`\n[state] saved to ${STATE_FILE}`);
  } else {
    console.log("\n[noop] nothing changed, state file untouched");
  }

  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
