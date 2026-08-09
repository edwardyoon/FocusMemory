import dotenv from "dotenv";
dotenv.config({ override: true }); // .env takes priority — override settings.json env vars;
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { Meilisearch } from "meilisearch";

const STATE_FILE = path.join(process.cwd(), "ingest_state.json");
const DOCS_DIR = process.env.DOCS_DIR || path.join(process.cwd(), "..", "docs");
const PLANS_DIR_ROOT = process.env.PLANS_DIR || path.join(process.cwd(), "..", "plans");
const ROOT = path.resolve(DOCS_DIR, ".."); // project root

// ─── Meilisearch client ────────────────────────────────────────────

const meiliClient = new Meilisearch({
  host: process.env.MEILI_HOST || "http://localhost:7700",
  apiKey: process.env.MEILI_MASTER_KEY || "",
});
const MEILI_INDEX = process.env.MEILI_INDEX || "docs_plans";

async function getMeiliIndex() {
  try {
    return await meiliClient.getIndex(MEILI_INDEX);
  } catch {
    return await meiliClient.createIndex(MEILI_INDEX, { primaryKey: "uid" });
  }
}

// ─── State management ──────────────────────────────────────────────

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

// ─── File scanning ────────────────────────────────────────────────

async function scanDir(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await scanDir(fullPath);
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

// ─── Meilisearch document parsing ────────────────────────────────

function extractHeadings(content) {
  const headings = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  return headings;
}

async function parseMdFile(filePath, source) {
  const content = await fs.readFile(filePath, "utf-8");
  const headings = extractHeadings(content);
  const title = headings.length > 0 ? headings[0].text : path.basename(filePath, ".md");

  // Remove code blocks, then extract plain text (improve search quality)
  let textContent = content.replace(/```[\s\S]*?```/g, "");
  textContent = textContent.replace(/^#{1,6}\s+.+$/gm, "");   // remove headings
  textContent = textContent.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // keep only link text
  textContent = textContent.replace(/[|_\`\*\~]/g, "");       // clean up markdown syntax
  textContent = textContent.replace(/\n{2,}/g, "\n").trim();

  const relPath = path.relative(ROOT, filePath);

  // uid: remove special characters (Meilisearch document ID only allows alphanumeric, hyphen, underscore)
  const safeUid = `${source}_${relPath.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return {
    uid: safeUid,
    source,            // "docs" | "plans"
    filepath: relPath,
    title,
    content: textContent,
    headings: headings.map((h) => `H${h.level} ${h.text}`),
  };
}

async function upsertToMeili(doc) {
  const index = await getMeiliIndex();
  await index.addDocuments([doc], { primaryKey: "uid" });
}

async function deleteFromMeili(uid) {
  const index = await getMeiliIndex();
  await index.deleteDocument(uid);
}

// ─── Ingest logic (single file → Meilisearch) ──────────────────────

function computeUid(filePath, source) {
  const relPath = path.relative(ROOT, filePath);
  return `${source}_${relPath.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function ingestDocFile(filePath) {
  const fileName = path.basename(filePath);

  console.log(`[docs] Processing: ${fileName}`);

  const doc = await parseMdFile(filePath, "docs");
  await upsertToMeili(doc);
  console.log(`  → upserted to Meilisearch (uid: ${doc.uid})\n`);

  return true;
}

async function ingestPlanFile(filePath) {
  const fileName = path.basename(filePath);

  console.log(`[plans] Processing: ${fileName}`);

  const doc = await parseMdFile(filePath, "plans");
  await upsertToMeili(doc);
  console.log(`  → upserted to Meilisearch (uid: ${doc.uid})\n`);

  return true;
}

// ─── Main ──────────────────────────────────────────────────────────

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
      const [type, relPath] = key.split(":");
      const uid = computeUid(path.join(type === "docs" ? DOCS_DIR : PLANS_DIR_ROOT, relPath), type);
      console.log(`  [removed] ${key}`);
      try {
        await deleteFromMeili(uid);
        console.log(`    → deleted from Meilisearch (uid: ${uid})`);
      } catch (err) {
        console.error(`    ✗ Meili delete failed: ${err.message}`);
      }
      delete state.files[key];
    }
    console.log("");
  }

  // ── Code structure indexing (Meilisearch — file metadata) ──────
  console.log("--- Indexing code structure ---");

  const structScript = path.join(path.dirname(new URL(import.meta.url).pathname), "indexCodeStructure.js");
  const structArgs = [structScript];
  if (process.env.GRAPH_ROOT) {
    structArgs.push(process.env.GRAPH_ROOT);
  }
  if (forceAll) {
    structArgs.push("--force");
  }

  await new Promise((resolve, reject) => {
    const child = spawn("node", structArgs, {
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`indexCodeStructure exited with code ${code}`));
    });
    child.on("error", reject);
  });

  console.log("");

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
