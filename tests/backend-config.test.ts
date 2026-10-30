import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_KEYS, loadConfig } from "../src/config.js";
import { AGENT_KEY_USE, BRIDGED_BUILTINS, NATIVE_DUPLICATES, classifyForBackend } from "../src/backends/compat.js";
import { installPackage } from "../src/packages/store.js";
import { editAgent } from "../src/management/agents.js";
import { exportAgentPackage } from "../src/packages/export.js";
import { cliAgent } from "./fixtures/cli-agent.js";

const MODELS = { local: { provider: "ollama", method: "openai-chat-completions", model_id: "test", base_url: "http://127.0.0.1:1/v1" },
  claude: { method: "claude-code-cli" }, codex: { method: "codex-cli" }, agy: { method: "antigravity-cli" } };

function configFile(agents: Record<string, unknown>, defaultAgent = Object.keys(agents)[0], models: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "raw-backend-config-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ default_agent: defaultAgent, models: { ...MODELS, ...models }, agents }));
  return path;
}

const load = (agent: unknown, models: Record<string, unknown> = {}) => loadConfig({ configPath: configFile({ a: agent }, "a", models), env: {} });

test("each CLI method loads an agent without a Raw model, with the spec the old backend block produced", async () => {
  for (const kind of ["claude", "codex", "agy"] as const) {
    const { models, agent } = cliAgent({ kind, model: "m1", effort: "high", mode: "auto" }, { system_prompt: "Be brief.",
      tools: { use: ["builtin/todo"] } });
    const runtime = await load(agent, models);
    assert.equal(runtime.modelConfig, undefined);
    assert.deepEqual({ ...runtime.backend }, { kind, model: "m1", effort: "high", mode: "auto", systemPromptMode: "replace" });
    assert.equal(runtime.systemPrompt, "Be brief.");
    assert.deepEqual(runtime.toolIds, ["builtin/todo"]);
    // Every field set: the old block {kind, model, effort, mode, executable, system_prompt_mode} maps field for field.
    const full = cliAgent({ kind, model: "gpt-6.1-terra", effort: "xhigh", mode: "workspace-write", executable: `/opt/${kind}`,
      system_prompt_mode: "append" }, { tools: { use: [] } });
    assert.deepEqual({ ...(await load(full.agent, full.models)).backend }, { kind, model: "gpt-6.1-terra", effort: "xhigh",
      mode: "workspace-write", systemPromptMode: "append", executable: `/opt/${kind}` });
  }
  const bare = await load({ model: "codex", tools: { use: [] } });
  assert.deepEqual({ ...bare.backend }, { kind: "codex", systemPromptMode: "replace" });
  const described = await load({ model: "terra", tools: { use: [] } }, { terra: { method: "codex-cli", model_id: "gpt-6.1-terra", provider: "openai" } });
  assert.equal(described.backend?.model, "gpt-6.1-terra");
});

test("an empty or blank CLI model_id means the CLI's default model", async () => {
  for (const modelId of ["", "  "]) {
    const runtime = await load({ model: "c", tools: { use: [] } }, { c: { method: "codex-cli", model_id: modelId } });
    assert.equal(runtime.backend?.model, undefined);
    assert.equal(Object.hasOwn(runtime.backend!, "model"), false);
  }
});

