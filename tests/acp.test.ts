import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { client, PROTOCOL_VERSION, type ContentBlock } from "@agentclientprotocol/sdk";
import { loadConfig as loadConfigActual } from "../src/config.js";
import { testConfig } from "./fixtures/config.js";
import { createAcpServer } from "../src/acp/methods.js";
import { createProvider } from "../src/llm/client.js";
import { startMockProvider } from "./fixtures/mock-provider.js";
import type { ProviderRequest } from "../src/llm/types.js";

const configHome = mkdtempSync(join(tmpdir(), "raw-acp-test-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "raw-acp-test-state-"));
const loadConfig = (options: Parameters<typeof loadConfigActual>[0]) => loadConfigActual({ ...options, home: configHome });

test("runtime info exposes selected model/method/vision/MCP/policy without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-acp-runtime-"));
  const path = join(root, "config.json");
  const secret = "acp-literal-key-sentinel";
  await writeFile(path, JSON.stringify({ default_profile: "research",
    models: { flash: { provider: "deepseek", method: "openai-chat-completions", model_id: "deepseek-flash",
      base_url: "https://api.deepseek.com", api_key: secret, vision: true, context_window_tokens: 4096 } },
    profiles: { research: { model: "flash", mcp: { search: ["web_search"] },
      compact: { trigger_tokens: 1000, max_output_tokens: 100 },
      tools: { rules: [{ match: "bash", effect: "deny" }] } } },
    mcp: { servers: { search: { transport: "stdio", command: "unused", args: [] } } },
  }));
  const runtime = await loadConfig({ flags: { configPath: path }, env: {}, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: runtime.mcpServers, providerFactory: () => ({ profile: runtime.profile!,
    generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const connection = client({ name: "runtime-info-client" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { runtimeInfo: true } } });
    const info = await connection.agent.request<Record<string, unknown>>("_raw/runtime/info", {});
    for (const field of ["research", "flash", "deepseek-flash", "openai-chat-completions", "vision", "web_search", "deny", "triggerTokens"]) {
      assert.ok(JSON.stringify(info).includes(field), `missing runtime field ${field}`);
    }
    assert.doesNotMatch(JSON.stringify(info), new RegExp(secret));
  } finally { connection.close(); await server.close(); }
});

test("T-07 review: upstream SDK errors never expose credentials in ACP replies", async () => {
  const secret = "secret-api-key-sentinel";
  const fixture = await startMockProvider([{ status: 401, body: { error: { message: `bad credential ${secret}` } } }]);
  const runtime = await loadConfig({ flags: { configPath: testConfig("openai", "fixture", `${fixture.url}?token=${secret}`) },
    env: { OPENAI_API_KEY: secret }, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: createProvider });
  const connection = client({ name: "credential-client" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    await assert.rejects(connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] }),
      (error: Error) => !error.message.includes(secret) && /provider failed/.test(error.message));
  } finally { connection.close(); await server.close(); await fixture.close(); }
});

test("T-07 review: disconnect during MCP discovery reaps child and creates no provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-acp-mcp-disconnect-"));
  const pidFile = join(root, "mcp.pid");
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  let providers = 0;
  const server = createAcpServer({ runtime, mcpServers: { delayed: { command: process.execPath,
    args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"],
    env: { MCP_PID_FILE: pidFile, MCP_LIST_DELAY_MS: "800" }, tools: [] } },
  providerFactory: () => { providers++; return { profile: runtime.profile!, generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }; } });
  const connection = client({ name: "early-disconnect" }).connect(server.app);
  await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const pending = connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await access(pidFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(pid > 0);
  connection.close();
  await assert.rejects(pending);
  await server.close();
  assert.equal(providers, 0);
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("MCP child survived disconnect");
});

test("T-07 review: pending MCP startup cannot delay cancellation of an existing Bash", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-acp-close-race-"));
  const discoveryStarted = join(root, "discovery-started");
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) =>
    request.messages.at(-1)?.role === "tool" ? { text: "done", toolCalls: [], finishReason: "stop" }
      : { text: "", toolCalls: [{ id: "shell", name: "bash", arguments: { commands: [{ command: "sleep 0.3; printf late > marker" }] } }], finishReason: "tool_calls" } }) });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const peer = client({ name: "close-race" });
  peer.onNotification("session/update", ({ params }) => {
    if (params.update.sessionUpdate === "tool_call_update" && params.update.status === "in_progress") started();
  });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: root, mcpServers: [] });
    let startupSettled = false;
    const creating = connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [{ name: "slow", command: process.execPath,
      args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: [
        { name: "MCP_LIST_DELAY_MS", value: "900" }, { name: "MCP_LIST_STARTED_FILE", value: discoveryStarted }] }] });
    creating.then(() => { startupSettled = true; }, () => { startupSettled = true; });
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await access(discoveryStarted); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    await access(discoveryStarted);
    assert.equal(startupSettled, false);
    const prompting = connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run" }] });
    prompting.catch(() => {});
    await ready;
    connection.close();
    await server.close();
    await Promise.allSettled([creating, prompting]);
    await assert.rejects(access(join(root, "marker")));
  } finally { connection.close(); await server.close(); }
});

