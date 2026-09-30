import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { ProviderAdapter, ProviderRequest } from "../src/llm/types.js";
import { installPackage, updatePackage } from "../src/packages/store.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAcpServer } from "../src/acp/methods.js";

function packageSource(root: string, version: string, value: string): string {
  const source = join(root, `source-${version}-${value}`);
  mkdirSync(join(source, "agents"), { recursive: true }); mkdirSync(join(source, "tools", "echo"), { recursive: true });
  writeFileSync(join(source, "agents", "writer.json"), JSON.stringify({ system_prompt: "stable prompt",
    tools: { use: ["#tools/echo"] } }));
  writeFileSync(join(source, "tools", "echo", "tool.json"), JSON.stringify({ api_version: 2, id: "echo",
    version, name: "echo", description: "Echo", input_schema: { type: "object", properties: {},
      additionalProperties: false }, entry: "./index.mjs" }));
  writeFileSync(join(source, "tools", "echo", "index.mjs"),
    "import { value } from './helper.mjs'; export async function handler(){return {content:[{type:'text',text:value}]}}\n");
  writeFileSync(join(source, "tools", "echo", "helper.mjs"), `export const value = ${JSON.stringify(value)};\n`);
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/writer",
    version, description: "Writer", files: ["agents/writer.json", "tools/echo"],
    exports: { agents: { writer: "agents/writer.json" }, tools: { echo: "tools/echo" } } }));
  return source;
}

test("package update resumes one session, rotates once for helper bytes and ignores release labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-resume-"));
  const configPath = join(root, "config.json"), dataHome = join(root, "data"), stateHome = join(root, "state");
  writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { writer: {
    from: "pkg/kit/agents/writer", model: "local" } } }));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  const store = openSessionStore({ env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "package" }).id;
  const captured: Array<{ key: string | undefined; system: string; messages: ProviderRequest["messages"] }> = [];
  const attach = async () => {
    const config = await loadConfig({ configPath, requireModel: false });
    const runtime = await createRuntimeTools({ runtime: config, cwd: root });
    let step = 0;
    const provider: ProviderAdapter = { modelConfig: config.modelConfig!, generate: async (request) => {
      captured.push({ key: request.cacheKey, system: request.system, messages: structuredClone(request.messages) });
      return ++step % 2 === 1 ? { text: "", toolCalls: [{ id: `call-${captured.length}`, name: "echo", arguments: {} }],
        finishReason: "tool_calls" } : { text: "done", toolCalls: [], finishReason: "stop" };
    } };
    const agent = createAgent({ cwd: root, configPath, provider, registry: runtime.registry,
      whitelist: runtime.selectedNames, baseToolSelection: config.toolIds, toolSourceDigest: runtime.toolSourceDigest,
      selectedSkills: runtime.skills, system: config.systemPrompt,
      persistence: { store, sessionId: id, surface: "cli" } });
    return { agent, runtime };
  };
  try {
    await installPackage({ configPath, dataHome, source: packageSource(root, "1.0.0", "old"), alias: "kit" });
    const first = await attach();
    assert.equal((await first.agent.run("one")).status, "completed");
    assert.match(JSON.stringify(first.agent.transcript), /old/);
    await first.agent.close(); await first.runtime.mcp.close();
    await updatePackage({ configPath, dataHome, source: packageSource(root, "2.0.0", "old"), alias: "kit" });
    const labelOnly = await attach();
    assert.equal((await labelOnly.agent.run("two")).status, "completed");
    assert.equal(labelOnly.agent.contextRevision, first.agent.contextRevision);
    await labelOnly.agent.close(); await labelOnly.runtime.mcp.close();
    await updatePackage({ configPath, dataHome, source: packageSource(root, "2.0.0", "new"), alias: "kit" });
    const changed = await attach();
    assert.equal((await changed.agent.run("three")).status, "completed");
    assert.match(JSON.stringify(changed.agent.transcript), /new/);
    assert.ok(changed.agent.contextRevision > labelOnly.agent.contextRevision);
    await changed.agent.close(); await changed.runtime.mcp.close();
    const stable = await attach();
    assert.equal(stable.agent.contextRevision, changed.agent.contextRevision);
    assert.equal((await stable.agent.run("four")).status, "completed");
    await stable.agent.close(); await stable.runtime.mcp.close();
    assert.equal(captured[0]?.key, captured[2]?.key);
    assert.notEqual(captured[2]?.key, captured[4]?.key);
    assert.equal(captured[4]?.key, captured[6]?.key);
    assert.equal(captured[4]?.system, captured[6]?.system);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("ACP attaches an installed package agent through its ordinary runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-acp-"));
  const configPath = join(root, "config.json"), dataHome = join(root, "data"), stateHome = join(root, "state");
  writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { writer: {
    from: "pkg/kit/agents/writer", model: "local" } } }));
  await installPackage({ configPath, dataHome, source: packageSource(root, "1.0.0", "acp"), alias: "kit" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const runtime = await loadConfig({ configPath, requireModel: false });
    const seen: ProviderRequest[] = [];
    const server = createAcpServer({ runtime, storeOptions: { env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root } },
      providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async (request) => {
        seen.push(request); return { text: "done", toolCalls: [], finishReason: "stop" };
      } }) });
    const peer = client({ name: "package-test" }).connect(server.app);
    try {
      await peer.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const id = (await peer.agent.request("session/new", { cwd: root, mcpServers: [] })).sessionId;
      const result = await peer.agent.request("session/prompt", { sessionId: id,
        prompt: [{ type: "text", text: "hello" }] });
      assert.equal(result.stopReason, "end_turn");
      assert.equal(seen[0]?.system, "stable prompt");
      assert.match(JSON.stringify(seen[0]?.tools), /echo/);
    } finally { peer.close(); await server.close(); }
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});
