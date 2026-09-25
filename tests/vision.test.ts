import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { loadConfig, parseCliArgs } from "../src/config.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { createProvider } from "../src/llm/client.js";
import { createAgent } from "../src/agent.js";
import { connectMcpServers } from "../src/tools/mcp-client.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

function pngChunk(type: string, data: Buffer): Buffer {
  const kind = Buffer.from(type);
  const bytes = Buffer.concat([kind, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  kind.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}

function validPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(40, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(40 * 257);
  for (let row = 0; row < 40; row++) randomBytes(256).copy(pixels, row * 257 + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

const png = validPng();
const jpeg = await readFile(new URL("./fixtures/vision.jpg", import.meta.url));
const context = (cwd: string) => ({ cwd, maxOutputBytes: 8192, autoApprove: true });

function config(vision?: unknown): Promise<string> {
  return mkdtemp(join(tmpdir(), "raw-vision-config-")).then(async (directory) => {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ default_profile: "local", models: { local: {
      provider: "ollama", method: "openai-chat-completions", model_id: "fixture",
      ...(vision === undefined ? {} : { vision }),
    } }, profiles: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash", ...(vision === true ? ["builtin/view_image"] : [])] } } } }));
    return path;
  });
}

test("vision is opt-in, adds only view_image, and needs no image CLI flag", async () => {
  const plain = await loadConfig({ configPath: await config(), env: {}, requireModel: true });
  assert.equal(plain.profile?.vision, false);
  assert.deepEqual(createTestToolRegistry([], plain.profile?.vision).definitions().map((tool) => tool.name),
    ["read_file", "write_file", "bash"]);
  const enabled = await loadConfig({ configPath: await config(true), env: {}, requireModel: true });
  assert.equal(enabled.profile?.vision, true);
  assert.deepEqual(createTestToolRegistry([], enabled.profile?.vision).definitions().map((tool) => tool.name),
    ["read_file", "write_file", "bash", "view_image"]);
  await assert.rejects(loadConfig({ configPath: await config("yes"), env: {}, requireModel: true }), /vision/);
  assert.throws(() => parseCliArgs(["--image", "photo.png", "explain"]), /unknown option/);
});

test("view_image validates magic and size, resolves cwd, and keeps a >8 KiB native image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-view-image-"));
  await writeFile(join(cwd, "large.png"), png);
  await writeFile(join(cwd, "photo.jpg"), jpeg);
  await writeFile(join(cwd, "invalid.png"), "not an image");
  await writeFile(join(cwd, "truncated.png"), png.subarray(0, 8));
  await writeFile(join(cwd, "truncated.jpg"), jpeg.subarray(0, 16));
  const huge = join(cwd, "huge.png");
  await writeFile(huge, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await truncate(huge, 16 * 1024 * 1024 + 1);
  const registry = createTestToolRegistry([], true);
  const result = await registry.dispatch("view_image", { path: "large.png" }, context(cwd));
  assert.equal(result.isError, false);
  assert.equal(result.truncated, false);
  assert.equal(result.content[0]?.type, "image");
  if (result.content[0]?.type === "image") {
    assert.equal(result.content[0].mimeType, "image/png");
    assert.equal(result.content[0].data, png.toString("base64"));
    assert.ok(result.content[0].data.length > 8192);
  }
  const jpg = await registry.dispatch("view_image", { path: "photo.jpg" }, context(cwd));
  assert.equal(jpg.content[0]?.type === "image" ? jpg.content[0].mimeType : "", "image/jpeg");
  for (const name of ["invalid.png", "truncated.png", "truncated.jpg", "missing.png", "huge.png"]) {
    const invalid = await registry.dispatch("view_image", { path: name }, context(cwd));
    assert.equal(invalid.isError, true);
    assert.doesNotMatch(JSON.stringify(invalid), /iVBORw0KGgo/);
  }
  const denied = createTestToolRegistry([{ match: "builtin/view_image", effect: "deny" }], true);
  assert.ok(!denied.definitions().some((tool) => tool.name === "view_image"));
  assert.equal((await denied.dispatch("view_image", { path: "large.png" }, context(cwd))).code, "tool_denied");
});

test("view_image refuses a FIFO without waiting for a writer", { skip: process.platform === "win32" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-image-fifo-"));
  execFileSync("mkfifo", [join(cwd, "pipe.png")]);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "import {viewImageTool} from './src/tools/image.ts'; const result=await viewImageTool({path:'pipe.png'},{cwd:process.argv[1],maxOutputBytes:8192}); process.stdout.write(JSON.stringify({code:result.code,isError:result.isError}));",
    cwd], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  try {
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(stdout), { code: "image_read_error", isError: true });
  } finally { clearTimeout(timer); }
});