test("CLI model entries and CLI agents reject malformed fields with messages naming them", async () => {
  const agent = { model: "c", tools: { use: [] } };
  const methods = "openai-chat-completions, openai-responses, anthropic-messages, google-generate-content, claude-code-cli, codex-cli, antigravity-cli";
  const modelCases: Array<[unknown, string]> = [
    [{ method: "codex" }, `model c.method must be one of: ${methods}`],
    [{ method: "cli" }, `model c.method must be one of: ${methods}`],
    [{ method: "Codex-CLI" }, `model c.method must be one of: ${methods}`],
    [{ method: "codex-cli", model_id: 5 }, "model c.model_id must be a string"],
    [{ method: "codex-cli", model_id: null }, "model c.model_id must be a string"],
    [{ method: "codex-cli", model_id: [] }, "model c.model_id must be a string"],
    [{ method: "codex-cli", provider: "" }, "model c.provider must be a nonempty string"],
    [{ method: "codex-cli", executable: " " }, "model c.executable must be a nonempty string"],
    ...["base_url", "api_key", "api_key_env", "context_window_tokens", "max_output_tokens", "vision"]
      .map((key): [unknown, string] => [{ method: "codex-cli", [key]: key === "vision" ? true : key.endsWith("tokens") ? 1000 : "x" },
        `unknown model c field: ${key}`]),
  ];
  for (const [model, message] of modelCases) await assert.rejects(load(agent, { c: model }), { message });
  const agentCases: Array<[unknown, string]> = [
    [{ model: "codex", request: { reasoning_effort: " " }, tools: { use: [] } }, "agent a.request.reasoning_effort must be a nonempty string"],
    [{ model: "codex", request: { mode: 5 }, tools: { use: [] } }, "agent a.request.mode must be a nonempty string"],
    [{ model: "codex", request: "high", tools: { use: [] } }, "agent a.request must be an object"],
    [{ model: "codex", system_prompt_mode: "merge", tools: { use: [] } }, 'agent a.system_prompt_mode must be "replace" or "append"'],
    [{ model: "codex", system_prompt_mode: null, tools: { use: [] } }, 'agent a.system_prompt_mode must be "replace" or "append"'],
    [{ model: "local", system_prompt_mode: "append", tools: { use: [] } }, "agent a.system_prompt_mode applies to CLI models only"],
    [{ model: "local", request: { mode: "auto" }, tools: { use: [] } }, "unknown agent a.request field: mode"],
    [{ backend: { kind: "codex" }, tools: { use: [] } }, "unknown agent a field: backend"],
    [{ model: "codex", backend: { kind: "codex" }, tools: { use: [] } }, "unknown agent a field: backend"],
  ];
  for (const [value, message] of agentCases) await assert.rejects(load(value), { message });
});

test("loop-only settings and hooks on a CLI agent load and are reported, not rejected; effort and mode apply", async () => {
  const runtime = await load({ model: "codex", request: { reasoning_effort: "high", max_output_tokens: 32768, thinking: "enabled" },
    cache: { mode: "x" }, compact: { trigger_tokens: 5 }, max_steps: 3, hooks: { use: ["local/check"] }, tools: { use: ["builtin/bash", "builtin/todo"] } });
  assert.equal(runtime.backend?.effort, "high");
  assert.deepEqual(runtime.backendIgnoredSettings, ["request.max_output_tokens", "request.thinking", "cache", "compact", "max_steps"]);
  const result = classifyForBackend(runtime);
  assert.deepEqual(result.bridged, ["builtin/todo"]);
  assert.deepEqual(result.warnings, [
    'codex agent "a" skips builtin/bash: Codex uses its own shell tool',
    'codex agent "a" skips hooks: Raw hooks do not run for an external backend',
    'codex agent "a" skips request.max_output_tokens: it configures Raw\'s own agent loop',
    'codex agent "a" skips request.thinking: it configures Raw\'s own agent loop',
    'codex agent "a" skips cache: it configures Raw\'s own agent loop',
    'codex agent "a" skips compact: it configures Raw\'s own agent loop',
    'codex agent "a" skips max_steps: it configures Raw\'s own agent loop',
  ]);
  const clean = await load({ model: "codex", request: { reasoning_effort: "high", mode: "auto" }, tools: { use: [] } });
  assert.deepEqual(clean.backendIgnoredSettings, []);
  assert.deepEqual(classifyForBackend(clean).warnings, []);
});

test("the shell warning names each backend", async () => {
  const names = { claude: "Claude Code", codex: "Codex", agy: "agy" } as const;
  for (const kind of ["claude", "codex", "agy"] as const) {
    const runtime = await loadConfig({ configPath: configFile({ [`e2e-${kind}`]: { model: kind,
      system_prompt: "Begin every answer with [RAW_E2E].", tools: { use: ["builtin/todo", "builtin/bash"] } } }), env: {} });
    assert.deepEqual(classifyForBackend(runtime).warnings, [...kind === "agy" ? ['agy agent "e2e-agy" skips builtin/todo: Raw tools are unavailable with agy'] : [],
      `${kind} agent "e2e-${kind}" skips builtin/bash: ${names[kind]} uses its own shell tool`]);
  }
});

