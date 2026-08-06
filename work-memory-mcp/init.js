import "dotenv/config";
import fs from "fs/promises";
import path from "path";

const targetDir = process.argv[2];

if (!targetDir) {
  console.error("Usage: node init.js <project-root-directory>");
  console.error("  Creates docs/, plans/ folders and .focusmemoryignore in the target directory.");
  process.exit(1);
}

const root = path.resolve(targetDir);

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (err) {
    console.error(`[error] failed to create ${dirPath}: ${err.message}`);
    return false;
  }
}

async function writeFileIfAbsent(filePath, content) {
  try {
    await fs.access(filePath);
    return false; // already exists
  } catch {
    await fs.writeFile(filePath, content, "utf-8");
    return true;
  }
}

const files = {
  "docs/.gitkeep": "",
  "plans/active.md": `# Active Work Plan

## Objective

## Key decisions made

## Files changed

## Remaining tasks

---

<!-- When this plan is complete, move to plans/done/YYYY-MM-DD-title.md -->
`,
  "plans/done/.gitkeep": "",
  ".focusmemoryignore": `# .focusmemoryignore — FocusMemory indexing exclusion rules
node_modules/
vendor/
.git/
dist/
build/
coverage/
*.min.js
*.min.css
**/.env*
`,
};

async function main() {
  try {
    await fs.access(root);
  } catch {
    console.error(`[error] directory not found: ${root}`);
    process.exit(1);
  }

  console.log("=== FocusMemory Workspace Init ===");
  console.log("[target] %s\n", root);

  let createdDirs = 0;
  let createdFiles = 0;
  let skippedFiles = 0;

  // Create directories first
  for (const relPath of Object.keys(files)) {
    const dir = path.dirname(path.join(root, relPath));
    if (await ensureDir(dir)) createdDirs++;
  }

  console.log("[dirs] ensured %d directories\n", createdDirs);

  // Write files (skip if already present)
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    const wrote = await writeFileIfAbsent(fullPath, content);
    if (wrote) {
      console.log("[new] %s", relPath);
      createdFiles++;
    } else {
      console.log("[skip] %s (already exists)", relPath);
      skippedFiles++;
    }
  }

  // Create .env.example if it doesn't exist in work-memory-mcp directory
  const mcpDir = path.dirname(new URL(import.meta.url).pathname);
  const envExamplePath = path.join(mcpDir, ".env.example");
  const wroteEnv = await writeFileIfAbsent(envExamplePath, `# FocusMemory MCP Server Configuration

# Qdrant vector database (required)
QDRANT_URL=http://127.0.0.1:6333

# BGE-M3 embedding server (required for search)
BGE_URL=http://127.0.0.1:8080/v1/embeddings

# Qwen LLM for document chunking (required for ingest)
QWEN_URL=http://127.0.0.1:8080/v1/chat/completions

# Summary lightweight LLM for prune & summarize (optional, graceful fallback if unavailable)
SUMMARY_LLM_URL=http://127.0.0.1:8081/v1/chat/completions
SUMMARY_LLM_MODEL=summary-27b

# Project root for graph/code indexing (defaults to /opt/homebrew/var/www)
GRAPH_ROOT=/path/to/your/project

# HTTP endpoint auth token (default: focus-memory-local)
CONTEXT_API_TOKEN=focus-memory-local

# Ignore file path (defaults to .focusmemoryignore in project root)
FOCUS_IGNORE_FILE=/path/to/your/project/.focusmemoryignore
`);
  if (wroteEnv) {
    console.log("[new] work-memory-mcp/.env.example");
  } else {
    console.log("[skip] work-memory-mcp/.env.example (already exists)");
  }

  console.log(
    "\n=== Done ===\n" +
      `  Created: ${createdFiles} file(s), skipped: ${skippedFiles}\n\n` +
      "Next steps:\n" +
      `  1. Drop project docs (markdown) into ${root}/docs/\n` +
      `  2. Copy .env.example to work-memory-mcp/.env and edit values\n` +
      "  3. cd work-memory-mcp && npm run create-collections\n" +
      "  4. npm run auto-ingest --force    (initial full ingest)\n" +
      "  5. Set up cron: */5 * * * * cd /path/to/work-memory-mcp && npm run auto-ingest\n",
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