test("image rejection and non-vision errors respect the text output cap", async () => {
  const over = Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64");
  const { capResult } = await import("../src/tools/results.js");
  const capped = capResult({ isError: false, content: [{ type: "image", mimeType: "image/png", data: over }] }, 3);
  assert.equal(capped.code, "image_too_large");
  assert.ok(capped.content[0]?.type === "text" && Buffer.byteLength(capped.content[0].text) <= 3);
  const registry = createTestToolRegistry();
  registry.register({ name: "external_image", description: "fixture", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] }) });
  let turn = 0;
  const agent = createAgent({ provider: { profile: { name: "text", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    async generate() { return ++turn === 1
      ? { text: "", toolCalls: [{ id: "c", name: "external_image", arguments: {} }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" }; } }, registry, maxOutputBytes: 3 });
  await agent.run("inspect");
  const result = agent.transcript.find((message) => message.role === "tool");
  assert.equal(result?.role === "tool" ? result.result.code : "", "vision_disabled");
  assert.ok(result?.role === "tool" && result.result.content[0]?.type === "text"
    && Buffer.byteLength(result.result.content[0].text) <= 3);
});

test("real view_image result reaches each adapter as native image content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-vision-wire-"));
  await writeFile(join(cwd, "large.png"), png);
  const image = await createTestToolRegistry([], true).dispatch("view_image", { path: "large.png" }, context(cwd));
  const cases = [
    { method: "openai-chat-completions", provider: "openai", frames: [openAiFrame({ content: "done" }, "stop"), openAiDone],
      wire: "image_url" },
    { method: "openai-responses", provider: "openai", frames: [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
      response: { id: "r", object: "response", status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }] }], usage: null } })}\n\n`, "data: [DONE]\n\n"], wire: "input_image" },
    { method: "anthropic-messages", provider: "anthropic", frames: [
      anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "done" } }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      anthropicFrame("message_stop", {}),
    ], wire: "base64" },
    { method: "google-generate-content", provider: "google", frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] })],
      wire: "inlineData" },
  ];
  for (const scenario of cases) {
    const fixture = await startMockProvider([{ frames: scenario.frames }]);
    try {
      const adapter = createProvider({ name: "fixture", provider: scenario.provider, method: scenario.method as never,
        model: "fixture", baseUrl: fixture.url, apiKey: "fixture" });
      const response = await adapter.generate({ system: "tiny", messages: [
        { role: "user", content: "inspect large.png" },
        { role: "assistant", text: "", toolCalls: [{ id: "call", name: "view_image", arguments: { path: "large.png" } }] },
        { role: "tool", callId: "call", name: "view_image", result: image },
      ], tools: createTestToolRegistry([], true).definitions(), timeoutMs: 1000 });
      assert.equal(response.text, "done");
      const body = JSON.stringify(fixture.requests[0]?.body);
      assert.match(body, new RegExp(scenario.wire));
      assert.ok(body.includes(png.toString("base64").slice(0, 100)));
      if (scenario.method === "openai-chat-completions") {
        const messages = (fixture.requests[0]?.body as { messages: Array<{ role: string }> }).messages;
        const toolAt = messages.findIndex((item) => item.role === "tool");
        assert.equal(messages[toolAt + 1]?.role, "user");
      }
    } finally { await fixture.close(); }
  }
});

test("image bytes stay out of public tool-result events while transcript retains native image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-vision-event-"));
  await writeFile(join(cwd, "large.png"), png);
  let calls = 0;
  const seen: string[] = [];
  const provider = { profile: { name: "vision", provider: "ollama", method: "openai-chat-completions" as const,
    model: "fixture", vision: true }, async generate(request: { messages: readonly unknown[] }) {
    calls++;
    return calls === 1 ? { text: "", toolCalls: [{ id: "c", name: "view_image", arguments: { path: "large.png" } }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" };
  } };
  const agent = createAgent({ provider, registry: createTestToolRegistry([], true), cwd });
  await agent.run("inspect", (event) => { if (event.type === "tool_result") seen.push(JSON.stringify(event)); });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((value) => !value.includes(png.toString("base64").slice(0, 100))));
  const last = agent.transcript.find((message) => message.role === "tool");
  assert.equal(last?.role === "tool" && last.result.content[0]?.type === "image", true);
});

test("a text-only model receives MCP descriptions but no native image bytes", async () => {
  const connection = await connectMcpServers({ servers: { describe: { command: process.execPath,
    args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], tools: ["selected"] } }, cwd: process.cwd(), timeoutMs: 3000 });
  const alias = connection.exposed[0]!.alias;
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "text-call", type: "function",
      function: { name: alias, arguments: JSON.stringify({ value: "photo description" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "understood" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "image-call", type: "function",
      function: { name: alias, arguments: JSON.stringify({ value: "image" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "cannot view" }, "stop"), openAiDone] },
  ]);
  const agent = createAgent({ provider: createProvider({ name: "text", provider: "openai", method: "openai-chat-completions",
    model: "fixture", baseUrl: fixture.url, apiKey: "fixture", vision: false }), registry: connection.registry });
  try {
    assert.ok(!agent.toolDefinitions.some((tool) => tool.name === "view_image"));
    assert.equal((await agent.run("describe the photo")).text, "understood");
    assert.match(JSON.stringify(fixture.requests[1]?.body), /stdio:selected:photo description/);
    assert.doesNotMatch(JSON.stringify(fixture.requests[1]?.body), /image_url|iVBOR/);
    assert.equal((await agent.run("try the image tool")).text, "cannot view");
    assert.match(JSON.stringify(fixture.requests[3]?.body), /this model cannot receive image content/);
    assert.doesNotMatch(JSON.stringify(fixture.requests[3]?.body), /image_url|iVBOR/);
    const last = agent.transcript.filter((message) => message.role === "tool").at(-1);
    assert.equal(last?.role === "tool" ? last.result.code : "", "vision_disabled");
  } finally { await agent.close(); await fixture.close(); await connection.close(); }
});
