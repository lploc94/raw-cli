import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { client, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk";
import { createAcpServer } from "../src/acp/methods.js";
import { loadConfig } from "../src/config.js";
import type { ProviderRequest } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { testConfig } from "./fixtures/config.js";

test("standard ACP list, load replay, resume without replay, and delete survive server restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const requests: ProviderRequest[] = [];
  const factory = () => ({ modelConfig: runtime.modelConfig!, generate: async (request: ProviderRequest) => {
    requests.push(request);
    return { text: `answer-${requests.length}`, toolCalls: [], finishReason: "stop" as const };
  } });
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, providerFactory: factory, storeOptions });

  const first = makeServer();
  const firstConnection = client({ name: "first" }).connect(first.app);
  let id: string;
  try {
    const init = await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.list);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.resume);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.delete);
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    assert.equal((await firstConnection.agent.request("session/prompt", { sessionId: id,
      prompt: [{ type: "text", text: "first question" }] })).stopReason, "end_turn");
  } finally { firstConnection.close(); await first.close(); }

  const second = makeServer();
  const updates: SessionUpdate[] = [];
  const secondPeer = client({ name: "second" });
  let duringReplay: Promise<unknown> | undefined;
  secondPeer.onNotification("session/update", ({ params }) => {
    updates.push(params.update);
    if (!duringReplay) duringReplay = secondConnection.agent.request("session/prompt", { sessionId: id,
      prompt: [{ type: "text", text: "too early" }] }).catch((error: unknown) => error);
  });
  const secondConnection = secondPeer.connect(second.app);
  try {
    await secondConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const listed = await secondConnection.agent.request("session/list", { cwd: root });
    assert.equal(listed.sessions[0]?.sessionId, id);
    await secondConnection.agent.request("session/load", { sessionId: id, cwd: root, mcpServers: [] });
    assert.match(String(await duringReplay), /busy/i);
    assert.equal(requests.length, 1);
    assert.ok(updates.some((update) => update.sessionUpdate === "agent_message_chunk"
      && update.content.type === "text" && update.content.text === "answer-1"));
    assert.equal((await secondConnection.agent.request("session/prompt", { sessionId: id,
      prompt: [{ type: "text", text: "second question" }] })).stopReason, "end_turn");
    assert.match(JSON.stringify(requests[1]?.messages), /first question/);
    assert.match(JSON.stringify(requests[1]?.messages), /answer-1/);
  } finally { secondConnection.close(); await second.close(); }

  const third = makeServer();
  const thirdPeer = client({ name: "third" });
  const thirdUpdates: SessionUpdate[] = [];
  thirdPeer.onNotification("session/update", ({ params }) => { thirdUpdates.push(params.update); });
  const thirdConnection = thirdPeer.connect(third.app);
  try {
    await thirdConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await thirdConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] });
    assert.equal(thirdUpdates.length, 0);
  } finally { thirdConnection.close(); await third.close(); }

  const fourth = makeServer();
  const fourthConnection = client({ name: "fourth" }).connect(fourth.app);
  try {
    await fourthConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await fourthConnection.agent.request("session/delete", { sessionId: id });
    assert.equal((await fourthConnection.agent.request("session/list", { cwd: root })).sessions.length, 0);
  } finally { fourthConnection.close(); await fourth.close(); }
});