test("T-07 review: hidden MCP catalog can be selected while idle and appears on next inference", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  let requested: ProviderRequest | undefined;
  const server = createAcpServer({ runtime, mcpServers: { fixture: { command: process.execPath,
    args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], tools: [] } },
  providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => { requested = request; return { text: "ok", toolCalls: [], finishReason: "stop" }; } }) });
  const connection = client({ name: "catalog-client" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { runtimeInfo: true, sessionConfigure: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const before = await connection.agent.request<{ tools: Array<{ alias: string }>; mcpCatalog: Array<{ alias: string; exposed: boolean }> }>("_raw/runtime/info", { sessionId });
    assert.equal(before.mcpCatalog.length, 2);
    assert.ok(before.mcpCatalog.every((item) => !item.exposed));
    assert.equal(before.tools.length, 3);
    const alias = before.mcpCatalog[0]!.alias;
    await connection.agent.request("_raw/session/configure", { sessionId, tools: [alias] });
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    assert.deepEqual(requested?.tools.map((item) => item.name), [alias]);
    await connection.agent.request("_raw/session/configure", { sessionId, tools: [] });
    const after = await connection.agent.request<{ mcpCatalog: Array<{ alias: string; exposed: boolean }> }>("_raw/runtime/info", { sessionId });
    assert.equal(after.mcpCatalog.find((item) => item.alias === alias)?.exposed, false);
  } finally { connection.close(); await server.close(); }
});

test("T-07 review: unsupported hidden MCP schema does not block selected valid tool", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: { fixture: { command: process.execPath,
    args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: { MCP_MODE: "unsupported-hidden" }, tools: ["selected"] } },
  providerFactory: () => ({ profile: runtime.profile!, generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const connection = client({ name: "hidden-schema" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn");
  } finally { connection.close(); await server.close(); }
});

test("T-07 review: failed calls announce tool_call before tool_call_update", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => request.messages.at(-1)?.role === "tool"
    ? { text: "done", toolCalls: [], finishReason: "stop" }
    : { text: "", toolCalls: [{ id: "bad", name: "read_file", arguments: { path: 5 }, argumentError: "invalid json" }], finishReason: "tool_calls" } }) });
  const updates: Array<{ sessionUpdate: string; toolCallId?: string }> = [];
  const peer = client({ name: "failed-tool-client" });
  peer.onNotification("session/update", ({ params }) => { updates.push(params.update); });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "bad tool" }] });
    assert.deepEqual(updates.filter((item) => item.toolCallId === "bad").map((item) => item.sessionUpdate), ["tool_call", "tool_call_update"]);
  } finally { connection.close(); await server.close(); }
});

test("T-07 review: multi-megabyte reverse image validates without regex stack failure", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama", "fixture", undefined, undefined, true), autoApprove: true, maxOutputBytes: 8 * 1024 * 1024 },
    env: {}, requireModel: true });
  let alias = "";
  let imageSeen = false;
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      imageSeen = last.result.content[0]?.type === "image";
      return { text: "done", toolCalls: [], finishReason: "stop" };
    }
    return { text: "", toolCalls: [{ id: "large-image", name: alias, arguments: {} }], finishReason: "tool_calls" };
  } }) });
  const peer = client({ name: "large-image-client" });
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let index = 0; index < 8; index++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  const chunk = (type: string, body: Buffer): Buffer => {
    const kind = Buffer.from(type);
    const bytes = Buffer.concat([kind, body]);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
    const output = Buffer.alloc(body.length + 12);
    output.writeUInt32BE(body.length, 0);
    kind.copy(output, 4);
    body.copy(output, 8);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 8);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024, 0);
  header.writeUInt32BE(1024, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(1024 * (1 + 1024 * 4));
  for (let row = 0; row < 1024; row++) randomBytes(4096).copy(pixels, row * 4097 + 1);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  assert.ok(png.length > 4 * 1024 * 1024);
  const data = png.toString("base64");
  peer.onRequest("_raw/tool/call", (params: unknown) => params as object, () => ({ isError: false,
    content: [{ type: "image", mimeType: "image/png", data }] }));
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    alias = (await connection.agent.request<{ alias: string }>("_raw/tool/register", { sessionId, name: "large_image",
      description: "large image", inputSchema: { type: "object" } })).alias;
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "image" }] })).stopReason, "end_turn");
    assert.equal(imageSeen, true);
  } finally { connection.close(); await server.close(); }
});

