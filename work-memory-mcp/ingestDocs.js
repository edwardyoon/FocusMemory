import dotenv from "dotenv";
dotenv.config({ override: true }); // .env 최우선 — settings.json env 변수 오버라이드;
import fs from "fs/promises";
import path from "path";
import { qdrant, embed, chunkDocument, deletePointsByDoc, DOCS_SYSTEM_PROMPT } from "./utils.js";

// If a single filename is passed as an argument, process only that file; otherwise scan all of docs/
const singleFileArg = process.argv[2];

async function ingestFile(filePath) {
  const docText = await fs.readFile(filePath, "utf-8");
  const fileName = path.basename(filePath);
  console.log(`Processing: ${fileName} (${docText.length} chars)`);

  // Delete existing points first to avoid duplicates on re-run
  await deletePointsByDoc("project_facts", fileName);
  console.log(`  → deleted existing points for '${fileName}'`);

  const chunks = await chunkDocument(docText, DOCS_SYSTEM_PROMPT);
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
    console.log(`  → saved ${points.length} points to Qdrant`);
  } else {
    console.log("  → no points to save, skipped");
  }
}

async function main() {
  const DOCS_DIR = path.join(process.cwd(), "docs");
  let targetFiles;

  if (singleFileArg) {
    // Single file mode: look for the given filename under docs/
    if (!singleFileArg.endsWith(".md")) {
      console.error("Error: filename must have a .md extension");
      process.exit(1);
    }
    const filePath = path.isAbsolute(singleFileArg)
      ? singleFileArg
      : path.join(DOCS_DIR, singleFileArg);

    try {
      await fs.access(filePath);
    } catch {
      console.error(`Error: file not found — ${filePath}`);
      process.exit(1);
    }

    targetFiles = [filePath];
    console.log(`Single file mode: ${singleFileArg}\n`);
  } else {
    // Full scan mode
    const files = await fs.readdir(DOCS_DIR);
    targetFiles = files.filter((f) => f.endsWith(".md")).map((f) => path.join(DOCS_DIR, f));

    console.log(`Found ${targetFiles.length} .md files\n`);
  }

  let successCount = 0;
  let failCount = 0;

  for (const filePath of targetFiles) {
    try {
      await ingestFile(filePath);
      successCount++;
    } catch (err) {
      console.error(`  ✗ failed: ${path.basename(filePath)} — ${err.message}\n`);
      failCount++;
    }
  }

  console.log(`\nDone: ${successCount} succeeded, ${failCount} failed`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