test("ACP list pages older IDs and rejects wrong cwd, unknown IDs, and a second writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-pages-"));
  const other = mkdtempSync(join(tmpdir(), "raw-session-acp-other-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-pages-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, storeOptions,
    providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const first = makeServer();
  const firstConnection = client({ name: "page-owner" }).connect(first.app);
  const second = makeServer();
  const secondConnection = client({ name: "page-contender" }).connect(second.app);
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await secondConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const ids: string[] = [];
    for (let index = 0; index < 25; index++) ids.push((await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId);
    const firstPage = await secondConnection.agent.request("session/list", { cwd: root });
    assert.equal(firstPage.sessions.length, 20);
    assert.ok(firstPage.nextCursor);
    const secondPage = await secondConnection.agent.request("session/list", { cwd: root, cursor: firstPage.nextCursor });
    assert.equal(secondPage.sessions.length, 5);
    assert.deepEqual(new Set([...firstPage.sessions, ...secondPage.sessions].map((item) => item.sessionId)), new Set(ids));
    const older = secondPage.sessions[0]!.sessionId;
    const marker = join(state, "busy-mcp.pid");
    await assert.rejects(secondConnection.agent.request("session/resume", { sessionId: older, cwd: root, mcpServers: [{
      name: "fixture", command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/mcp-stdio.ts")],
      env: [{ name: "MCP_PID_FILE", value: marker }],
    }] }), /busy/i);
    assert.equal(existsSync(marker), false, "a busy resume must not launch MCP");
    await assert.rejects(secondConnection.agent.request("session/delete", { sessionId: older }), /busy/i);
    await assert.rejects(secondConnection.agent.request("session/resume", { sessionId: older, cwd: other, mcpServers: [] }), /cwd/i);
    await assert.rejects(secondConnection.agent.request("session/resume", { sessionId: "missing", cwd: root, mcpServers: [] }), /unknown|expired/i);
    await assert.rejects(secondConnection.agent.request("session/list", { cwd: root, cursor: "bad" }), /cursor|invalid/i);
    assert.equal((await secondConnection.agent.request("session/list", { cwd: other })).sessions.length, 0);
  } finally { firstConnection.close(); await first.close(); }
  try {
    const older = (await secondConnection.agent.request("session/list", { cwd: root })).sessions[0]!.sessionId;
    await secondConnection.agent.request("session/resume", { sessionId: older, cwd: root, mcpServers: [] });
  } finally { secondConnection.close(); await second.close(); }
});

test("ACP rejects an expired ID without contacting a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-expired-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-expired-state-"));
  let now = Date.now();
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state }, now: () => now };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  let providers = 0;
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, storeOptions, providerFactory: () => {
    providers++;
    return { modelConfig: runtime.modelConfig!, generate: async () => ({ text: "never", toolCalls: [], finishReason: "stop" }) };
  } });
  const first = makeServer();
  const firstConnection = client({ name: "expiry-first" }).connect(first.app);
  let id!: string;
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
  } finally { firstConnection.close(); await first.close(); }
  now += 7 * 86_400_000;
  const second = makeServer();
  const connection = client({ name: "expiry-second" }).connect(second.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal((await connection.agent.request("session/list", { cwd: root })).sessions.length, 0);
    await assert.rejects(connection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] }), /unknown|expired/i);
    assert.equal(providers, 1);
  } finally { connection.close(); await second.close(); }
});

test("a long-lived ACP peer re-reads canonical retention after a config change", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-policy-"));
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "raw"), { recursive: true });
  const canonical = join(configHome, "raw", "config.json");
  writeFileSync(canonical, '{"sessions":{"retention_days":7}}');
  let now = 1_800_000_000_000;
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: configHome }, now: () => now };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: storeOptions.env, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, storeOptions,
    providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const connection = client({ name: "policy-reload" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const id = (await connection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    now += 2 * 86_400_000;
    assert.equal((await connection.agent.request("session/list", { cwd: root })).sessions[0]?.sessionId, id);
    writeFileSync(canonical, '{"sessions":{"retention_days":1}}');
    assert.equal((await connection.agent.request("session/list", { cwd: root })).sessions.length, 0);
  } finally { connection.close(); await server.close(); }
});