test("T-07a/f: standard ACP works without raw negotiation and raw compact extension is capability gated", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const server = createAcpServer({ runtime, providerFactory: () => ({ profile: runtime.profile!,
    generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const peer = client({ name: "test" });
  const connection = peer.connect(server.app);
  const second = client({ name: "second-peer" }).connect(server.app);
  try {
    const init = await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(init.protocolVersion, 1);
    await assert.rejects(second.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }));
    await assert.rejects(connection.agent.request("_raw/session/compact", { sessionId: "missing" }));
  } finally { second.close(); connection.close(); await server.close(); }
});

test("T-07c/d: negotiated reverse tool executes through model history with typed image, error, validation and idle schema revision", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama", "fixture", undefined, undefined, true), autoApprove: true }, env: {}, requireModel: true });
  let alias = "";
  let calls = 0;
  let reply: unknown = { isError: false, content: [{ type: "text", text: "peer-sentinel" },
    { type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") }] };
  const requests: ProviderRequest[] = [];
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => {
    requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { text: last.result.isError ? `error:${last.result.code}` : "peer-sentinel received", toolCalls: [], finishReason: "stop" };
    if (alias) return { text: "", toolCalls: [{ id: `call-${requests.length}`, name: alias, arguments: { value: "go" } }], finishReason: "tool_calls" };
    return { text: "no alias", toolCalls: [], finishReason: "stop" };
  } }) });
  const peer = client({ name: "reverse-client" });
  peer.onRequest("_raw/tool/call", (params: unknown) => params as { toolId: string; arguments: { value: string } }, ({ params }) => {
    calls++;
    assert.equal(params.arguments.value, "go");
    return reply;
  });
  peer.onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow" } }));
  const connection = peer.connect(server.app);
  try {
    const init = await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { runtimeInfo: true, sessionConfigure: true, toolRegister: true, toolCall: true, sessionCompact: true } } });
    assert.equal((init._meta?.raw as { toolRegister: boolean }).toolRegister, true);
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const registration = await connection.agent.request<{ toolId: string; alias: string; schemaRevision: number }>("_raw/tool/register",
      { sessionId, name: "visual", description: "Returns an image", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } });
    alias = registration.alias;
    assert.ok(alias.length <= 64);
    const configured = await connection.agent.request<{ schemaRevision: number; tools: string[] }>("_raw/session/configure", { sessionId, tools: [alias] });
    assert.equal(configured.schemaRevision, registration.schemaRevision + 1);
    assert.deepEqual(configured.tools, [alias]);
    const info = await connection.agent.request<{ tools: Array<{ alias: string }> }>("_raw/runtime/info", { sessionId });
    assert.deepEqual(info.tools.map((item) => item.alias), [alias]);
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "call visual" }] })).stopReason, "end_turn");
    assert.equal(calls, 1);
    assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), [alias]);
    const imageResult = requests[1]?.messages.at(-1);
    assert.equal(imageResult?.role, "tool");
    if (imageResult?.role === "tool") assert.equal(imageResult.result.content.some((item) => item.type === "image"), true);
    reply = { isError: false, content: [{ type: "json", value: { answer: 42 } }] };
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "json call" }] })).stopReason, "end_turn");
    const jsonResult = requests.at(-1)?.messages.at(-1);
    assert.equal(jsonResult?.role, "tool");
    if (jsonResult?.role === "tool") assert.deepEqual(jsonResult.result.content, [{ type: "json", value: { answer: 42 } }]);
    reply = { isError: true, content: [{ type: "text", text: "peer-failure" }] };
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "error call" }] })).stopReason, "end_turn");
    assert.equal(calls, 3);
    await assert.rejects(connection.agent.request("_raw/tool/register", { sessionId, name: "visual", description: "duplicate", inputSchema: { type: "object" } }),
      (error: { code: number }) => error.code === -32008);
  } finally { connection.close(); await server.close(); }
});