test("agy gets no Raw tools: every tool another backend reaches through the bridge is skipped with a warning", async () => {
  const runtime = await load({ model: "agy", tools: { use: ["builtin/todo", "builtin/ask_user", "local/mine", "mcp/srv/tool"] } });
  const result = classifyForBackend({ ...runtime, toolIds: [...runtime.toolIds, "pkg/kit/tools/echo"] });
  assert.deepEqual(result.bridged, []);
  assert.deepEqual(result.warnings, ["builtin/todo", "builtin/ask_user", "local/mine", "mcp/srv/tool", "pkg/kit/tools/echo"]
    .map((id) => `agy agent "a" skips ${id}: Raw tools are unavailable with agy`));
});

test("every bundled built-in and every agent key is classified", async () => {
  const bundled = readdirSync(join(import.meta.dirname, "..", "src", "tools", "bundled")).map((name) => `builtin/${name}`);
  assert.ok(bundled.length >= 14);
  for (const id of bundled) {
    assert.ok(Object.hasOwn(NATIVE_DUPLICATES, id) !== BRIDGED_BUILTINS.includes(id), `${id} must be either skipped or bridged`);
  }
  for (const key of AGENT_KEYS) assert.ok(Object.hasOwn(AGENT_KEY_USE, key), `agent key ${key} is not classified`);
  assert.equal(AGENT_KEYS.includes("backend"), false);
  const runtime = await load({ model: "claude", tools: { use: [...bundled, "local/mine", "agent/note", "mcp/srv/tool"] } });
  const result = classifyForBackend({ ...runtime, toolIds: [...runtime.toolIds, "pkg/kit/tools/echo"] });
  assert.deepEqual([...result.bridged].sort(), [...BRIDGED_BUILTINS, "local/mine", "agent/note", "mcp/srv/tool", "pkg/kit/tools/echo"].sort());
  assert.deepEqual(result.skipped.map((item) => item.id).sort(), Object.keys(NATIVE_DUPLICATES).sort());
});

test("rules that only match skipped tools warn that they cannot be enforced", async () => {
  const runtime = await load({ model: "codex", tools: { use: ["builtin/bash", "builtin/todo"], rules: [
    { match: "builtin/bash", effect: "ask" }, { match: "builtin/*", effect: "ask" }, { match: "builtin/todo", effect: "deny" }] } });
  const warnings = classifyForBackend(runtime).warnings;
  assert.ok(warnings.includes('rule "builtin/bash" cannot be enforced on Codex\'s own tools'));
  assert.equal(warnings.filter((line) => line.startsWith("rule ")).length, 1);
  // The CLI keeps its own shell whether or not Raw selects builtin/bash, so the rule warns either way.
  const unselected = await load({ model: "codex", tools: { use: [], rules: [{ match: "builtin/bash", effect: "deny" }] } });
  assert.deepEqual(classifyForBackend(unselected).warnings, ['rule "builtin/bash" cannot be enforced on Codex\'s own tools']);
});

test("an agent on an API model is unchanged and has no backend fields", async () => {
  const runtime = await load({ model: "local", tools: { use: ["builtin/bash"] } });
  assert.equal(runtime.backend, undefined);
  assert.equal(runtime.backendIgnoredSettings, undefined);
  assert.equal(runtime.modelConfig?.modelAlias, "local");
  assert.deepEqual(classifyForBackend(runtime), { bridged: ["builtin/bash"], skipped: [], warnings: [] });
});

function packageSource(): string {
  const root = mkdtempSync(join(tmpdir(), "raw-backend-package-"));
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "writer.json"), JSON.stringify({ system_prompt: "package prompt", tools: { use: ["builtin/todo"] } }));
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/writer", version: "1.0.0",
    description: "Writer", files: ["agents/writer.json"], exports: { agents: { writer: "agents/writer.json" } } }));
  return root;
}

function promptModePackage(mode?: "append" | "replace"): string {
  const root = packageSource();
  writeFileSync(join(root, "agents", "writer.json"), JSON.stringify({ system_prompt: "package prompt", tools: { use: ["builtin/todo"] },
    ...(mode ? { system_prompt_mode: mode } : {}) }));
  return root;
}

