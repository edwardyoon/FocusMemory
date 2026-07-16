import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const VECTOR_SIZE = 1024; // bge-m3 embedding dimension — change here if your server differs

const qdrant = new QdrantClient({ url: QDRANT_URL });

async function createCollectionIfNotExists(name) {
  const { collections } = await qdrant.getCollections();
  const exists = collections.some((c) => c.name === name);

  if (exists) {
    console.log(`[skip] collection "${name}" already exists`);
    return;
  }

  await qdrant.createCollection(name, {
    vectors: {
      size: VECTOR_SIZE,
      distance: "Cosine",
    },
  });
  console.log(`[created] collection "${name}" created`);
}

async function createPayloadIndexes() {
  // work_memory: frequently filtered by project and status — indexes recommended for performance
  await qdrant.createPayloadIndex("work_memory", {
    field_name: "project",
    field_schema: "keyword",
  });
  await qdrant.createPayloadIndex("work_memory", {
    field_name: "status",
    field_schema: "keyword",
  });
  await qdrant.createPayloadIndex("work_memory", {
    field_name: "type",
    field_schema: "keyword",
  });
  console.log("[indexed] work_memory: payload indexes created for project, status, type");

  await qdrant.createPayloadIndex("project_facts", {
    field_name: "source_doc",
    field_schema: "keyword",
  });
  console.log("[indexed] project_facts: payload index created for source_doc");
}

async function main() {
  try {
    await createCollectionIfNotExists("work_memory");
    await createCollectionIfNotExists("project_facts");
    await createPayloadIndexes();
    console.log("\nDone. Check at http://127.0.0.1:6333/dashboard");
  } catch (err) {
    console.error("Error:", err.message);
    if (err.data) console.error(JSON.stringify(err.data, null, 2));
    process.exit(1);
  }
}

main();
