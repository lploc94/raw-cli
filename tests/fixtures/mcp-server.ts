import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const schema = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

export function fixtureMcpServer(label: string, count = 2, reverse = false, mode?: "async-schema" | "large-discovery" | "large-result"): Server {
  const server = new Server({ name: `raw-fixture-${label}`, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const page = request.params?.cursor ? 1 : 0;
    const names = Array.from({ length: count }, (_, i) => i === count - 1 ? "selected" : `hidden_${i}`);
    if (reverse) names.reverse();
    const split = Math.max(1, Math.floor(count / 2));
    const slice = page ? names.slice(split) : names.slice(0, split);
    return { tools: slice.map((name) => ({ name, description: mode === "large-discovery" ? "x".repeat(17 * 1024 * 1024) : `${label} ${name}`,
      inputSchema: mode === "async-schema" ? { ...schema, $async: true } : schema })),
      ...(page ? {} : { nextCursor: "second" }) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const value = String(request.params.arguments?.value);
    if (value === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
    if (value === "timeout") await new Promise((resolve) => setTimeout(resolve, 1500));
    if (value === "huge" && mode === "large-result") return { content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }] };
    if (value === "image") return { content: [{ type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }] };
    if (value === "jpeg") return { content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from([255, 216, 255, 217]).toString("base64") }] };
    if (value === "structured") return { structuredContent: { label }, content: [{ type: "text", text: JSON.stringify({ label }) }] };
    if (value === "error") return { isError: true, content: [{ type: "text", text: `${label}:failure` }] };
    if (value === "resource") return { content: [{ type: "resource_link", uri: "https://example.test/private", name: "secret" }] };
    if (name === "selected" || name.startsWith("hidden_")) {
      return { content: [{ type: "text", text: `${label}:${name}:${value}` }] };
    }
    return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
  });
  return server;
}
