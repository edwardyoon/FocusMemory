import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";

const QWEN_URL = process.env.QWEN_URL || "http://127.0.0.1:8080/v1/chat/completions";
const BGE_URL = process.env.BGE_URL || "http://127.0.0.1:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";

export const qdrant = new QdrantClient({ url: QDRANT_URL });

export const DOCS_SYSTEM_PROMPT = `당신은 기술 문서를 RAG 검색용 지식 조각(chunk)으로 변환하는 전문가입니다.

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

export const PLANS_SYSTEM_PROMPT = `You are an expert at converting work plan/history documents into knowledge chunks for the work_memory MCP server.

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

export async function embed(text) {
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

export async function chunkDocument(docText, systemPrompt, maxRetries = 2) {
  const body = JSON.stringify({
    model: "qwen3.6-27b",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: docText },
    ],
    temperature: 0.1,
    max_tokens: 14096,
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);

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
      if (!raw) {
        console.error("  [response content is empty]");
        return [];
      }

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

export async function deletePointsByDoc(collection, sourceDoc) {
  await qdrant.delete(collection, {
    filter: {
      must: [{ key: "source_doc", match: { value: sourceDoc } }],
    },
  });
}
