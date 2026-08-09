#!/usr/bin/env node
// Index .md files under www/docs and www/plans into Meilisearch
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Meilisearch } from "meilisearch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, ".."); // /opt/homebrew/var/www
const DOCS_DIR = path.join(ROOT, "docs");
const PLANS_DIR = path.join(ROOT, "plans");

// Read MEILI_MASTER_KEY from environment variable or .meilisearch.env file
const ENV_FILE = path.resolve(__dirname, "../../.meilisearch.env");
let MASTER_KEY = process.env.MEILI_MASTER_KEY || "";
if (!MASTER_KEY && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^MEILI_MASTER_KEY=(.+)$/);
    if (m) {
      MASTER_KEY = m[1].trim();
      break;
    }
  }
}

if (!MASTER_KEY) {
  console.error("Fatal: MEILI_MASTER_KEY not found in environment or .meilisearch.env");
  process.exit(1);
}

const client = new Meilisearch({
  host: "http://localhost:7700",
  apiKey: MASTER_KEY,
});

const INDEX_NAME = "docs_plans";

/**
 * Extract heading list and first heading (title) from a Markdown file
 */
function extractHeadings(content) {
  const headings = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  return headings;
}

/**
 * Return a list of .md file paths, including subdirectories
 */
function findMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Parse Markdown file → Meilisearch document object
 */
function parseMd(filePath, source) {
  const content = fs.readFileSync(filePath, "utf8");
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

async function main() {
  console.log("Collecting .md files...");

  const docsFiles = findMdFiles(DOCS_DIR);
  const plansFiles = findMdFiles(PLANS_DIR);

  console.log(`  docs : ${docsFiles.length} files`);
  console.log(`  plans: ${plansFiles.length} files`);

  const documents = [
    ...docsFiles.map((f) => parseMd(f, "docs")),
    ...plansFiles.map((f) => parseMd(f, "plans")),
  ];

  if (documents.length === 0) {
    console.log("No .md files found. Exiting.");
    return;
  }

  // Create or retrieve index
  let index;
  try {
    const existing = await client.getIndex(INDEX_NAME);
    index = existing;
  } catch {
    index = await client.createIndex(INDEX_NAME, { primaryKey: "uid" });
  }

  // Configure searchable fields
  console.log("Configuring settings...");
  await index.updateSettings({
    searchableAttributes: ["title", "content", "headings"],
    filterableAttributes: ["source"],
  });

  // Bulk upsert documents
  console.log(`Indexing ${documents.length} documents into "${INDEX_NAME}"...`);
  const task = await index.addDocuments(documents, { primaryKey: "uid" });
  console.log(`Task enqueued: taskId=${task.taskUid}`);

  // Wait for completion (direct REST API call)
  console.log("Waiting for indexing to complete...");
  while (true) {
    const resp = await fetch(`${client.config.host}/tasks/${task.taskUid}`, {
      headers: MASTER_KEY ? { Authorization: `Bearer ${MASTER_KEY}` } : {},
    });
    const result = await resp.json();
    if (result.status === "succeeded") break;
    if (result.error) throw new Error(`Indexing failed: ${JSON.stringify(result.error)}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("✅ Indexing complete.");

  // Verify: check document count
  const statsResp = await fetch(`${client.config.host}/indexes/docs_plans/stats`, {
    headers: MASTER_KEY ? { Authorization: `Bearer ${MASTER_KEY}` } : {},
  });
  const statsData = await statsResp.json();
  console.log(`  documentCount: ${statsData.numberOfDocuments || "unknown"}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