test("T-07c: reverse callback timeout becomes matching tool error and late answer cannot overwrite history", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true, requestTimeoutMs: 50 }, env: {}, requireModel: true });
  let alias = "";
  let finish!: (value: unknown) => void;
  const late = new Promise<unknown>((resolve) => { finish = resolve; });
  const requests: ProviderRequest[] = [];
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => {
    requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
    if (request.messages.at(-1)?.role === "tool") return { text: "handled timeout", toolCalls: [], finishReason: "stop" };
    return { text: "", toolCalls: [{ id: "c", name: alias, arguments: { value: "x" } }], finishReason: "tool_calls" };
  } }) });
  const peer = client({ name: "slow-reverse" });
  peer.onRequest("_raw/tool/call", (params: unknown) => params as object, () => late);
  let cancelled = 0;
  peer.onNotification("_raw/tool/cancel", (params: unknown) => params as object, () => { cancelled++; });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true, toolCancel: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    alias = (await connection.agent.request<{ alias: string }>("_raw/tool/register", { sessionId, name: "slow", description: "slow callback", inputSchema: { type: "object", properties: { value: { type: "string" } } } })).alias;
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "call" }] })).stopReason, "end_turn");
    const prior = JSON.stringify(requests.at(-1)?.messages);
    assert.match(prior, /callback_timeout/);
    assert.equal(cancelled, 1);
    finish({ isError: false, content: [{ type: "text", text: "late-success" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(requests.at(-1)?.messages), prior);
  } finally { connection.close(); await server.close(); }
});

test("T-07c/d: cancelling pending reverse callback notifies peer and late reply cannot alter resumable history", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  let alias = "";
  let modelCalls = 0;
  let resumed: ProviderRequest["messages"] | undefined;
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => {
    modelCalls++;
    if (modelCalls === 1) return { text: "", toolCalls: [{ id: "reverse", name: alias, arguments: { value: "wait" } }], finishReason: "tool_calls" };
    resumed = structuredClone(request.messages);
    return { text: "resumed", toolCalls: [], finishReason: "stop" };
  } }) });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (value: unknown) => void;
  const waiting = new Promise<unknown>((resolve) => { finish = resolve; });
  let cancels = 0;
  const peer = client({ name: "cancel-reverse" });
  peer.onRequest("_raw/tool/call", (params: unknown) => params as object, () => { entered(); return waiting; });
  peer.onNotification("_raw/tool/cancel", (params: unknown) => params as object, () => { cancels++; });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true, toolCancel: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    alias = (await connection.agent.request<{ alias: string }>("_raw/tool/register", { sessionId, name: "waiter",
      description: "waits", inputSchema: { type: "object", properties: { value: { type: "string" } } } })).alias;
    const pending = connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "call" }] });
    await ready;
    await connection.agent.notify("session/cancel", { sessionId });
    assert.equal((await pending).stopReason, "cancelled");
    finish({ isError: false, content: [{ type: "text", text: "late-success" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancels, 1);
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "resume" }] })).stopReason, "end_turn");
    const history = JSON.stringify(resumed);
    assert.match(history, /cancelled/);
    assert.doesNotMatch(history, /late-success/);
  } finally { connection.close(); await server.close(); }
});

