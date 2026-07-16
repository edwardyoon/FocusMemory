import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";

const BGE_URL = process.env.BGE_URL || "http://127.0.0.1:8080/v1/embeddings";
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";

const qdrant = new QdrantClient({ url: QDRANT_URL });

async function embed(text) {
  const res = await fetch(BGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: text }),
  });
  const data = await res.json();
  if (data.data && Array.isArray(data.data) && data.data[0]) {
    return data.data[0].embedding;
  }
  if (data.embedding) {
    return data.embedding;
  }
  console.error("Failed to parse embedding response:", JSON.stringify(data).substring(0, 300));
  return null;
}

async function search(collection, query, limit = 5) {
  const vector = await embed(query);
  const results = await qdrant.search(collection, {
    vector,
    limit,
    with_payload: true,
  });
  return results;
}

async function main() {
  const query = process.argv[2];
  const collection = process.argv[3] || "project_facts";

  if (!query) {
    console.log('Usage: node testSearch.js "query" [collection]');
    process.exit(1);
  }

  console.log(`Searching: "${query}" in "${collection}"\n`);
  const results = await search(collection, query);

  results.forEach((r, i) => {
    console.log(`--- #${i + 1} (score: ${r.score.toFixed(4)}) ---`);
    console.log(`section: ${r.payload.section_title}`);
    console.log(`content: ${r.payload.content}`);
    console.log(`tags: ${(r.payload.tags || []).join(", ")}`);
    console.log();
  });
}

main().catch(console.error);