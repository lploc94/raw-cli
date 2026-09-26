import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "mixed-example", version: "1.0.0" } };
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo_text", description: "Echo text from the package MCP fixture",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"],
        additionalProperties: false } }] };
  } else if (request.method === "tools/call" && request.params?.name === "echo_text") {
    result = { content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] };
  } else if (request.method === "ping") {
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "Method not found" } }) + "\n");
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
