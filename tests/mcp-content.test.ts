import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { connectMcpServers, mcpResultToToolResult } from "../src/tools/mcp-client.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

test("T-06d: structured JSON is canonical, distinct text survives, and remote errors remain errors", () => {
  const result = mcpResultToToolResult({ structuredContent: { ok: true }, content: [
    { type: "text", text: '{"ok":true}' }, { type: "text", text: "additional" },
  ] }, 8192);
  assert.deepEqual(result.content, [{ type: "json", value: { ok: true } }, { type: "text", text: "additional" }]);
  assert.equal(result.isError, false);
  assert.equal(mcpResultToToolResult({ isError: true, content: [{ type: "text", text: "failed" }] }, 8192).isError, true);
});

test("T-06d: PNG/JPEG remain native image blocks; unsupported media/resource and oversized result are explicit errors", () => {
  for (const mimeType of ["image/png", "image/jpeg"]) {
    const result = mcpResultToToolResult({ content: [{ type: "image", mimeType, data: png }] }, 8192);
    assert.deepEqual(result.content, [{ type: "image", mimeType, data: png }]);
  }
  for (const content of [
    { type: "image", mimeType: "image/webp", data: png },
    { type: "resource_link", uri: "https://example.test/private", name: "secret" },
    { type: "audio", mimeType: "audio/wav", data: png },
  ]) assert.equal(mcpResultToToolResult({ content: [content] }, 8192).code, "unsupported_content");
  assert.equal(mcpResultToToolResult({ content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) }] }, 8192).code, "result_too_large");
  const capped = mcpResultToToolResult({ structuredContent: { payload: "é".repeat(100) }, content: [] }, 20);
  assert.equal(capped.truncated, true);
  assert.equal(capped.content[0]?.type, "text");
  assert.ok((capped.retainedBytes ?? Infinity) <= 20);
});

test("T-06d: multi-megabyte valid image remains native below the decoded and output caps", () => {
  const large = Buffer.alloc(4_000_000).toString("base64");
  const result = mcpResultToToolResult({ content: [{ type: "image", mimeType: "image/png", data: large }] }, 8 * 1024 * 1024);
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.type, "image");
  assert.equal(result.content[0]?.type === "image" ? result.content[0].data.length : 0, large.length);
});

test("T-06d: real MCP PNG/JPEG tools become native OpenAI image payloads after linked tool results", async () => {
  for (const [value, mimeType, data] of [
    ["image", "image/png", png],
    ["jpeg", "image/jpeg", Buffer.from([255, 216, 255, 217]).toString("base64")],
  ]) {
    const connection = await connectMcpServers({ servers: { images: { command: process.execPath,
      args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], tools: ["selected"] } }, cwd: process.cwd(), timeoutMs: 3000 });
    const alias = connection.exposed[0]!.alias;
    const fixture = await startMockProvider([
      { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "image-call", type: "function", function: { name: alias, arguments: JSON.stringify({ value }) } }] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "seen" }, "stop"), openAiDone] },
    ]);
    const agent = createAgent({ provider: createProvider({ name: "model", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "key", vision: true }),
      registry: connection.registry, cwd: process.cwd(), autoApprove: true });
    try {
      assert.equal((await agent.run("view image")).text, "seen");
      const messages = (fixture.requests[1]?.body as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }).messages;
      const tool = messages.findIndex((message) => message.role === "tool" && message.tool_call_id === "image-call");
      const image = messages.findIndex((message) => message.role === "user" && Array.isArray(message.content));
      assert.ok(tool >= 0 && image > tool);
      assert.deepEqual(messages[image]?.content, [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } }]);
    } finally { await agent.close(); await fixture.close(); await connection.close(); }
  }
});

test("T-06d: real MCP structured/error/resource results preserve semantics and never fetch resource URLs", async () => {
  const connection = await connectMcpServers({ servers: { content: { command: process.execPath,
    args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], tools: ["selected"] } }, cwd: process.cwd(), timeoutMs: 3000 });
  try {
    const alias = connection.exposed[0]!.alias;
    const run = (value: string) => connection.registry.dispatch(alias, { value }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
    assert.deepEqual((await run("structured")).content, [{ type: "json", value: { label: "stdio" } }]);
    const failed = await run("error");
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /stdio:failure/);
    assert.equal((await run("resource")).code, "unsupported_content");
  } finally { await connection.close(); }
});