test("ACP shutdown reclaims expired pages after releasing its session claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-reclaim-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-reclaim-state-"));
  let now = 1_800_000_000_000;
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state }, now: () => now };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const seed = openSessionStore(storeOptions);
  const expired = seed.createSession({ cwd: root, title: "expired" }).id;
  for (let index = 0; index < 80; index++) seed.appendHistory({ sessionId: expired, kind: "status",
    payload: { text: `large-${index}-` + "x".repeat(50_000) } });
  now += 8 * 86_400_000;
  const recent = seed.createSession({ cwd: root, title: "recent", configPath: runtime.configPath,
    agentName: runtime.modelConfig!.agentName }).id;
  seed.close();
  const server = createAcpServer({ runtime, mcpServers: {}, storeOptions,
    providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const connection = client({ name: "reclaim" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await connection.agent.request("session/resume", { sessionId: recent, cwd: root, mcpServers: [] });
  } finally { connection.close(); await server.close(); }
  const check = openSessionStore(storeOptions);
  try {
    assert.equal(Number(check.database.prepare("PRAGMA freelist_count").get()?.freelist_count), 0);
    assert.ok(check.getSession(recent));
  } finally { check.close(); }
});

test("ACP reports maintenance contention as busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-maintenance-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-maintenance-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const seed = openSessionStore(storeOptions);
  const id = seed.createSession({ cwd: root, title: "fenced", configPath: runtime.configPath,
    agentName: runtime.modelConfig!.agentName }).id;
  seed.database.prepare("INSERT INTO store_meta(key, value) VALUES ('maintenance_owner', ?)").run(`${process.pid}-test`);
  const server = createAcpServer({ runtime, mcpServers: {}, storeOptions,
    providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }) }) });
  const connection = client({ name: "maintenance" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await assert.rejects(connection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] }),
      (error: unknown) => error instanceof Error && /busy/i.test(error.message) && !/internal error/i.test(error.message));
    await assert.rejects(connection.agent.request("session/new", { cwd: root, mcpServers: [] }),
      (error: unknown) => error instanceof Error && /busy/i.test(error.message) && !/internal error/i.test(error.message));
  } finally {
    connection.close();
    await server.close();
    seed.database.prepare("DELETE FROM store_meta WHERE key = 'maintenance_owner'").run();
    seed.close();
  }
});

test("ACP configured MCP alias survives restart and missing alias fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-selection-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-selection-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const fixture = { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/mcp-stdio.ts")], tools: [] };
  const requests: ProviderRequest[] = [];
  const makeServer = (withMcp: boolean) => createAcpServer({ runtime, storeOptions,
    mcpServers: withMcp ? { fixture } : {}, providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async (request) => {
      requests.push(request);
      return { text: "ok", toolCalls: [], finishReason: "stop" };
    } }) });
  const first = makeServer(true);
  const firstConnection = client({ name: "selection-first" }).connect(first.app);
  let id!: string;
  let alias!: string;
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { runtimeInfo: true, sessionConfigure: true } } });
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    const info = await firstConnection.agent.request<{ mcpCatalog: Array<{ alias: string }> }>("_raw/runtime/info", { sessionId: id });
    alias = info.mcpCatalog[0]!.alias;
    await firstConnection.agent.request("_raw/session/configure", { sessionId: id, tools: [alias] });
    await firstConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "one" }] });
    assert.deepEqual(requests[0]?.tools.map((item) => item.name), [alias]);
  } finally { firstConnection.close(); await first.close(); }
  const missing = makeServer(false);
  const missingConnection = client({ name: "selection-missing" }).connect(missing.app);
  try {
    await missingConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await assert.rejects(missingConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] }), /unknown MCP alias|schema|selection/i);
    assert.equal(requests.length, 1);
  } finally { missingConnection.close(); await missing.close(); }
  const second = makeServer(true);
  const secondConnection = client({ name: "selection-second" }).connect(second.app);
  try {
    await secondConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await secondConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] });
    await secondConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "two" }] });
    assert.deepEqual(requests[1]?.tools.map((item) => item.name), [alias]);
  } finally { secondConnection.close(); await second.close(); }
});

