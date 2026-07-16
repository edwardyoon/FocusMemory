import fs from "fs/promises";
import path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";

const QWEN_URL = process.env.QWEN_URL || "http://192.168.219.123:8080/v1/chat/completions"; // adjust to your llama.cpp server port
const BGE_URL = process.env.BGE_URL || "http://192.168.219.102:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://192.168.219.102:6333";

const qdrant = new QdrantClient({ url: QDRANT_URL });

// If a single filename is passed as an argument, process only that file; otherwise scan all of docs/
const singleFileArg = process.argv[2];

const SYSTEM_PROMPT = `당신은 기술 문서를 RAG 검색용 지식 조각(chunk)으로 변환하는 전문가입니다.

아래 마크다운 문서를 읽고, 독립적으로 검색 가능한 사실(fact) 단위로 쪼개서 JSON 배열로만 출력하세요.

규칙:
1. 각 chunk는 그 자체로 완결된 문장이어야 합니다. "이 값은", "위 표에서" 같은 문맥 의존 표현 금지 — 반드시 무엇을 가리키는지 명시하세요.
2. 하나의 chunk는 하나의 사실/개념만 담습니다.
3. 코드 예시, 설정값, IP 주소, 컬럼명 등 구체적 사실은 절대 누락하거나 요약하지 말고 원문 그대로 보존하세요.
4. 절차/순서가 있는 내용은 하나의 chunk로 유지하되, 너무 길면 논리적 단위로 분리하세요.
5. 각 chunk는 3~6문장 이내로 작성하세요.
6. 잡담, 배경 설명, 중복 내용은 제외하세요.

출력 형식 (JSON만 출력, 다른 텍스트 절대 포함 금지):
[{"content": "...", "section_title": "...", "tags": ["...", "..."]}]`;

async function embed(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    console.log(`    [embed request] ${BGE_URL} (length: ${text.length})`);

    const res = await fetch(BGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bge-m3", input: text }),
      signal: controller.signal,
    });

    console.log(`    [embed response] HTTP ${res.status}`);

    if (res.status !== 200) {
      const errText = await res.text();
      console.error("    [embed error]", errText.substring(0, 300));
      return null;
    }

    const data = await res.json();
    console.log(`    [embed response keys]: ${JSON.stringify(Object.keys(data))}`);

    // BGE-m3 openai-compatible endpoint: data.data[0].embedding
    if (data.data && Array.isArray(data.data) && data.data[0]) {
      const vec = data.data[0].embedding;
      console.log(`    [embed] dims: ${vec ? vec.length : 'null'}`);
      return vec;
    }

    // Direct /embed endpoint: data.embedding
    if (data.embedding) {
      console.log(`    [embed] dims: ${data.embedding.length}`);
      return data.embedding;
    }

    console.error("    [embed error] unknown response format:", JSON.stringify(data).substring(0, 300));
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
    temperature: 0.1, // low temperature for factual extraction
    max_tokens: 14096,
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // max 10 min for LLM processing

    try {
      console.log(`  [LLM request] attempt ${attempt}/${maxRetries} — ${QWEN_URL} (body: ${body.length} bytes)`);

      const res = await fetch(QWEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      console.log(`  [LLM response] HTTP ${res.status}`);

      if (res.status !== 200) {
        const errText = await res.text();
        console.error("  [HTTP error] status:", res.status);
        console.error("  [HTTP error] body:", errText.substring(0, 500));
        return [];
      }

      const data = await res.json();

      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        console.error("  [response structure error]", JSON.stringify(data).substring(0, 500));
        return [];
      }

      let raw = data.choices[0].message.content.trim();
      if (!raw) {
        console.error("  [response content is empty]");
        return [];
      }

      // Strip markdown code fences if the model wraps output in ```json ... ```
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

async function ingestFile(filePath) {
  const docText = await fs.readFile(filePath, "utf-8");
  const fileName = path.basename(filePath);
  console.log(`Processing: ${fileName} (${docText.length} chars)`);

  // Delete existing points first to avoid duplicates on re-run
  await deletePointsByDoc("project_facts", fileName);
  console.log(`  → deleted existing points for '${fileName}'`);

  const chunks = await chunkDocument(docText);
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