test("T-07d: independent session cwd/results and cross-peer ownership hold during concurrent prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-acp-sessions-"));
  const dirs = [join(root, "one"), join(root, "two")];
  await Promise.all(dirs.map((dir) => mkdir(dir)));
  await writeFile(join(dirs[0]!, "sentinel.txt"), "session-one");
  await writeFile(join(dirs[1]!, "sentinel.txt"), "session-two");
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  const observed: string[] = [];
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      observed.push(JSON.stringify(last.result));
      return { text: "done", toolCalls: [], finishReason: "stop" };
    }
    return { text: "", toolCalls: [{ id: "read", name: "read_file", arguments: { files: [{ path: "sentinel.txt" }] } }], finishReason: "tool_calls" };
  } }) });
  const server = makeServer();
  const peer = client({ name: "one-peer" });
  const connection = peer.connect(server.app);
  const otherServer = makeServer();
  const otherPeer = client({ name: "other-peer" });
  const other = otherPeer.connect(otherServer.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await other.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const first = await connection.agent.request("session/new", { cwd: dirs[0]!, mcpServers: [] });
    const second = await connection.agent.request("session/new", { cwd: dirs[1]!, mcpServers: [] });
    const replies = await Promise.all([first, second].map((session) => connection.agent.request("session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: "read" }] })));
    assert.deepEqual(replies.map((item) => item.stopReason), ["end_turn", "end_turn"]);
    assert.ok(observed.some((item) => item.includes("session-one")) && observed.some((item) => item.includes("session-two")));
    await assert.rejects(other.agent.request("session/prompt", { sessionId: first.sessionId, prompt: [{ type: "text", text: "steal" }] }),
      (error: { code: number }) => error.code === -32001);
  } finally { connection.close(); other.close(); await server.close(); await otherServer.close(); }
});

test("T-07d: cancel services pending permission while prompt is blocked and prevents write side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-acp-permission-"));
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: false }, env: {}, requireModel: true });
  let requests = 0;
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async () => {
    requests++;
    return { text: "", toolCalls: [{ id: "write", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "created.txt", content: "should-not-exist" }] } }], finishReason: "tool_calls" };
  } }) });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const peer = client({ name: "permission-client" });
  peer.onRequest("session/request_permission", () => { entered(); return new Promise<never>(() => {}); });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, _meta: { raw: { sessionConfigure: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: root, mcpServers: [] });
    const prompt = connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write" }] });
    await ready;
    await assert.rejects(connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "busy" }] }),
      (error: { code: number }) => error.code === -32002);
    await assert.rejects(connection.agent.request("_raw/session/configure", { sessionId, tools: [] }),
      (error: { code: number }) => error.code === -32002);
    await connection.agent.notify("session/cancel", { sessionId });
    assert.equal((await Promise.race([prompt, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel deadlocked")), 500))])).stopReason, "cancelled");
    assert.equal(requests, 1);
    await assert.rejects(access(join(root, "created.txt")));
  } finally { connection.close(); await server.close(); }
});

test("T-07d: peer disconnect aborts active Bash before delayed filesystem side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-acp-disconnect-"));
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async () => ({
    text: "", toolCalls: [{ id: "shell", name: "bash", arguments: { commands: [{ command: "sleep 0.5; printf late > sentinel.txt" }] } }], finishReason: "tool_calls",
  }) }) });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const peer = client({ name: "disconnect-client" });
  peer.onNotification("session/update", ({ params }) => { if (params.update.sessionUpdate === "tool_call") started(); });
  const connection = peer.connect(server.app);
  await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await connection.agent.request("session/new", { cwd: root, mcpServers: [] });
  const pending = connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run" }] });
  await ready;
  connection.close();
  await assert.rejects(pending);
  await server.close();
  await new Promise((resolve) => setTimeout(resolve, 650));
  await assert.rejects(access(join(root, "sentinel.txt")));
});

test("T-07f: compact extension delegates to atomic session compact and returns status/usage", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  let summaries = 0;
  let summaryText = "Task objective and chosen constraints remain.";
  let postCompactMessages: ProviderRequest["messages"] | undefined;
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!, generate: async (request) => {
    if (request.system.startsWith("Summarize prior conversation")) {
      summaries++;
      return { text: summaryText, toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 40, completion_tokens: 10 } };
    }
    postCompactMessages = structuredClone(request.messages);
    return { text: `old answer ${"x".repeat(500)}`, toolCalls: [], finishReason: "stop" };
  } }) });
  const peer = client({ name: "compact-client" });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { sessionCompact: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const originalLink = { type: "resource_link" as const, uri: "https://example.test/original", name: "original-ref", title: "Original reference" };
    const prompts: ContentBlock[][] = [[{ type: "text", text: "original objective" }, originalLink],
      ...["decision", "recent", "latest"].map((text) => [{ type: "text" as const, text }])];
    for (const prompt of prompts) {
      assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt })).stopReason, "end_turn");
    }
    const compacted = await connection.agent.request<{ status: string; beforeBytes: number; afterBytes: number; usage: unknown }>("_raw/session/compact", { sessionId });
    assert.equal(compacted.status, "compacted");
    assert.ok(compacted.afterBytes < compacted.beforeBytes);
    assert.deepEqual(compacted.usage, { prompt_tokens: 40, completion_tokens: 10 });
    assert.equal((await connection.agent.request<{ status: string }>("_raw/session/compact", { sessionId })).status, "noop");
    assert.equal(summaries, 1);
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] })).stopReason, "end_turn");
    const pinned = postCompactMessages?.[0];
    assert.equal(pinned?.role, "user");
    if (pinned?.role === "user") assert.deepEqual(pinned.content, [{ type: "text", text: "original objective" }, originalLink]);
    const beforeFailed = structuredClone(postCompactMessages);
    summaryText = "";
    await assert.rejects(connection.agent.request("_raw/session/compact", { sessionId }),
      (error: { code: number }) => error.code === -32007);
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "after failure" }] })).stopReason, "end_turn");
    assert.deepEqual(postCompactMessages?.slice(0, beforeFailed?.length), beforeFailed);
    await assert.rejects(connection.agent.request("_raw/session/compact", { sessionId: "missing" }),
      (error: { code: number }) => error.code === -32001);
  } finally { connection.close(); await server.close(); }
});
