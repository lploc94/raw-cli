import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAcpServer } from "../src/acp/methods.js";
import { loadConfig } from "../src/config.js";
import { testConfig } from "./fixtures/config.js";

function policyConfig(rules: Array<{ match: string; effect: string }>): string {
  const path = testConfig("ollama");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.profiles.fixture.tools = { ...document.profiles.fixture.tools, rules };
  writeFileSync(path, JSON.stringify(document));
  return path;
}

test("ACP injected deny stays hidden and rejects direct call; ask still calls permission with autoApprove", async () => {
  const path = policyConfig([{ match: "acp:blocked", effect: "deny" }, { match: "acp:confirm", effect: "ask" }]);
  const runtime = await loadConfig({ configPath: path, env: {}, flags: { autoApprove: true }, requireModel: true });
  let alias = "";
  let permissions = 0;
  let reverseCalls = 0;
  const server = createAcpServer({ runtime, providerFactory: () => ({ profile: runtime.profile!, async generate(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { text: `result:${last.result.code}`, toolCalls: [], finishReason: "stop" };
    return { text: "", toolCalls: [{ id: "call-1", name: alias, arguments: {} }], finishReason: "tool_calls" };
  } }) });
  const peer = client({ name: "policy-client" });
  peer.onRequest("session/request_permission", () => { permissions++; return { outcome: { outcome: "selected", optionId: "deny" } }; });
  peer.onRequest("_raw/tool/call", (params: unknown) => params as { toolId: string }, () => {
    reverseCalls++; return { isError: false, content: [{ type: "text", text: "executed" }] };
  });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { toolRegister: true, toolCall: true, runtimeInfo: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const blocked = await connection.agent.request<{ alias: string; schemaRevision: number }>("_raw/tool/register",
      { sessionId, name: "blocked", description: "blocked", inputSchema: { type: "object", properties: {}, additionalProperties: false } });
    alias = blocked.alias;
    const hidden = await connection.agent.request<{ tools: Array<{ alias: string }> }>("_raw/runtime/info", { sessionId });
    assert.ok(!hidden.tools.some((tool) => tool.alias === alias));
    const denied = await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "call denied" }] });
    assert.equal(denied.stopReason, "end_turn");
    assert.equal(reverseCalls, 0);
    assert.equal(permissions, 0);
    const confirm = await connection.agent.request<{ alias: string }>("_raw/tool/register",
      { sessionId, name: "confirm", description: "ask", inputSchema: { type: "object", properties: {}, additionalProperties: false } });
    alias = confirm.alias;
    const visible = await connection.agent.request<{ tools: Array<{ alias: string }> }>("_raw/runtime/info", { sessionId });
    assert.ok(visible.tools.some((tool) => tool.alias === alias));
    const asked = await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "call ask" }] });
    assert.equal(asked.stopReason, "end_turn");
    assert.equal(permissions, 1);
    assert.equal(reverseCalls, 0);
  } finally { connection.close(); await server.close(); }
});

test("ACP session MCP server is explicit but profile deny hides its tools", async () => {
  const path = policyConfig([{ match: "mcp/browser/*", effect: "deny" }]);
  const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
  let tools: readonly string[] = [];
  const server = createAcpServer({ runtime, providerFactory: () => ({ profile: runtime.profile!, async generate(request) {
    tools = request.tools.map((tool) => tool.name);
    return { text: "done", toolCalls: [], finishReason: "stop" };
  } }) });
  const connection = client({ name: "mcp-policy-client" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      _meta: { raw: { runtimeInfo: true } } });
    const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [{
      name: "browser", command: process.execPath, args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: [],
    }] });
    const info = await connection.agent.request<{ mcpCatalog: Array<{ exposed: boolean }> }>("_raw/runtime/info", { sessionId });
    assert.ok(info.mcpCatalog.length > 0);
    assert.ok(info.mcpCatalog.every((item) => item.exposed === false));
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "inspect" }] });
    assert.deepEqual(tools, ["read_file", "write_file", "bash"]);
  } finally { connection.close(); await server.close(); }
});

test("ACP names with line breaks cannot bypass broad deny or ask rules", async () => {
  for (const effect of ["deny", "ask"] as const) {
    const runtime = await loadConfig({ configPath: policyConfig([{ match: "acp:*", effect }]), env: {},
      flags: { autoApprove: true }, requireModel: true });
    let alias = "";
    let permissions = 0;
    let reverseCalls = 0;
    const server = createAcpServer({ runtime, providerFactory: () => ({ profile: runtime.profile!, async generate(request) {
      if (request.messages.at(-1)?.role === "tool") return { text: "done", toolCalls: [], finishReason: "stop" };
      return { text: "", toolCalls: [{ id: "call", name: alias, arguments: {} }], finishReason: "tool_calls" };
    } }) });
    const peer = client({ name: `linebreak-${effect}` });
    peer.onRequest("session/request_permission", () => { permissions++; return { outcome: { outcome: "selected", optionId: "deny" } }; });
    peer.onRequest("_raw/tool/call", (params: unknown) => params as { toolId: string }, () => {
      reverseCalls++; return { isError: false, content: [{ type: "text", text: "ran" }] };
    });
    const connection = peer.connect(server.app);
    try {
      await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
        _meta: { raw: { toolRegister: true, toolCall: true, runtimeInfo: true } } });
      const { sessionId } = await connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
      alias = (await connection.agent.request<{ alias: string }>("_raw/tool/register", {
        sessionId, name: "blocked\nextra", description: "line break", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      })).alias;
      const info = await connection.agent.request<{ tools: Array<{ alias: string }> }>("_raw/runtime/info", { sessionId });
      assert.equal(info.tools.some((tool) => tool.alias === alias), effect === "ask");
      await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "call" }] });
      assert.equal(permissions, effect === "ask" ? 1 : 0);
      assert.equal(reverseCalls, 0);
    } finally { connection.close(); await server.close(); }
  }
});