test("a package agent binding chooses a CLI model like any model; a backend block is an unknown field", async () => {
  const previous = process.env.XDG_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "raw-backend-binding-"));
  const dataHome = join(root, "data");
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const write = (agent: Record<string, unknown>) => {
      const path = join(root, "config.json");
      writeFileSync(path, JSON.stringify({ default_agent: "writer", models: { ...MODELS, gptx: { method: "codex-cli", model_id: "gpt-x" } },
        agents: { writer: agent } }));
      return path;
    };
    const configPath = write({ from: "pkg/kit/agents/writer", model: "gptx" });
    await installPackage({ configPath, dataHome, source: packageSource(), alias: "kit" });
    const runtime = await loadConfig({ configPath });
    assert.equal(runtime.modelConfig, undefined);
    assert.equal(runtime.backend?.kind, "codex");
    assert.equal(runtime.backend?.model, "gpt-x");
    assert.equal(runtime.backend?.systemPromptMode, "replace");
    assert.equal(runtime.systemPrompt, "package prompt");
    assert.deepEqual(runtime.toolIds, ["builtin/todo"]);
    await assert.rejects(loadConfig({ configPath: write({ from: "pkg/kit/agents/writer", model: "local", backend: { kind: "codex" } }) }),
      { message: "unknown package agent binding field: backend" });
    await assert.rejects(loadConfig({ configPath: write({ from: "pkg/kit/agents/writer" }) }),
      { message: "package agent binding requires model" });
    const modelRuntime = await loadConfig({ configPath: write({ from: "pkg/kit/agents/writer", model: "local" }), requireModel: false });
    assert.equal(modelRuntime.modelConfig?.modelAlias, "local");
    assert.equal(modelRuntime.backend, undefined);
    const overridden = await loadConfig({ configPath: write({ from: "pkg/kit/agents/writer", model: "gptx",
      overrides: { system_prompt_mode: "append", request: { reasoning_effort: "low" } } }) });
    assert.equal(overridden.backend?.systemPromptMode, "append");
    assert.equal(overridden.backend?.effort, "low");
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
  }
});

test("a package agent's system_prompt_mode is inherited, and a recipient override replaces it", async () => {
  await withDataHome(async (root, dataHome) => {
    const configPath = join(root, "config.json");
    const write = (agent: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ default_agent: "w", models: MODELS, agents: { w: agent } }));
    write({ from: "pkg/kit/agents/writer", model: "claude" });
    await installPackage({ configPath, dataHome, source: promptModePackage("append"), alias: "kit" });
    assert.equal((await loadConfig({ configPath })).backend?.systemPromptMode, "append");
    write({ from: "pkg/kit/agents/writer", model: "claude", overrides: { system_prompt_mode: "replace" } });
    assert.equal((await loadConfig({ configPath })).backend?.systemPromptMode, "replace");
  });
});

test("the agent editor moves an agent between a CLI model and an API model by its model alone", async () => {
  const configPath = configFile({ a: { model: "local", tools: { use: [] } } }, "a", { haiku: { method: "claude-code-cli", model_id: "haiku" } });
  await editAgent({ configPath }, { action: "patch", name: "a", value: { model: "haiku" } });
  let runtime = await loadConfig({ configPath, env: {} });
  assert.equal(runtime.backend?.model, "haiku");
  assert.equal(runtime.modelConfig, undefined);
  await editAgent({ configPath }, { action: "patch", name: "a", value: { model: "local" } });
  runtime = await loadConfig({ configPath, env: {}, requireModel: false });
  assert.equal(runtime.backend, undefined);
  assert.equal(runtime.modelConfig?.modelAlias, "local");
});

async function withDataHome(run: (root: string, dataHome: string) => Promise<void>): Promise<void> {
  const previous = process.env.XDG_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "raw-backend-data-"));
  process.env.XDG_DATA_HOME = join(root, "data");
  try { await run(root, join(root, "data")); }
  finally { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; }
}

