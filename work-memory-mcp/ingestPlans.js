import dotenv from "dotenv";
dotenv.config({ override: true }); // .env 최우선 — settings.json env 변수 오버라이드;
import fs from "fs/promises";
import path from "path";
import { qdrant, embed, chunkDocument, deletePointsByDoc, PLANS_SYSTEM_PROMPT } from "./utils.js";

// plans/ directory is relative to the parent of work-memory-mcp/
const PLANS_DIR_ROOT = process.env.PLANS_DIR || path.join(process.cwd(), "..", "plans");

// If a single filename is passed as an argument, process only that file; otherwise scan all of plans/
const singleFileArg = process.argv[2];

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

// Infer project name and type from filename/path
function inferMetadata(filePath, isDone) {
  const fileName = path.basename(filePath);
  const status = isDone ? "resolved" : "open";
  return { status, source_doc: `${isDone ? 'done/' : ''}${fileName}` };
}

async function ingestPlan(filePath) {
  const docText = await fs.readFile(filePath, "utf-8");
  const fileName = path.basename(filePath);
  console.log(`Processing: ${fileName} (${docText.length} chars)`);

  // Delete existing points first to avoid duplicates on re-run
  const isDone = filePath.includes("/done/");
  const metadata = inferMetadata(filePath, isDone);

  await deletePointsByDoc("work_memory", metadata.source_doc);
  console.log(`  → deleted existing points for '${metadata.source_doc}'`);

  const chunks = await chunkDocument(docText, PLANS_SYSTEM_PROMPT);
  if (chunks.length === 0) {
    console.log("  → failed to extract chunks, skipped\n");
    return;
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

    // Extract file paths mentioned in the document
    const relatedFiles = extractFilePaths(docText);

    points.push({
      id: crypto.randomUUID(),
      vector,
      payload: {
        type: "decision",
        project: "", // left empty since plans span across all projects
        summary_text: chunk.section_title || fileName,
        detail: chunk.content,
        related_files: relatedFiles,
        status: metadata.status,
        source_doc: metadata.source_doc,
        timestamp: new Date().toISOString(),
      },
    });
  }

  if (points.length > 0) {
    await qdrant.upsert("work_memory", { points });
    console.log(`  → saved ${points.length} points to work_memory\n`);
  } else {
    console.log("  → no points to save, skipped\n");
  }
}

async function main() {
  const PLANS_DIR = PLANS_DIR_ROOT;
  const DONE_DIR = path.join(PLANS_DIR, "done");
  let targetFiles = [];

  if (singleFileArg) {
    // Single file mode: search under plans/ and plans/done/
    const searchPaths = [PLANS_DIR, DONE_DIR];
    let foundPath = null;

    for (const dir of searchPaths) {
      try {
        const candidate = path.join(dir, singleFileArg);
        await fs.access(candidate);
        foundPath = candidate;
        break;
      } catch {
        // try next directory
      }
    }

    if (!foundPath) {
      console.error(`Error: file not found — ${singleFileArg}`);
      process.exit(1);
    }

    targetFiles = [foundPath];
    console.log(`Single file mode: ${singleFileArg}\n`);
  } else {
    // Full scan mode: plans/*.md + plans/done/*.md
    try {
      const files = await fs.readdir(PLANS_DIR);
      for (const f of files) {
        if (f.endsWith(".md")) {
          targetFiles.push(path.join(PLANS_DIR, f));
        }
      }
    } catch {
      console.error("Error: cannot read plans/ directory");
    }

    try {
      const doneFiles = await fs.readdir(DONE_DIR);
      for (const f of doneFiles) {
        if (f.endsWith(".md")) {
          targetFiles.push(path.join(DONE_DIR, f));
        }
      }
    } catch {
      console.error("Error: cannot read plans/done/ directory");
    }

    console.log(`Found ${targetFiles.length} plan files (${PLANS_DIR}/ + ${DONE_DIR}/)\n`);
  }

  let successCount = 0;
  let failCount = 0;

  for (const filePath of targetFiles) {
    try {
      await ingestPlan(filePath);
      successCount++;
    } catch (err) {
      console.error(`  ✗ failed: ${path.basename(filePath)} — ${err.message}\n`);
      failCount++;
    }
  }

  console.log(`Done: ${successCount} succeeded, ${failCount} failed`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
