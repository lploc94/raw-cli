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

const MODELS = { local: { provider: "ollama", method: "openai-chat-completions", model_id: "test", base_url: "http://127.0.0.1:1/v1" } };

function configFile(agents: Record<string, unknown>, defaultAgent = Object.keys(agents)[0]): string {
  const root = mkdtempSync(join(tmpdir(), "raw-backend-config-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ default_agent: defaultAgent, models: MODELS, agents }));
  return path;
}

const load = (agent: unknown) => loadConfig({ configPath: configFile({ a: agent }), env: {} });

test("each backend kind loads without a Raw model", async () => {
  for (const kind of ["claude", "codex", "agy"] as const) {
    const runtime = await load({ backend: { kind, model: "m1", effort: "high", mode: "auto" }, system_prompt: "Be brief.",
      tools: { use: ["builtin/todo"] } });
    assert.equal(runtime.modelConfig, undefined);
    assert.deepEqual({ ...runtime.backend }, { kind, model: "m1", effort: "high", mode: "auto", systemPromptMode: "replace" });
    assert.equal(runtime.systemPrompt, "Be brief.");
    assert.deepEqual(runtime.toolIds, ["builtin/todo"]);
  }
  const append = await load({ backend: { kind: "claude", system_prompt_mode: "append", executable: "/opt/claude" }, tools: { use: [] } });
  assert.equal(append.backend?.systemPromptMode, "append");
  assert.equal(append.backend?.executable, "/opt/claude");
});

test("ambiguous or malformed backend blocks fail with messages naming the field", async () => {
  const cases: Array<[unknown, string]> = [
    [{ model: "local", backend: { kind: "codex" }, tools: { use: [] } }, "agent a must choose model or backend"],
    [{ backend: { kind: "gemini" }, tools: { use: [] } }, "agent a.backend.kind must be claude, codex or agy"],
    [{ backend: { kind: "codex", model: "" }, tools: { use: [] } }, "agent a.backend.model must be a nonempty string"],
    [{ backend: { kind: "codex", effort: " " }, tools: { use: [] } }, "agent a.backend.effort must be a nonempty string"],
    [{ backend: { kind: "codex", system_prompt_mode: "merge" }, tools: { use: [] } }, 'agent a.backend.system_prompt_mode must be "replace" or "append"'],
    [{ backend: { kind: "agy", tools: ["ok", ""] }, tools: { use: [] } }, "agent a.backend.tools must be an array of nonempty strings"],
    [{ backend: { kind: "codex", colour: "red" }, tools: { use: [] } }, "unknown agent a.backend field: colour"],
    [{ backend: "codex", tools: { use: [] } }, "agent a.backend must be an object"],
    [{ backend: { kind: "codex", system_prompt_mode: null }, tools: { use: [] } }, 'agent a.backend.system_prompt_mode must be "replace" or "append"'],
  ];
  for (const [agent, message] of cases) await assert.rejects(load(agent), { message });
});

test("loop-only settings and hooks on a backend agent load and are reported, not rejected", async () => {
  const runtime = await load({ backend: { kind: "codex" }, request: { reasoning_effort: "nonsense" }, cache: { mode: "x" },
    compact: { trigger_tokens: 5 }, max_steps: 3, hooks: { use: ["local/check"] }, tools: { use: ["builtin/bash", "builtin/todo"] } });
  assert.deepEqual(runtime.backendIgnoredSettings, ["request", "cache", "compact", "max_steps"]);
  const result = classifyForBackend(runtime);
  assert.deepEqual(result.bridged, ["builtin/todo"]);
  assert.deepEqual(result.warnings, [
    'codex agent "a" skips builtin/bash: Codex uses its own shell tool',
    'codex agent "a" skips hooks: Raw hooks do not run for an external backend',
    'codex agent "a" skips request: it configures Raw\'s own agent loop',
    'codex agent "a" skips cache: it configures Raw\'s own agent loop',
    'codex agent "a" skips compact: it configures Raw\'s own agent loop',
    'codex agent "a" skips max_steps: it configures Raw\'s own agent loop',
  ]);
});

test("the shell warning names each backend", async () => {
  const names = { claude: "Claude Code", codex: "Codex", agy: "agy" } as const;
  for (const kind of ["claude", "codex", "agy"] as const) {
    const runtime = await loadConfig({ configPath: configFile({ [`e2e-${kind}`]: { backend: { kind },
      system_prompt: "Begin every answer with [RAW_E2E].", tools: { use: ["builtin/todo", "builtin/bash"] } } }), env: {} });
    assert.deepEqual(classifyForBackend(runtime).warnings, [...kind === "agy" ? ['agy agent "e2e-agy" skips builtin/todo: Raw tools are unavailable with agy'] : [],
      `${kind} agent "e2e-${kind}" skips builtin/bash: ${names[kind]} uses its own shell tool`]);
  }
});

test("agy gets no Raw tools: every tool another backend reaches through the bridge is skipped with a warning", async () => {
  const runtime = await load({ backend: { kind: "agy" }, tools: { use: ["builtin/todo", "builtin/ask_user", "local/mine", "mcp/srv/tool"] } });
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
  const runtime = await load({ backend: { kind: "claude" }, tools: { use: [...bundled, "local/mine", "agent/note", "mcp/srv/tool"] } });
  const result = classifyForBackend({ ...runtime, toolIds: [...runtime.toolIds, "pkg/kit/tools/echo"] });
  assert.deepEqual([...result.bridged].sort(), [...BRIDGED_BUILTINS, "local/mine", "agent/note", "mcp/srv/tool", "pkg/kit/tools/echo"].sort());
  assert.deepEqual(result.skipped.map((item) => item.id).sort(), Object.keys(NATIVE_DUPLICATES).sort());
});

test("rules that only match skipped tools warn that they cannot be enforced", async () => {
  const runtime = await load({ backend: { kind: "codex" }, tools: { use: ["builtin/bash", "builtin/todo"], rules: [
    { match: "builtin/bash", effect: "ask" }, { match: "builtin/*", effect: "ask" }, { match: "builtin/todo", effect: "deny" }] } });
  const warnings = classifyForBackend(runtime).warnings;
  assert.ok(warnings.includes('rule "builtin/bash" cannot be enforced on Codex\'s own tools'));
  assert.equal(warnings.filter((line) => line.startsWith("rule ")).length, 1);
  // The CLI keeps its own shell whether or not Raw selects builtin/bash, so the rule warns either way.
  const unselected = await load({ backend: { kind: "codex" }, tools: { use: [], rules: [{ match: "builtin/bash", effect: "deny" }] } });
  assert.deepEqual(classifyForBackend(unselected).warnings, ['rule "builtin/bash" cannot be enforced on Codex\'s own tools']);
});

test("backend.tools on a non-agy backend is reported and ignored", async () => {
  const runtime = await load({ backend: { kind: "claude", tools: ["run_command"] }, tools: { use: [] } });
  assert.deepEqual(classifyForBackend(runtime).warnings, ['claude agent "a" skips backend.tools: it applies to agy only']);
});

test("an agent without backend is unchanged and has no backend fields", async () => {
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

test("a package agent binding may choose a backend instead of a model", async () => {
  const previous = process.env.XDG_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "raw-backend-binding-"));
  const dataHome = join(root, "data");
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const write = (agent: Record<string, unknown>) => {
      const path = join(root, "config.json");
      writeFileSync(path, JSON.stringify({ default_agent: "writer", models: MODELS, agents: { writer: agent } }));
      return path;
    };
    const configPath = write({ from: "pkg/kit/agents/writer", backend: { kind: "codex", model: "gpt-x" } });
    await installPackage({ configPath, dataHome, source: packageSource(), alias: "kit" });
    const runtime = await loadConfig({ configPath });
    assert.equal(runtime.modelConfig, undefined);
    assert.equal(runtime.backend?.kind, "codex");
    assert.equal(runtime.backend?.model, "gpt-x");
    assert.equal(runtime.systemPrompt, "package prompt");
    assert.deepEqual(runtime.toolIds, ["builtin/todo"]);
    await assert.rejects(loadConfig({ configPath: write({ from: "pkg/kit/agents/writer", model: "local", backend: { kind: "codex" } }) }),
      { message: "package agent binding must choose model or backend" });
    await assert.rejects(loadConfig({ configPath: write({ from: "pkg/kit/agents/writer" }) }),
      { message: "package agent binding requires model or backend" });
    const modelRuntime = await loadConfig({ configPath: write({ from: "pkg/kit/agents/writer", model: "local" }), requireModel: false });
    assert.equal(modelRuntime.modelConfig?.modelAlias, "local");
    assert.equal(modelRuntime.backend, undefined);
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
  }
});

test("the agent editor round-trips a backend block and choosing one source drops the other", async () => {
  const configPath = configFile({ a: { model: "local", tools: { use: [] } } });
  await editAgent({ configPath }, { action: "patch", name: "a", value: { backend: { kind: "claude", model: "haiku" } } });
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
    write({ backend: { kind: "codex" }, tools: { use: [] }, hooks: { use: ["pkg/old/hooks/check"] } });
    await installPackage({ configPath, dataHome, source, alias: "old" });
    const runtime = await loadConfig({ configPath });
    assert.deepEqual(runtime.hookIds, ["pkg/old/hooks/check"]);
    assert.deepEqual(classifyForBackend(runtime).warnings, ['codex agent "a" skips hooks: Raw hooks do not run for an external backend']);
    write({ model: "local", tools: { use: [] }, hooks: { use: ["pkg/old/hooks/check"] } });
    await assert.rejects(loadConfig({ configPath }), /requires unsupported host capability raw\.hook\/1/);
  });
});

