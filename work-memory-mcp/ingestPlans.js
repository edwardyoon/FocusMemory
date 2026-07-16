import fs from "fs/promises";
import path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";

const QWEN_URL = process.env.QWEN_URL || "http://192.168.219.123:8080/v1/chat/completions";
const BGE_URL = process.env.BGE_URL || "http://192.168.219.102:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://192.168.219.102:6333";
// plans/ directory is relative to the parent of work-memory-mcp/
const PLANS_DIR_ROOT = process.env.PLANS_DIR || path.join(process.cwd(), "..", "plans");

const qdrant = new QdrantClient({ url: QDRANT_URL });

// If a single filename is passed as an argument, process only that file; otherwise scan all of plans/
const singleFileArg = process.argv[2];

const SYSTEM_PROMPT = `You are an expert at converting work plan/history documents into knowledge chunks for the work_memory MCP server.

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

async function embed(text) {
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

async function chunkDocument(docText, maxRetries = 2) {
  const body = JSON.stringify({
    model: "qwen3.6-27b",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: docText },
    ],
    temperature: 0.1,
    max_tokens: 14096,
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // max 10 min for LLM processing

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

async function deletePointsByDoc(collection, fileName) {
  await qdrant.delete(collection, {
    filter: {
      must: [{ key: "source_doc", match: { value: fileName } }],
    },
  });
}

// Infer project name and type from filename/path
function inferMetadata(filePath, isDone) {
  const fileName = path.basename(filePath);

  // Files under plans/done/ are completed tasks → status: resolved
  const status = isDone ? "resolved" : "open";

  // Extract related files from the path (listed filenames only)
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

  const chunks = await chunkDocument(docText);
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

// Extract file path patterns from document text
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