function hookPackage(requires: string): string {
  const source = mkdtempSync(join(tmpdir(), "raw-backend-hook-"));
  mkdirSync(join(source, "hooks", "check"), { recursive: true });
  writeFileSync(join(source, "hooks", "check", "hook.json"), JSON.stringify({ protocol_version: 2, name: "check",
    events: [{ name: "PreToolUse", match: "builtin/bash" }], command: "node", args: ["./index.mjs"] }));
  writeFileSync(join(source, "hooks", "check", "index.mjs"), "");
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/hooks", version: "1.0.0",
    description: "Hook", files: ["hooks/check"], exports: { hooks: { check: "hooks/check" } }, requires: [requires] }));
  return source;
}

test("a package hook a backend agent selects is reported, not resolved, even when Raw cannot run it", async () => {
  await withDataHome(async (root, dataHome) => {
    const source = hookPackage("raw.hook/1");
    const configPath = join(root, "config.json");
    const write = (agent: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: MODELS, agents: { a: agent } }));
    write({ model: "codex", tools: { use: [] }, hooks: { use: ["pkg/old/hooks/check"] } });
    await installPackage({ configPath, dataHome, source, alias: "old" });
    const runtime = await loadConfig({ configPath });
    assert.deepEqual(runtime.hookIds, ["pkg/old/hooks/check"]);
    assert.deepEqual(classifyForBackend(runtime).warnings, ['codex agent "a" skips hooks: Raw hooks do not run for an external backend']);
    write({ model: "local", tools: { use: [] }, hooks: { use: ["pkg/old/hooks/check"] } });
    await assert.rejects(loadConfig({ configPath }), /requires unsupported host capability raw\.hook\/1/);
  });
});

test("an exported CLI agent installs and binds to the recipient's own CLI or API model", async () => {
  await withDataHome(async (root, dataHome) => {
    const authorPath = configFile({ writer: { model: "gptx", system_prompt: "author prompt", tools: { use: ["builtin/todo"] } } }, "writer",
      { gptx: { method: "codex-cli", model_id: "gpt-x" } });
    const out = join(root, "out");
    await exportAgentPackage({ configPath: authorPath, agentName: "writer", out, name: "@test/exported", version: "1.0.0" });
    const exported = JSON.parse(readFileSync(join(out, "agents", "writer.json"), "utf8")) as Record<string, unknown>;
    assert.equal(exported.model, undefined);
    const configPath = join(root, "config.json");
    const write = (agent: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ default_agent: "w", models: MODELS, agents: { w: agent } }));
    write({ from: "pkg/ex/agents/writer", model: "claude" });
    await installPackage({ configPath, dataHome, source: out, alias: "ex" });
    const runtime = await loadConfig({ configPath });
    assert.equal(runtime.backend?.kind, "claude");
    assert.equal(runtime.backend?.model, undefined);
    assert.equal(runtime.systemPrompt, "author prompt");
    write({ from: "pkg/ex/agents/writer", model: "local" });
    assert.equal((await loadConfig({ configPath, requireModel: false })).modelConfig?.modelAlias, "local");
  });
});

test("a package binding's backend block is an unknown field, and the editor refuses it", async () => {
  await withDataHome(async (root, dataHome) => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: MODELS,
      agents: { writer: { from: "pkg/kit/agents/writer", model: "codex" } } }));
    await installPackage({ configPath, dataHome, source: packageSource(), alias: "kit" });
    await assert.rejects(editAgent({ configPath }, { action: "patch", name: "writer", value: { backend: { kind: "codex" } } }),
      { message: "unknown package agent binding field: backend" });
    assert.equal((await loadConfig({ configPath })).backend?.kind, "codex");
  });
});

test("exporting a CLI agent still packages the hooks it selects", async () => {
  await withDataHome(async (root, dataHome) => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: MODELS,
      agents: { a: { model: "codex", tools: { use: [] }, hooks: { use: ["pkg/kit/hooks/check"] } } } }));
    await installPackage({ configPath, dataHome, source: hookPackage("raw.hook/2"), alias: "kit" });
    const out = join(root, "out");
    await exportAgentPackage({ configPath, agentName: "a", out, name: "@test/with-hook", version: "1.0.0" });
    const agent = JSON.parse(readFileSync(join(out, "agents", "a.json"), "utf8")) as { hooks?: { use: string[] }; model?: unknown };
    assert.deepEqual(agent.hooks?.use, ["#hooks/check"]);
    assert.equal(agent.model, undefined);
  });
});