test("ACP load replays complete raw tool input and output without dispatching the historical call", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-raw-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-raw-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const command = "printf " + "r".repeat(70_000);
  const args = { commands: [{ command, extra: true }] };
  let calls = 0;
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, storeOptions,
    providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async () => {
      calls++;
      return calls === 1 ? { text: "", toolCalls: [{ id: "invalid-bash", name: "bash", arguments: args }], finishReason: "tool_calls" }
        : { text: "done", toolCalls: [], finishReason: "stop" };
    } }) });
  const first = makeServer();
  const firstConnection = client({ name: "raw-first" }).connect(first.app);
  let id!: string;
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    await firstConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "invalid call" }] });
    assert.equal(calls, 2);
  } finally { firstConnection.close(); await first.close(); }
  const updates: SessionUpdate[] = [];
  const second = makeServer();
  const peer = client({ name: "raw-second" });
  peer.onNotification("session/update", ({ params }) => { updates.push(params.update); });
  const connection = peer.connect(second.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await connection.agent.request("session/load", { sessionId: id, cwd: root, mcpServers: [] });
    const declared = updates.find((update) => update.sessionUpdate === "tool_call");
    assert.equal(declared?.sessionUpdate, "tool_call");
    assert.deepEqual(declared.rawInput, args);
    const result = updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "failed");
    assert.equal(result?.sessionUpdate, "tool_call_update");
    assert.match(JSON.stringify(result.rawOutput), /invalid|extra/);
    assert.ok(JSON.stringify(declared.rawInput).includes(command));
    assert.equal(calls, 2);
  } finally { connection.close(); await second.close(); }
});

test("ACP cancel retains the writer claim for the original peer's next prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-cancel-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-cancel-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama"), autoApprove: false }, env: {}, requireModel: true });
  let calls = 0;
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, storeOptions, providerFactory: () => ({ modelConfig: runtime.modelConfig!,
    generate: async () => {
      calls++;
      return calls === 1 ? { text: "", toolCalls: [{ id: "write", name: "write_file", arguments: {
        operations: [{ mode: "overwrite", path: "should-not-exist", content: "x" }] } }], finishReason: "tool_calls" }
        : { text: "after-cancel", toolCalls: [], finishReason: "stop" };
    } }) });
  const first = makeServer();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const peer = client({ name: "cancel-owner" });
  peer.onRequest("session/request_permission", () => { entered(); return new Promise<never>(() => {}); });
  const firstConnection = peer.connect(first.app);
  const second = makeServer();
  const secondConnection = client({ name: "cancel-contender" }).connect(second.app);
  let id!: string;
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await secondConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    const pending = firstConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "write" }] });
    await ready;
    await firstConnection.agent.notify("session/cancel", { sessionId: id });
    assert.equal((await pending).stopReason, "cancelled");
    await assert.rejects(secondConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] }), /busy/i);
    assert.equal((await firstConnection.agent.request("session/prompt", { sessionId: id,
      prompt: [{ type: "text", text: "again" }] })).stopReason, "end_turn");
    assert.equal(calls, 2);
  } finally { firstConnection.close(); await first.close(); }
  try { await secondConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] }); }
  finally { secondConnection.close(); await second.close(); }
});

