import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { connectMcpServers } from "../src/tools/mcp-client.js";
import { accessSync } from "node:fs";

function config(data: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "raw-mcp-policy-")), "config.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}
const model = { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" };
const server = { transport: "stdio", command: "missing-unstarted-server", args: [] };

test("root MCP definitions remain inert until selected by profile", async () => {
  const path = config({ default_profile: "plain", models: { local: model }, mcp: { servers: { search: server } },
    profiles: { plain: { model: "local" }, research: { model: "local", mcp: { search: ["web_search"] } } } });
  const plain = await loadConfig({ configPath: path, env: {}, requireModel: true });
  assert.equal(Object.keys(plain.mcpServers).length, 0);
  const research = await loadConfig({ configPath: path, env: {}, flags: { profile: "research" }, requireModel: true });
  assert.deepEqual(research.mcpServers.search, { command: "missing-unstarted-server", args: [], tools: ["web_search"] });
  assert.ok(Object.isFrozen(research.mcpServers.search?.tools));
});

test("configured but unselected MCP process never starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raw-mcp-inert-"));
  const pidFile = join(directory, "started.pid");
  const path = config({ default_profile: "plain", models: { local: model }, profiles: { plain: { model: "local" } },
    mcp: { servers: { hidden: { transport: "stdio", command: process.execPath,
      args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: { MCP_PID_FILE: pidFile } } } } });
  const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
  const connection = await connectMcpServers({ servers: runtime.mcpServers, cwd: process.cwd(), timeoutMs: 1000 });
  try {
    assert.equal(connection.discovered.length, 0);
    assert.throws(() => accessSync(pidFile));
  } finally { await connection.close(); }
});

test("unknown MCP selection, duplicate selected tools and invalid policy fail at config load", async () => {
  const root = { default_profile: "p", models: { local: model }, mcp: { servers: { search: server } },
    profiles: { p: { model: "local", mcp: { search: ["web_search"] }, tools: { rules: [{ match: "bash", effect: "ask" }] } } } };
  const valid = await loadConfig({ configPath: config(root), env: {}, requireModel: true });
  assert.deepEqual(valid.toolRules, [{ match: "bash", effect: "ask" }]);
  const unknown = structuredClone(root) as any;
  unknown.profiles.p.mcp = { absent: "*" };
  await assert.rejects(loadConfig({ configPath: config(unknown), env: {}, requireModel: true }), /unknown MCP server/);
  const duplicate = structuredClone(root) as any;
  duplicate.profiles.p.mcp.search = ["web_search", "web_search"];
  await assert.rejects(loadConfig({ configPath: config(duplicate), env: {}, requireModel: true }), /duplicate/);
  const invalid = structuredClone(root) as any;
  invalid.profiles.p.tools.rules = [{ match: "bash", effect: "oops" }];
  await assert.rejects(loadConfig({ configPath: config(invalid), env: {}, requireModel: true }), /effect/);
});

test("old external MCP file shape is rejected by canonical config", async () => {
  const path = config({ default_profile: "p", models: { local: model }, profiles: { p: { model: "local" } },
    mcpServers: { search: server } });
  await assert.rejects(loadConfig({ configPath: path, env: {}, requireModel: true }), /mcpServers/);
});

test("MCP server names cannot change configuration object prototypes", async () => {
  const path = config({ default_profile: "p", models: { local: model },
    mcp: { servers: Object.fromEntries([["__proto__", server]]) },
    profiles: { p: { model: "local", mcp: Object.fromEntries([["__proto__", []]]) } } });
  const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
  assert.equal(Object.getPrototypeOf(runtime.mcpServers), null);
  assert.equal(Object.hasOwn(runtime.mcpServers, "__proto__"), true);
  assert.equal((runtime.mcpServers["__proto__"] as { command: string }).command, "missing-unstarted-server");
});

test("MCP stdio process arguments preserve empty and whitespace strings", async () => {
  const path = config({ default_profile: "p", models: { local: model },
    mcp: { servers: { server: { transport: "stdio", command: "program", args: ["", " ", "--flag"] } } },
    profiles: { p: { model: "local", mcp: { server: [] } } } });
  const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
  assert.deepEqual(runtime.mcpServers.server && "args" in runtime.mcpServers.server ? runtime.mcpServers.server.args : undefined,
    ["", " ", "--flag"]);
});
