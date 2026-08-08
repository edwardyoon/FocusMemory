#!/usr/bin/env node
// www/docs 와 www/plans 하위의 .md 파일을 Meilisearch에 색인하는 스크립트
const fs = require("fs");
const path = require("path");
const { Meilisearch } = require("meilisearch");

const ROOT = path.resolve(__dirname, ".."); // /Users/edwardyoon/www
const DOCS_DIR = path.join(ROOT, "docs");
const PLANS_DIR = path.join(ROOT, "plans");

// MEILI_MASTER_KEY 환경 변수 또는 .meilisearch.env 파일에서 읽기
const ENV_FILE = path.resolve(__dirname, "../../../.meilisearch.env");
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
  host: "http://localhost:7701",
  apiKey: MASTER_KEY,
});

const INDEX_NAME = "docs_plans";

/**
 * md 파일에서 heading 목록과 첫 번째 heading(제목) 추출
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
 * 하위 디렉토리 포함하여 .md 파일 경로 목록 반환
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
 * Markdown 파일 파싱 → Meilisearch 문서 객체
 */
function parseMd(filePath, source) {
  const content = fs.readFileSync(filePath, "utf8");
  const headings = extractHeadings(content);
  const title = headings.length > 0 ? headings[0].text : path.basename(filePath, ".md");

  // 코드 블록 제거 후 순수 텍스트 추출 (검색 품질 개선)
  let textContent = content.replace(/```[\s\S]*?```/g, "");
  textContent = textContent.replace(/^#{1,6}\s+.+$/gm, "");   // heading 제거
  textContent = textContent.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // 링크 텍스트만 남김
  textContent = textContent.replace(/[|_\`\*\~]/g, "");       // markdown 구문 정리
  textContent = textContent.replace(/\n{2,}/g, "\n").trim();

  const relPath = path.relative(ROOT, filePath);

  // uid: 특수문자 제거 (Meilisearch document ID는 alphanumeric, hyphen, underscore만 허용)
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

  // 인덱스 생성 또는 가져오기
  let index;
  try {
    const existing = await client.getIndex(INDEX_NAME);
    index = existing;
  } catch {
    index = await client.createIndex(INDEX_NAME, { primaryKey: "uid" });
  }

  // 검색 가능한 필드 설정
  console.log("Configuring settings...");
  await index.updateSettings({
    searchableAttributes: ["title", "content", "headings"],
    filterableAttributes: ["source"],
  });

  // 문서 일괄 등록 (업sert)
  console.log(`Indexing ${documents.length} documents into "${INDEX_NAME}"...`);
  const task = await index.addDocuments(documents, { primaryKey: "uid" });
  console.log(`Task enqueued: taskId=${task.taskUid}`);

  // 완료 대기 (REST API 직접 호출)
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

  // 검증: 문서 수 확인
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