test("ACP resume drops an unavailable reverse callback and permits fresh registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-reverse-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-reverse-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const runtime = await loadConfig({ flags: { configPath: testConfig("ollama") }, env: {}, requireModel: true });
  const requests: ProviderRequest[] = [];
  const makeServer = () => createAcpServer({ runtime, mcpServers: {}, storeOptions, providerFactory: () => ({ modelConfig: runtime.modelConfig!,
    generate: async (request: ProviderRequest) => {
      requests.push(request);
      return { text: "done", toolCalls: [], finishReason: "stop" };
    } }) });
  const first = makeServer();
  const firstPeer = client({ name: "reverse-first" });
  let oldInvocations = 0;
  firstPeer.onRequest("_raw/tool/call", (params: unknown) => params, () => {
    oldInvocations++; return { isError: false, content: [{ type: "text", text: "old" }] };
  });
  const firstConnection = firstPeer.connect(first.app);
  let id!: string;
  let oldAlias!: string;
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true } } });
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    oldAlias = (await firstConnection.agent.request<{ alias: string }>("_raw/tool/register", {
      sessionId: id, name: "ephemeral", description: "old callback", inputSchema: { type: "object" } })).alias;
    await firstConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "one" }] });
    assert.ok(requests[0]?.tools.some((item) => item.name === oldAlias));
  } finally { firstConnection.close(); await first.close(); }
  const second = makeServer();
  const updates: SessionUpdate[] = [];
  const secondPeer = client({ name: "reverse-second" });
  secondPeer.onNotification("session/update", ({ params }) => { updates.push(params.update); });
  const secondConnection = secondPeer.connect(second.app);
  try {
    await secondConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true } } });
    await secondConnection.agent.request("session/load", { sessionId: id, cwd: root, mcpServers: [] });
    assert.ok(updates.some((item) => item.sessionUpdate === "agent_message_chunk"));
    await secondConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "two" }] });
    assert.equal(requests[1]?.tools.some((item) => item.name === oldAlias), false);
    assert.notEqual(requests[1]?.cacheKey, requests[0]?.cacheKey);
    const registered = await secondConnection.agent.request<{ alias: string }>("_raw/tool/register", {
      sessionId: id, name: "ephemeral", description: "new callback", inputSchema: { type: "object" } });
    assert.notEqual(registered.alias, oldAlias);
    await secondConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "three" }] });
    assert.ok(requests[2]?.tools.some((item) => item.name === registered.alias));
    assert.equal(oldInvocations, 0);
  } finally { secondConnection.close(); await second.close(); }
});

test("dropping an old callback still transitions a changed retained MCP schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-acp-schema-"));
  const state = mkdtempSync(join(tmpdir(), "raw-session-acp-schema-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const configPath = testConfig("ollama");
  const document = JSON.parse(readFileSync(configPath, "utf8"));
  document.agents.fixture.tools.use.push("mcp/fixture/selected");
  writeFileSync(configPath, JSON.stringify(document));
  const runtime = await loadConfig({ flags: { configPath }, env: {}, requireModel: true });
  const captures: ProviderRequest[] = [];
  const makeServer = (label: string) => createAcpServer({ runtime, storeOptions,
    mcpServers: { fixture: { command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/mcp-stdio.ts")],
      env: { MCP_LABEL: label }, tools: ["selected"] } },
    providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async (request) => {
      captures.push(request);
      return { text: "ok", toolCalls: [], finishReason: "stop" };
    } }) });
  const first = makeServer("old-description");
  const firstConnection = client({ name: "schema-first" }).connect(first.app);
  let id!: string;
  try {
    await firstConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true } } });
    id = (await firstConnection.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
    await firstConnection.agent.request("_raw/tool/register", { sessionId: id, name: "callback",
      description: "temporary", inputSchema: { type: "object" } });
    await firstConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "one" }] });
  } finally { firstConnection.close(); await first.close(); }
  const changed = makeServer("new-description");
  const changedConnection = client({ name: "schema-changed" }).connect(changed.app);
  try {
    await changedConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await changedConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] });
    await changedConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "two" }] });
    assert.notEqual(captures[0]?.cacheKey, captures[1]?.cacheKey);
    assert.ok(captures[1]?.tools.some((tool) => tool.description.includes("new-description")));
    assert.ok(!captures[1]?.tools.some((tool) => tool.description === "temporary"));
  } finally { changedConnection.close(); await changed.close(); }
  const same = makeServer("old-description");
  const sameConnection = client({ name: "schema-same" }).connect(same.app);
  try {
    await sameConnection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await sameConnection.agent.request("session/resume", { sessionId: id, cwd: root, mcpServers: [] });
    await sameConnection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "three" }] });
    assert.notEqual(captures[1]?.cacheKey, captures[2]?.cacheKey);
  } finally { sameConnection.close(); await same.close(); }
});
