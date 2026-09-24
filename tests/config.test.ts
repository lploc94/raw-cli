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

test("T-01a: named profiles select distinct endpoints and obey explicit precedence", async () => {
  const { home } = fixture({
    default_profile: "local-a",
    profiles: {
      "local-a": { provider: "openai-compatible", model: "a", base_url: "http://127.0.0.1:9001/v1" },
      "local-b": { provider: "openai-compatible", model: "b", base_url: "http://127.0.0.1:9002/v1" },
    },
  });
  const baseline = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(baseline.profile?.name, "local-a");
  assert.equal(baseline.autoApprove, true);
  assert.equal(baseline.profile?.baseUrl, "http://127.0.0.1:9001/v1");
  const selected = await loadConfig({ home, env: { RAW_PROFILE: "local-b", RAW_MODEL: "env-model" }, requireModel: true });
  assert.equal(selected.profile?.baseUrl, "http://127.0.0.1:9002/v1");
  assert.equal(selected.profile?.model, "env-model");
  const flagged = await loadConfig({ home, env: { RAW_PROFILE: "local-b", RAW_MODEL: "env-model" }, flags: { profile: "local-a", model: "flag-model" }, requireModel: true });
  assert.equal(flagged.profile?.name, "local-a");
  assert.equal(flagged.profile?.model, "flag-model");
});

test("T-01a: missing/invalid profiles, duplicate JSON names and invalid limits fail early", async () => {
  const { home } = fixture({ default_profile: "missing", profiles: {} });
  await assert.rejects(loadConfig({ home, env: {}, requireModel: true }), /unknown profile/i);
  const duplicate = fixture('{"default_profile":"x","profiles":{"x":{"provider":"ollama","model":"a"},"x":{"provider":"ollama","model":"b"}}}');
  await assert.rejects(loadConfig({ home: duplicate.home, env: {}, requireModel: true }), /duplicate/i);
  const bad = fixture({ default_profile: "x", profiles: { x: { provider: "ollama", model: "a", context_window: 100, max_output_tokens: 100 } } });
  await assert.rejects(loadConfig({ home: bad.home, env: {}, requireModel: true }), /max_output_tokens/i);
  assert.throws(() => parseCliArgs(["--max-steps", "0", "task"]), /max-steps/i);
  assert.throws(() => parseCliArgs(["--unknown", "task"]), /unknown/i);
});

test("T-01a: direct config-free options and explicitly missing config", async () => {
  const home = mkdtempSync(join(tmpdir(), "raw-noconfig-"));
  const direct = await loadConfig({ home, env: { RAW_PROVIDER: "ollama", RAW_MODEL: "small" }, requireModel: true });
  assert.equal(direct.profile?.provider, "ollama");
  assert.equal(direct.profile?.model, "small");
  await assert.rejects(loadConfig({ home, env: {}, configPath: join(home, "missing.json"), requireModel: true }), /config/i);
  await assert.rejects(loadConfig({ home, env: {}, requireModel: true }), /provider|model/i);
});

test("T-01b: unused cloud keys stay unresolved; selected key and compact key resolve on use", async () => {
  const { home } = fixture({
    default_profile: "local",
    profiles: {
      local: { provider: "ollama", model: "small" },
      cloud: { provider: "openai", model: "hosted", api_key_env: "CUSTOM_KEY" },
    },
    compact: { profile: "cloud" },
  });
  const local = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(local.profile?.provider, "ollama");
  assert.equal(local.compact.profile, "cloud");
  assert.throws(() => local.resolveCompactProfile(), /CUSTOM_KEY/);
  await assert.rejects(loadConfig({ home, env: {}, flags: { profile: "cloud" }, requireModel: true }), /CUSTOM_KEY/);
  const cloud = await loadConfig({ home, env: { CUSTOM_KEY: "secret" }, flags: { profile: "cloud" }, requireModel: true });
  assert.equal(cloud.profile?.apiKey, "secret");
  assert.equal(cloud.resolveCompactProfile().apiKey, "secret");
});

test("T-01b: conflicting endpoint/provider overrides are rejected and errors redact URL secrets", async () => {
  const { home } = fixture({ default_profile: "cloud", profiles: { cloud: { provider: "openai", model: "hosted", api_key_env: "KEY" } } });
  const env = { KEY: "secret-value" };
  await assert.rejects(loadConfig({ home, env, flags: { provider: "anthropic" }, requireModel: true }), /conflict/i);
  await assert.rejects(loadConfig({ home, env, flags: { baseUrl: "https://evil.example/v1" }, requireModel: true }), /conflict/i);
  const masked = redact("https://alice:pw@example.com/v1?token=secret-value", ["secret-value"]);
  assert.doesNotMatch(masked, /alice|pw|secret-value/);
});

test("T-01b: invalid config fails before any provider or MCP connection", async () => {
  const { home } = fixture("{not-json");
  await assert.rejects(loadConfig({ home, env: {}, requireModel: true }), /JSON|config/i);
});

test("T-01a: provider-default URL may be explicitly repeated without a conflict", async () => {
  const { home } = fixture({ default_profile: "local", profiles: { local: { provider: "ollama", model: "small" } } });
  const config = await loadConfig({ home, env: { RAW_BASE_URL: "http://127.0.0.1:11434/v1" }, requireModel: true });
  assert.equal(config.profile?.baseUrl, "http://127.0.0.1:11434/v1");
  await assert.rejects(loadConfig({ home, env: { RAW_BASE_URL: "http://127.0.0.1:9999/v1" }, requireModel: true }), /conflict/i);
});

test("T-01b: compact source resolves the same provider endpoint defaults", async () => {
  const { home } = fixture({ default_profile: "local", profiles: {
    local: { provider: "ollama", model: "small" },
    router: { provider: "openrouter", model: "hosted" },
  }, compact: { profile: "router" } });
  const config = await loadConfig({ home, env: { OPENROUTER_API_KEY: "fixture" }, requireModel: true });
  assert.equal(config.profile?.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.resolveCompactProfile().baseUrl, "https://openrouter.ai/api/v1");
});

test("T-01a: inherited object names stay positional task strings", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    assert.deepEqual(parseCliArgs([name]), { command: "task", task: name, flags: {} });
  }
});

test("T-01b: validated settings and nested profile/cache cannot be mutated", async () => {
  const { home } = fixture({ default_profile: "cloud", profiles: {
    cloud: { provider: "openai", model: "hosted", cache: { mode: "auto" } },
  }, compact: { profile: "cloud" } });
  const config = await loadConfig({ home, env: { OPENAI_API_KEY: "fixture" }, requireModel: true });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.profile));
  assert.ok(Object.isFrozen(config.profile?.cache));
  assert.ok(Object.isFrozen(config.compact));
  assert.ok(Object.isFrozen(config.resolveCompactProfile()));
  assert.throws(() => { (config as { maxSteps: number }).maxSteps = 0; }, TypeError);
  assert.throws(() => { (config.profile as { baseUrl: string }).baseUrl = "https://evil.example/v1"; }, TypeError);
});