test("an exported backend agent installs and binds to the recipient's own backend or model", async () => {
  await withDataHome(async (root, dataHome) => {
    const authorPath = configFile({ writer: { backend: { kind: "codex", model: "gpt-x" }, system_prompt: "author prompt", tools: { use: ["builtin/todo"] } } });
    const out = join(root, "out");
    await exportAgentPackage({ configPath: authorPath, agentName: "writer", out, name: "@test/exported", version: "1.0.0" });
    const configPath = join(root, "config.json");
    const write = (agent: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ default_agent: "w", models: MODELS, agents: { w: agent } }));
    write({ from: "pkg/ex/agents/writer", backend: { kind: "claude" } });
    await installPackage({ configPath, dataHome, source: out, alias: "ex" });
    const runtime = await loadConfig({ configPath });
    assert.equal(runtime.backend?.kind, "claude");
    assert.equal(runtime.backend?.model, undefined);
    assert.equal(runtime.systemPrompt, "author prompt");
    write({ from: "pkg/ex/agents/writer", model: "local" });
    assert.equal((await loadConfig({ configPath, requireModel: false })).modelConfig?.modelAlias, "local");
  });
});

test("a package binding's backend block is validated like an agent's, and the editor refuses an invalid one", async () => {
  await withDataHome(async (root, dataHome) => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: MODELS,
      agents: { writer: { from: "pkg/kit/agents/writer", backend: { kind: "codex" } } } }));
    await installPackage({ configPath, dataHome, source: packageSource(), alias: "kit" });
    await assert.rejects(editAgent({ configPath }, { action: "patch", name: "writer", value: { backend: { kind: "gemini" } } }),
      { message: "package agent binding backend.kind must be claude, codex or agy" });
    assert.equal((await loadConfig({ configPath })).backend?.kind, "codex");
  });
});

test("exporting a backend agent still packages the hooks it selects", async () => {
  await withDataHome(async (root, dataHome) => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: MODELS,
      agents: { a: { backend: { kind: "codex" }, tools: { use: [] }, hooks: { use: ["pkg/kit/hooks/check"] } } } }));
    await installPackage({ configPath, dataHome, source: hookPackage("raw.hook/2"), alias: "kit" });
    const out = join(root, "out");
    await exportAgentPackage({ configPath, agentName: "a", out, name: "@test/with-hook", version: "1.0.0" });
    const agent = JSON.parse(readFileSync(join(out, "agents", "a.json"), "utf8")) as { hooks?: { use: string[] }; backend?: unknown };
    assert.deepEqual(agent.hooks?.use, ["#hooks/check"]);
    assert.equal(agent.backend, undefined);
  });
});
