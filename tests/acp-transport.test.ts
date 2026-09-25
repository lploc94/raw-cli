import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { client, ndJsonStream, PROTOCOL_VERSION, type ContentBlock } from "@agentclientprotocol/sdk";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import WebSocket from "ws";
import { serveAcpWebSocket } from "../src/acp/transport.js";
import { createAcpServer } from "../src/acp/methods.js";
import { createAcpClient } from "../src/acp/client.js";
import { loadConfig as loadConfigActual } from "../src/config.js";
import { testConfig } from "./fixtures/config.js";

const configHome = mkdtempSync(join(tmpdir(), "raw-acp-transport-test-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "raw-acp-transport-test-state-"));
const loadConfig = (options: Parameters<typeof loadConfigActual>[0]) => loadConfigActual({ ...options, home: configHome });
const assertNoAcpDiagnostics = (stderr: string) => assert.equal(stderr.replace(
  /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\n\(Use `node --trace-warnings[^\n]*\n/g, ""), "");

test("T-07a: independent ACP SDK client talks to raw daemon with text, resource-only and mixed prompts", async () => {
  const fixture = await startMockProvider(Array.from({ length: 3 }, () => ({ frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] })));
  const cwd = await mkdtemp(join(tmpdir(), "raw-acp-standard-"));
  const child = spawn(process.execPath, ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("openai", "fixture", fixture.url), "-y"],
    { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("stdio unavailable");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const updates: string[] = [];
  const peer = client({ name: "independent-test-client" });
  peer.onNotification("session/update", ({ params }) => { updates.push(params.update.sessionUpdate); });
  peer.onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow" } }));
  const connection = peer.connect(ndJsonStream(Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>));
  try {
    const init = await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.equal(init.agentCapabilities?.promptCapabilities?.image, undefined);
    const session = await connection.agent.request("session/new", { cwd, mcpServers: [] });
    const link = { type: "resource_link" as const, uri: "https://example.test/doc", name: "api-doc", title: "API docs",
      description: "reference", mimeType: "text/plain", size: 123, annotations: { priority: 0.5 } };
    const prompts: ContentBlock[][] = [
      [{ type: "text" as const, text: "first task" }],
      [link],
      [{ type: "text" as const, text: "before" }, link, { type: "text" as const, text: "after" }],
    ];
    for (const prompt of prompts) assert.equal((await connection.agent.request("session/prompt", { sessionId: session.sessionId, prompt })).stopReason, "end_turn");
    assert.equal(fixture.requests.length, 3);
    assert.ok(updates.includes("agent_message_chunk"));
    const thirdMessages = (fixture.requests[2]?.body as { messages: Array<{ role: string; content?: unknown }> }).messages;
    const third = JSON.stringify(thirdMessages.at(-1)?.content);
    for (const value of ["before", "after", link.uri, link.name, link.title, link.description, link.mimeType, "123", "0.5"]) assert.ok(third.includes(value));
    assert.ok(third.indexOf("before") < third.indexOf(link.uri) && third.indexOf(link.uri) < third.indexOf("after"));
    await assert.rejects(connection.agent.request("session/prompt", { sessionId: session.sessionId,
      prompt: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }),
    (error: { code: number }) => error.code === -32602);
    assert.equal(fixture.requests.length, 3);
    assert.doesNotMatch(stderr, /error/i);
  } finally {
    connection.close();
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (child.exitCode === null) child.kill("SIGTERM");
    await fixture.close();
  }
});

test("standard saved-session transcript crosses stdio and WebSocket peers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-acp-cross-transport-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ content: "transport-sentinel" }, "stop"), openAiDone] }]);
  const config = testConfig("openai", "fixture", fixture.url);
  const liveUpdates: string[] = [];
  const first = await createAcpClient({ command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), "--acp", "--stdio", "--config", config],
    env: { ...process.env, OPENAI_API_KEY: "key" },
    onUpdate: ({ update }) => { if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") liveUpdates.push(update.content.text); } });
  let id!: string;
  try {
    id = await first.newSession(cwd);
    assert.equal((await first.prompt(id, "transport question")).stopReason, "end_turn");
    assert.equal(liveUpdates.join(""), "transport-sentinel");
  } finally { await first.close(); }
  const runtime = await loadConfig({ flags: { configPath: config }, env: { OPENAI_API_KEY: "key" }, requireModel: true });
  const listener = await serveAcpWebSocket({ host: "127.0.0.1", port: 0,
    serverFactory: () => createAcpServer({ runtime, mcpServers: {} }) });
  const replayUpdates: string[] = [];
  try {
    const second = await createAcpClient({ url: `ws://127.0.0.1:${listener.port}/`,
      onUpdate: ({ update }) => { if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") replayUpdates.push(update.content.text); } });
    try {
      assert.equal((await second.listSessions(cwd)).sessions[0]?.sessionId, id);
      await second.loadSession(id, cwd);
      assert.equal(replayUpdates.join(""), liveUpdates.join(""));
    } finally { await second.close(); }
  } finally { await listener.close(); await fixture.close(); }
});

test("T-07b: malformed stdio JSON produces one parse error frame and no diagnostic stdout", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("ollama"), "-y"],
    { cwd: process.cwd(), input: "{bad json}\n", encoding: "utf8", timeout: 3000 });
  assert.equal(child.status, 0);
  assertNoAcpDiagnostics(child.stderr);
  assert.deepEqual(child.stdout.trim().split("\n").map((line) => JSON.parse(line)),
    [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
});

test("T-07e: local WebSocket supports parent client, rejects browser Origin/binary/oversize and reports parse errors", async () => {
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: true }, env: {}, requireModel: true });
  await assert.rejects(serveAcpWebSocket({ host: "0.0.0.0", port: 0, serverFactory: () => createAcpServer({ runtime }) }), /loopback/);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const listener = await serveAcpWebSocket({ host: "127.0.0.1", port: 0,
    serverFactory: () => createAcpServer({ runtime, mcpServers: {}, providerFactory: () => ({ profile: runtime.profile!,
      generate: async (request) => {
        if (JSON.stringify(request.messages.at(-1)).includes("hang")) { entered(); return new Promise<never>(() => {}); }
        return { text: "ws-answer", toolCalls: [], finishReason: "stop" };
      } }) }) });
  const url = `ws://127.0.0.1:${listener.port}/`;
  try {
    const parent = await createAcpClient({ url });
    try {
      const sessionId = await parent.newSession(process.cwd());
      assert.equal((await parent.prompt(sessionId, "hello")).stopReason, "end_turn");
      const pending = parent.prompt(sessionId, "hang");
      await ready;
      await parent.cancel(sessionId);
      assert.equal((await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("WS cancel deadlocked")), 500))])).stopReason, "cancelled");
    } finally { await parent.close(); }

    const invalid = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { invalid.once("open", resolve); invalid.once("error", reject); });
    invalid.send("{bad json");
    const parseError = await new Promise<{ error: { code: number } }>((resolve) => invalid.once("message", (data) => resolve(JSON.parse(data.toString()))));
    assert.equal(parseError.error.code, -32700);
    invalid.send("123");
    const invalidRequest = await new Promise<{ error: { code: number } }>((resolve) => invalid.once("message", (data) => resolve(JSON.parse(data.toString()))));
    assert.equal(invalidRequest.error.code, -32600);
    invalid.send(Buffer.from([1, 2, 3]), { binary: true });
    const binaryCode = await new Promise<number>((resolve) => invalid.once("close", resolve));
    assert.equal(binaryCode, 1003);

    const oversized = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { oversized.once("open", resolve); oversized.once("error", reject); });
    oversized.send("x".repeat(16 * 1024 * 1024 + 1));
    const sizeCode = await new Promise<number>((resolve) => oversized.once("close", resolve));
    assert.equal(sizeCode, 1009);

    const browser = new WebSocket(url, { headers: { Origin: "https://example.test" } });
    browser.on("error", () => {});
    const rejected = await new Promise<string>((resolve) => browser.once("unexpected-response", (_req, response) => resolve(String(response.statusCode))));
    assert.equal(rejected, "403");
    if (browser.readyState === WebSocket.OPEN) browser.close();
  } finally { await listener.close(); }
});

