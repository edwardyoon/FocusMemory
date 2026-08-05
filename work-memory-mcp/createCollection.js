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

async function createGraphCollections() {
  // graph_nodes: function/method definitions — keyword search by name, file, kind
  const collections = (await qdrant.getCollections()).collections;
  if (!collections.some((c) => c.name === "graph_nodes")) {
    await qdrant.createCollection("graph_nodes", {
      vectors: { size: 1, distance: "Cosine" }, // dummy vector; search is payload-only
    });
    console.log("[created] collection \"graph_nodes\" created");
  } else {
    console.log('[skip] collection "graph_nodes" already exists');
  }

  await qdrant.createPayloadIndex("graph_nodes", { field_name: "name", field_schema: "keyword" });
  await qdrant.createPayloadIndex("graph_nodes", { field_name: "file", field_schema: "keyword" });
  await qdrant.createPayloadIndex("graph_nodes", { field_name: "kind", field_schema: "keyword" });
  await qdrant.createPayloadIndex("graph_nodes", { field_name: "lang", field_schema: "keyword" });
  console.log("[indexed] graph_nodes: payload indexes for name, file, kind, lang");

  // graph_edges: call relationships — keyword search by target_name, source_file
  if (!collections.some((c) => c.name === "graph_edges")) {
    await qdrant.createCollection("graph_edges", {
      vectors: { size: 1, distance: "Cosine" }, // dummy vector; search is payload-only
    });
    console.log("[created] collection \"graph_edges\" created");
  } else {
    console.log('[skip] collection "graph_edges" already exists');
  }

  await qdrant.createPayloadIndex("graph_edges", { field_name: "target_name", field_schema: "keyword" });
  await qdrant.createPayloadIndex("graph_edges", { field_name: "source_file", field_schema: "keyword" });
  console.log("[indexed] graph_edges: payload indexes for target_name, source_file");
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

async function createCodeChunksCollection() {
  const collections = (await qdrant.getCollections()).collections;
  if (!collections.some((c) => c.name === "code_chunks")) {
    await qdrant.createCollection("code_chunks", {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    console.log('[created] collection "code_chunks" created');
  } else {
    console.log('[skip] collection "code_chunks" already exists');
  }

  await qdrant.createPayloadIndex("code_chunks", { field_name: "language", field_schema: "keyword" });
  await qdrant.createPayloadIndex("code_chunks", { field_name: "entity_type", field_schema: "keyword" });
  await qdrant.createPayloadIndex("code_chunks", { field_name: "file_path", field_schema: "keyword" });
  console.log("[indexed] code_chunks: payload indexes for language, entity_type, file_path");
}

async function main() {
  try {
    await createCollectionIfNotExists("work_memory");
    await createCollectionIfNotExists("project_facts");
    await createPayloadIndexes();
    await createGraphCollections();
    await createCodeChunksCollection();
    console.log("\nDone. Check at http://127.0.0.1:6333/dashboard");
  } catch (err) {
    console.error("Error:", err.message);
    if (err.data) console.error(JSON.stringify(err.data, null, 2));
    process.exit(1);
  }
}

main();
