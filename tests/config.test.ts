import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseCliArgs, redact } from "../src/config.js";

function fixture(contents: unknown): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "raw-config-"));
  const directory = join(home, ".config", "raw");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return { home, path };
}

const model = (provider: string, modelId: string, baseUrl?: string) => ({ provider, method: "openai-chat-completions",
  model_id: modelId, ...(baseUrl === undefined ? {} : { base_url: baseUrl }) });

test("T-01a: agent selects an exact model alias and CLI wins over RAW_AGENT", async () => {
  const { home } = fixture({ default_agent: "local-a", models: {
    a: model("ollama", "upstream-a", "http://127.0.0.1:9001/v1"),
    b: model("ollama", "upstream-b", "http://127.0.0.1:9002/v1"),
  }, agents: { "local-a": { model: "a", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } }, "local-b": { model: "b", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
  const baseline = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(baseline.modelConfig?.agentName, "local-a");
  assert.equal(baseline.modelConfig?.model, "upstream-a");
  assert.equal(baseline.modelConfig?.baseUrl, "http://127.0.0.1:9001/v1");
  const selected = await loadConfig({ home, env: { RAW_AGENT: "local-b" }, requireModel: true });
  assert.equal(selected.modelConfig?.model, "upstream-b");
  const flagged = await loadConfig({ home, env: { RAW_AGENT: "local-b" }, flags: { agent: "local-a" }, requireModel: true });
  assert.equal(flagged.modelConfig?.model, "upstream-a");
});

test("T-01a: missing references, duplicate JSON names and invalid output limit fail early", async () => {
  const missing = fixture({ default_agent: "missing", models: {}, agents: {} });
  await assert.rejects(loadConfig({ home: missing.home, env: {}, requireModel: true }), /unknown agent/i);
  const duplicate = fixture('{"models":{"x":{"provider":"ollama","method":"openai-chat-completions","model_id":"a"},"x":{"provider":"ollama","method":"openai-chat-completions","model_id":"b"}},"agents":{"x":{"model":"x"}}}');
  await assert.rejects(loadConfig({ home: duplicate.home, env: {}, requireModel: true }), /duplicate/i);
  const bad = fixture({ default_agent: "x", models: { x: { ...model("ollama", "a"), context_window_tokens: 100, max_output_tokens: 100 } }, agents: { x: { model: "x", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
  await assert.rejects(loadConfig({ home: bad.home, env: {}, requireModel: true }), /max_output_tokens/i);
  assert.throws(() => parseCliArgs(["--max-steps", "0", "task"]), /max-steps/i);
  assert.throws(() => parseCliArgs(["--unknown", "task"]), /unknown/i);
});

test("T-01a: missing config and removed direct overrides fail", async () => {
  const home = mkdtempSync(join(tmpdir(), "raw-noconfig-"));
  await assert.rejects(loadConfig({ home, env: { RAW_PROVIDER: "ollama", RAW_MODEL: "small" }, requireModel: true }), /RAW_PROVIDER/);
  await assert.rejects(loadConfig({ home, env: {}, configPath: join(home, "missing.json"), requireModel: true }), /config/i);
  for (const flag of ["--provider", "--model", "--base-url"]) assert.throws(() => parseCliArgs([flag, "x", "task"]), /unknown option/);
});

test("T-01b: only selected credential resolves; compact uses selected model", async () => {
  const { home } = fixture({ default_agent: "local", models: {
    local: model("ollama", "small"),
    cloud: { ...model("openai", "hosted"), api_key_env: "CUSTOM_KEY" },
  }, agents: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } }, cloud: { model: "cloud", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
  const local = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(local.modelConfig?.provider, "ollama");
  assert.equal(local.resolveCompactModelConfig().model, "small");
  await assert.rejects(loadConfig({ home, env: {}, flags: { agent: "cloud" }, requireModel: true }), /CUSTOM_KEY/);
  const cloud = await loadConfig({ home, env: { CUSTOM_KEY: "secret" }, flags: { agent: "cloud" }, requireModel: true });
  assert.equal(cloud.modelConfig?.apiKey, "secret");
  assert.equal(cloud.resolveCompactModelConfig().apiKey, "secret");
});

test("T-01b: redaction, malformed JSON, default endpoints and immutable settings", async () => {
  const masked = redact("https://alice:pw@example.com/v1?token=secret-value", ["secret-value"]);
  assert.doesNotMatch(masked, /alice|pw|secret-value/);
  const invalid = fixture("{not-json");
  await assert.rejects(loadConfig({ home: invalid.home, env: {}, requireModel: true }), /JSON|config/i);
  const { home } = fixture({ default_agent: "local", models: { local: model("ollama", "small") },
    agents: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] }, cache: { mode: "auto" } } } });
  await assert.rejects(loadConfig({ home, env: { RAW_BASE_URL: "http://127.0.0.1:9999/v1" }, requireModel: true }), /RAW_BASE_URL/);
  const config = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(config.modelConfig?.baseUrl, "http://127.0.0.1:11434/v1");
  for (const value of [config, config.modelConfig, config.modelConfig?.cache, config.compact]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (config as { maxSteps: number }).maxSteps = 0; }, TypeError);
});

test("T-01a: inherited object names stay positional task strings", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    assert.deepEqual(parseCliArgs([name]), { command: "task", task: name, flags: {} });
  }
});

test("compact summary output defaults to 16k, bounded by the model and kept above a manual thinking budget", async () => {
  const tools = { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] };
  const load = async (models: Record<string, unknown>, agent: Record<string, unknown> = {}) => {
    const { home } = fixture({ default_agent: "x", models, agents: { x: { model: "x", tools, ...agent } } });
    return (await loadConfig({ home, env: {}, requireModel: true })).compact.maxOutputTokens;
  };
  assert.equal(await load({ x: model("ollama", "a") }), 16384);
  assert.equal(await load({ x: { ...model("ollama", "a"), context_window_tokens: 1048576 } }), 16384);
  assert.equal(await load({ x: { ...model("ollama", "a"), context_window_tokens: 32768 } }, { compact: { trigger_tokens: 24000 } }), 8192);
  assert.equal(await load({ x: { ...model("ollama", "a"), max_output_tokens: 4096 } }), 4096);
  assert.equal(await load({ x: { ...model("ollama", "a"), context_window_tokens: 1048576 } }, { compact: { max_output_tokens: 512 } }), 512);
  assert.equal(await load({ x: { provider: "anthropic", method: "anthropic-messages", model_id: "m", api_key: "k", max_output_tokens: 64000 } },
    { request: { max_output_tokens: 40000, thinking: { type: "enabled", budget_tokens: 20000 } } }), 40000);
});
