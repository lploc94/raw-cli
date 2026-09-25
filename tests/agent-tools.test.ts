import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const answer = { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] };

async function runRaw(configPath: string, agent: string, cwd: string, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--config", configPath, "--agent", agent, ...extra, "hello"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdout.resume();
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stderr };
}

test("CLI exposes agent tools in declared order while unselected local and MCP sources remain inert", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-agent-tools-"));
  const fixture = await startMockProvider([answer, answer]);
  try {
    const configPath = join(cwd, "config.json");
    const marker = join(cwd, "unselected-imported");
    const mcpMarker = join(cwd, "unselected-mcp-started");
    const toolFolder = join(cwd, "tools", "unused");
    await mkdir(toolFolder, { recursive: true });
    await writeFile(join(toolFolder, "tool.json"), JSON.stringify({ api_version: 1, id: "unused", version: "1.0.0",
      name: "unused", description: "unused", input_schema: { type: "object" }, entry: "./index.mjs" }));
    await writeFile(join(toolFolder, "index.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export async function handler() { return { isError: false, content: [] }; }`);
    await writeFile(configPath, JSON.stringify({ default_agent: "read", models: { shared: {
      provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: fixture.url,
    } }, agents: {
      read: { model: "shared", tools: { use: ["builtin/read_file"] }, system_prompt: "Read only" },
      code: { model: "shared", tools: { use: ["builtin/bash", "builtin/read_file"] }, system_prompt: "Code" },
      unused: { model: "shared", tools: { use: ["agent/unused", "mcp/hidden/selected"] } },
    }, mcp: { servers: { hidden: { transport: "stdio", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)}, 'started')`] } } } }));
    const env = { ...process.env, OPENAI_API_KEY: "fixture", XDG_STATE_HOME: join(cwd, "state"), XDG_CONFIG_HOME: join(cwd, "xdg") };
    assert.equal((await runRaw(configPath, "read", cwd, env)).code, 0);
    assert.equal((await runRaw(configPath, "code", cwd, env)).code, 0);
    const names = fixture.requests.map((request) => (request.body as { tools: Array<{ function: { name: string } }> }).tools.map((tool) => tool.function.name));
    assert.deepEqual(names, [["read_file"], ["bash", "read_file"]]);
    assert.deepEqual(fixture.requests.map((request) => (request.body as { messages: Array<{ content: string }> }).messages[0]?.content),
      ["Read only", "Code"]);
    await assert.rejects(access(marker));
    await assert.rejects(access(mcpMarker));
  } finally { await fixture.close(); }
});

test("prompt files are strict UTF-8 and run-time overrides take precedence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-agent-prompt-"));
  const configPath = join(cwd, "config.json");
  const promptPath = join(cwd, "SYSTEM.md");
  const make = (agent: Record<string, unknown>) => ({ default_agent: "p", models: { m: {
    provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
  agents: { p: { model: "m", tools: { use: [] }, ...agent } } });
  await writeFile(promptPath, "From Markdown\n");
  await writeFile(configPath, JSON.stringify(make({ system_prompt_file: "SYSTEM.md" })));
  assert.equal((await loadConfig({ configPath, env: {} })).systemPrompt, "From Markdown\n");
  assert.equal((await loadConfig({ configPath, env: { RAW_SYSTEM_PROMPT: "" } })).systemPrompt, "");
  assert.equal((await loadConfig({ configPath, env: { RAW_SYSTEM_PROMPT: "env" }, flags: { systemPrompt: "flag" } })).systemPrompt, "flag");
  await writeFile(configPath, JSON.stringify(make({ system_prompt_file: promptPath })));
  assert.equal((await loadConfig({ configPath, env: {} })).systemPrompt, "From Markdown\n");
  await writeFile(promptPath, Buffer.from([0xff]));
  await assert.rejects(loadConfig({ configPath, env: {} }), /invalid UTF-8/);
  await writeFile(configPath, JSON.stringify(make({ system_prompt_file: "missing.md" })));
  await assert.rejects(loadConfig({ configPath, env: {} }), /cannot read system prompt/);
  await writeFile(configPath, JSON.stringify(make({ system_prompt: "a", system_prompt_file: "SYSTEM.md" })));
  await assert.rejects(loadConfig({ configPath, env: {} }), /choose system_prompt/);
});

test("startup rejects a selected unknown server, missing plugin, and image tool on a text model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-agent-invalid-"));
  const configPath = join(cwd, "config.json");
  const make = async (ids: string[]) => {
    await writeFile(configPath, JSON.stringify({ default_agent: "p", models: { m: {
      provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { p: { model: "m", tools: { use: ids } } } }));
    return loadConfig({ configPath, env: {} });
  };
  await assert.rejects(createRuntimeTools({ runtime: await make(["mcp/missing/selected"]), cwd }), /unknown MCP server/);
  await assert.rejects(createRuntimeTools({ runtime: await make(["agent/missing"]), cwd }), /missing or escaping selected tool/);
  await assert.rejects(createRuntimeTools({ runtime: await make(["builtin/view_image"]), cwd }), /vision model/);
  const empty = await createRuntimeTools({ runtime: await make([]), cwd });
  try { assert.deepEqual(empty.registry.definitions(), []); }
  finally { await empty.mcp.close(); }
});

test("conditional policy paths incompatible with a selected schema fail before inference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-agent-policy-bind-"));
  const configPath = join(cwd, "config.json");
  await writeFile(configPath, JSON.stringify({ default_agent: "p", models: { m: {
    provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } }, agents: { p: {
      model: "m", tools: { use: ["builtin/bash"], rules: [{ match: "builtin/bash", effect: "ask",
        when: { any: "commands[*].missing", regex: "rm" } }] },
    } } }));
  const runtime = await loadConfig({ configPath, env: {} });
  await assert.rejects(createRuntimeTools({ runtime, cwd }), /when\.any path.*schema/);
});

test("CLI resume rotates generated cache hint after a code-only selected plugin edit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-agent-code-generation-"));
  const provider = await startMockProvider([answer, answer, answer]);
  try {
    const configPath = join(cwd, "config.json");
    const folder = join(cwd, "tools", "custom");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "tool.json"), JSON.stringify({ api_version: 1, id: "custom", version: "1.0.0",
      name: "custom", description: "A stable schema", input_schema: { type: "object", properties: {} }, entry: "./index.mjs" }));
    const entry = (value: string) => `export async function handler() { return { isError: false, content: [{ type: "text", text: ${JSON.stringify(value)} }] }; }`;
    await writeFile(join(folder, "index.mjs"), entry("old"));
    await writeFile(configPath, JSON.stringify({ default_agent: "p", models: { m: {
      provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: provider.url,
    } }, agents: { p: { model: "m", tools: { use: ["agent/custom"] } } } }));
    const env = { ...process.env, OPENAI_API_KEY: "fixture", XDG_STATE_HOME: join(cwd, "state"), XDG_CONFIG_HOME: join(cwd, "xdg") };
    const first = await runRaw(configPath, "p", cwd, env);
    assert.equal(first.code, 0, first.stderr);
    const id = first.stderr.match(/raw --resume ([0-9a-f-]{36})/)?.[1];
    assert.ok(id);
    const unchanged = await runRaw(configPath, "p", cwd, env, ["--resume", id]);
    assert.equal(unchanged.code, 0, unchanged.stderr);
    await writeFile(join(folder, "index.mjs"), entry("new"));
    const second = await runRaw(configPath, "p", cwd, env, ["--resume", id]);
    assert.equal(second.code, 0, second.stderr);
    const [before, same, after] = provider.requests.map((item) => item.body as { prompt_cache_key: string; tools: unknown[]; messages: unknown[] });
    assert.deepEqual(before?.tools, same?.tools);
    assert.deepEqual(same?.tools, after?.tools);
    assert.equal(before?.prompt_cache_key, same?.prompt_cache_key);
    assert.notEqual(same?.prompt_cache_key, after?.prompt_cache_key);
    assert.deepEqual(same?.messages.slice(0, before?.messages.length), before?.messages);
    assert.deepEqual(after?.messages.slice(0, same?.messages.length), same?.messages);
  } finally { await provider.close(); }
});
