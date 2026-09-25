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

test("T-01a: profile selects an exact model alias and CLI wins over RAW_PROFILE", async () => {
  const { home } = fixture({ default_profile: "local-a", models: {
    a: model("ollama", "upstream-a", "http://127.0.0.1:9001/v1"),
    b: model("ollama", "upstream-b", "http://127.0.0.1:9002/v1"),
  }, profiles: { "local-a": { model: "a", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } }, "local-b": { model: "b", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
  const baseline = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(baseline.profile?.name, "local-a");
  assert.equal(baseline.profile?.model, "upstream-a");
  assert.equal(baseline.profile?.baseUrl, "http://127.0.0.1:9001/v1");
  const selected = await loadConfig({ home, env: { RAW_PROFILE: "local-b" }, requireModel: true });
  assert.equal(selected.profile?.model, "upstream-b");
  const flagged = await loadConfig({ home, env: { RAW_PROFILE: "local-b" }, flags: { profile: "local-a" }, requireModel: true });
  assert.equal(flagged.profile?.model, "upstream-a");
});

test("T-01a: missing references, duplicate JSON names and invalid output limit fail early", async () => {
  const missing = fixture({ default_profile: "missing", models: {}, profiles: {} });
  await assert.rejects(loadConfig({ home: missing.home, env: {}, requireModel: true }), /unknown profile/i);
  const duplicate = fixture('{"models":{"x":{"provider":"ollama","method":"openai-chat-completions","model_id":"a"},"x":{"provider":"ollama","method":"openai-chat-completions","model_id":"b"}},"profiles":{"x":{"model":"x"}}}');
  await assert.rejects(loadConfig({ home: duplicate.home, env: {}, requireModel: true }), /duplicate/i);
  const bad = fixture({ default_profile: "x", models: { x: { ...model("ollama", "a"), context_window_tokens: 100, max_output_tokens: 100 } }, profiles: { x: { model: "x", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
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
  const { home } = fixture({ default_profile: "local", models: {
    local: model("ollama", "small"),
    cloud: { ...model("openai", "hosted"), api_key_env: "CUSTOM_KEY" },
  }, profiles: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } }, cloud: { model: "cloud", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
  const local = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(local.profile?.provider, "ollama");
  assert.equal(local.resolveCompactProfile().model, "small");
  await assert.rejects(loadConfig({ home, env: {}, flags: { profile: "cloud" }, requireModel: true }), /CUSTOM_KEY/);
  const cloud = await loadConfig({ home, env: { CUSTOM_KEY: "secret" }, flags: { profile: "cloud" }, requireModel: true });
  assert.equal(cloud.profile?.apiKey, "secret");
  assert.equal(cloud.resolveCompactProfile().apiKey, "secret");
});

test("T-01b: redaction, malformed JSON, default endpoints and immutable settings", async () => {
  const masked = redact("https://alice:pw@example.com/v1?token=secret-value", ["secret-value"]);
  assert.doesNotMatch(masked, /alice|pw|secret-value/);
  const invalid = fixture("{not-json");
  await assert.rejects(loadConfig({ home: invalid.home, env: {}, requireModel: true }), /JSON|config/i);
  const { home } = fixture({ default_profile: "local", models: { local: model("ollama", "small") },
    profiles: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] }, cache: { mode: "auto" } } } });
  await assert.rejects(loadConfig({ home, env: { RAW_BASE_URL: "http://127.0.0.1:9999/v1" }, requireModel: true }), /RAW_BASE_URL/);
  const config = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(config.profile?.baseUrl, "http://127.0.0.1:11434/v1");
  for (const value of [config, config.profile, config.profile?.cache, config.compact]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (config as { maxSteps: number }).maxSteps = 0; }, TypeError);
});

test("T-01a: inherited object names stay positional task strings", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    assert.deepEqual(parseCliArgs([name]), { command: "task", task: name, flags: {} });
  }
});