test("T-07b: stdio handles split/coalesced JSON-RPC frames, notifications, invalid params and version negotiation", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("ollama"), "-y"],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("stdio unavailable");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const lines: Array<{ id?: number | null; result?: Record<string, unknown>; error?: { code: number } }> = [];
  const pending = new Map<number | null, (line: (typeof lines)[number]) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const frame = JSON.parse(line) as (typeof lines)[number];
    const resolve = pending.get(frame.id ?? null);
    if (resolve) { pending.delete(frame.id ?? null); resolve(frame); }
    else lines.push(frame);
  });
  const wait = (id: number | null) => {
    const found = lines.findIndex((line) => (line.id ?? null) === id);
    if (found >= 0) return Promise.resolve(lines.splice(found, 1)[0]!);
    return Promise.race([new Promise<(typeof lines)[number]>((resolve) => pending.set(id, resolve)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`no ACP frame ${id}; stderr=${stderr}`)), 2000))]);
  };
  try {
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 999, clientCapabilities: {} } });
    child.stdin.write(initialize.slice(0, 15));
    child.stdin.write(`${initialize.slice(15)}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown/method", params: {} })}\n`);
    assert.equal((await wait(1)).result?.protocolVersion, 1);
    assert.equal((await wait(2)).error?.code, -32601);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "unknown" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "relative", mcpServers: [] } })}\n`);
    assert.equal((await wait(3)).error?.code, -32602);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "missing", prompt: [{ type: "text", text: "hi" }] } })}\n`);
    assert.equal((await wait(4)).error?.code, -32001);
    assert.equal(lines.length, 0);
    assertNoAcpDiagnostics(stderr);
  } finally { rl.close(); child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM"); }
});

test("T-07a: standard session/new MCP server is an explicit selection and executes without raw extensions", async () => {
  const responses = [{ frames: [openAiFrame({ content: "ready" }, "stop"), openAiDone] }];
  const fixture = await startMockProvider(responses);
  const child = spawn(process.execPath, ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("openai", "fixture", fixture.url), "-y"],
    { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("stdio unavailable");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const peer = client({ name: "standard-mcp-client" });
  const connection = peer.connect(ndJsonStream(Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>));
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [{ name: "browser",
      command: process.execPath, args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: [{ name: "MCP_LABEL", value: "IDE" }] }] });
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] })).stopReason, "end_turn");
    const initial = fixture.requests[0]?.body as { tools: Array<{ function: { name: string } }> };
    assert.equal(initial.tools.length, 5);
    const alias = initial.tools.find((tool) => tool.function.name.includes("selected"))?.function.name;
    assert.ok(alias);
    responses.push({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "mcp-call", type: "function",
      function: { name: alias, arguments: '{"value":"from-ide"}' } }] }, "tool_calls"), openAiDone] });
    responses.push({ frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] });
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "use browser" }] })).stopReason, "end_turn");
    assert.match(JSON.stringify((fixture.requests[2]?.body as { messages: unknown[] }).messages), /IDE:selected:from-ide/);
    assertNoAcpDiagnostics(stderr);
  } finally { connection.close(); child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM"); await fixture.close(); }
});
