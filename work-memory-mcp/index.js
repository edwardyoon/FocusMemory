import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import fetch from "node-fetch";

const QDRANT_URL = process.env.QDRANT_URL || "http://192.168.219.102:6333";
const BGE_URL = process.env.BGE_URL || "http://192.168.219.102:8080/v1/embeddings";

const qdrant = new QdrantClient({ url: QDRANT_URL });

// Send text to bge-m3 embedding server and get back a vector
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

const server = new McpServer({
  name: "work-memory-mcp",
  version: "1.0.0",
});

// --- Tool 1: search past work history and decisions ---
server.registerTool(
  "search_work_memory",
  {
    title: "Search Work Memory",
    description:
      "Search past session work history, decisions, and unresolved issues. Always call this before starting coding tasks.",
    inputSchema: {
      query: z.string().describe("Topic or task to search for"),
      project: z
        .enum(["업체창고", "골목창고", "llm_infra", "kilo_setup"])
        .optional(),
      status: z.enum(["open", "resolved", "any"]).optional().default("open"),
    },
  },
  async ({ query, project, status }) => {
    const vector = await embed(query);
    const must = [];
    if (project) must.push({ key: "project", match: { value: project } });
    if (status !== "any") must.push({ key: "status", match: { value: status } });

    const results = await qdrant.search("work_memory", {
      vector,
      filter: must.length ? { must } : undefined,
      limit: 5,
      with_payload: true,
    });

    const text = results
      .map(
        (r) =>
          `[${r.payload.type}] ${r.payload.summary_text}\n  detail: ${r.payload.detail}\n  files: ${(r.payload.related_files || []).join(", ")}\n  score: ${r.score.toFixed(3)}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: text || "No matching records found" }],
    };
  }
);

// --- Tool 2: search project structural knowledge ---
server.registerTool(
  "search_project_facts",
  {
    title: "Search Project Facts",
    description:
      "Search fixed structural knowledge of the project (DB schemas, infrastructure topology, API specs).",
    inputSchema: {
      query: z.string(),
    },
  },
  async ({ query }) => {
    const vector = await embed(query);
    const results = await qdrant.search("project_facts", {
      vector,
      limit: 5,
      with_payload: true,
    });
    const text = results
      .map((r) => `[${r.payload.source_doc}] ${r.payload.content}`)
      .join("\n\n");
    return { content: [{ type: "text", text: text || "No matching documents found" }] };
  }
);

// --- Tool 3: manual record (maps to /remember command) ---
server.registerTool(
  "remember_decision",
  {
    title: "Remember Decision",
    description: "Immediately save an important decision or resolved issue to work_memory.",
    inputSchema: {
      summary_text: z.string(),
      detail: z.string().optional().default(""),
      project: z.enum(["업체창고", "골목창고", "llm_infra", "kilo_setup"]),
      type: z.enum(["decision", "bug_resolved", "todo"]),
      related_files: z.array(z.string()).optional().default([]),
    },
  },
  async ({ summary_text, detail, project, type, related_files }) => {
    const vector = await embed(summary_text);
    await qdrant.upsert("work_memory", {
      points: [
        {
          id: crypto.randomUUID(),
          vector,
          payload: {
            type,
            project,
            summary_text,
            detail,
            related_files,
            status: "open",
            timestamp: new Date().toISOString(),
          },
        },
      ],
    });
    return { content: [{ type: "text", text: "Saved successfully" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
