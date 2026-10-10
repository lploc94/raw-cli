import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { writeFileSync } from "node:fs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const schema = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

export function fixtureMcpServer(label: string, count = 2, reverse = false, mode?: "async-schema" | "unsupported-hidden" | "draft7-schema" | "numeric-formats-schema" | "large-discovery" | "large-result"): Server {
  const server = new Server({ name: `raw-fixture-${label}`, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (process.env.MCP_LIST_STARTED_FILE) writeFileSync(process.env.MCP_LIST_STARTED_FILE, "started");
    if (process.env.MCP_LIST_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.MCP_LIST_DELAY_MS)));
    const page = request.params?.cursor ? 1 : 0;
    const names = Array.from({ length: count }, (_, i) => i === count - 1 ? "selected" : `hidden_${i}`);
    if (reverse) names.reverse();
    const split = Math.max(1, Math.floor(count / 2));
    const slice = page ? names.slice(split) : names.slice(0, split);
    return { tools: slice.map((name) => ({ name, description: mode === "large-discovery" ? "x".repeat(17 * 1024 * 1024) : `${label} ${name}`,
      inputSchema: mode === "async-schema" ? { ...schema, $async: true }
        : mode === "draft7-schema" ? { ...schema, $schema: "http://json-schema.org/draft-07/schema#" }
        : mode === "numeric-formats-schema" ? { ...schema, properties: { ...schema.properties, limit: { type: "integer", format: "uint32" }, max_hops: { type: "integer", format: "uint8" } } }
        : mode === "unsupported-hidden" && name.startsWith("hidden_") ? { ...schema, $schema: "https://example.invalid/unsupported-schema" } : schema })),
      ...(page ? {} : { nextCursor: "second" }) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const value = String(request.params.arguments?.value);
    if (value === "progress") {
      // Longer than the caller's timeout overall, but never silent for longer than 300ms.
      const progressToken = request.params._meta?.progressToken;
      for (let step = 1; step <= 5; step++) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (progressToken !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: step, total: 5 } });
      }
    }
    if (value === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
    if (value === "timeout") await new Promise((resolve) => setTimeout(resolve, 1500));
    if (value === "huge" && mode === "large-result") return { content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }] };
    if (value === "image") return { content: [{ type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }] };
    if (value === "jpeg") return { content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from([255, 216, 255, 217]).toString("base64") }] };
    if (value === "structured") return { structuredContent: { label }, content: [{ type: "text", text: JSON.stringify({ label }) }] };
    if (value === "panel") return { content: [{ type: "text", text: "panelled" }], _meta: { "raw/panel": { panel: "plan", op: "replace",
      document: { blocks: [{ id: "c", kind: "checklist", items: [{ id: "a", label: "From MCP" }] }] } } } };
    if (value === "error") return { isError: true, content: [{ type: "text", text: `${label}:failure` }] };
    if (value === "resource") return { content: [{ type: "resource_link", uri: "https://example.test/private", name: "secret" }] };
    if (name === "selected" || name.startsWith("hidden_")) {
      return { content: [{ type: "text", text: `${label}:${name}:${value}` }] };
    }
    return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
  });
  return server;
}
