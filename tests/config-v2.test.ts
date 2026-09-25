import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseCliArgs, readConfigDocument, readSessionRetentionDays } from "../src/config.js";
import { createProvider } from "../src/llm/client.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

function fixture(data: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "raw-config-v2-"));
  mkdirSync(join(home, ".config", "raw"), { recursive: true });
  writeFileSync(join(home, ".config", "raw", "config.json"), JSON.stringify(data));
  return home;
}

test("model alias resolves exact upstream ID and two profiles share one access path", async () => {
  const home = fixture({
    default_profile: "fast",
    models: {
      flash: { provider: "deepseek", method: "openai-chat-completions", model_id: "deepseek-flash",
        base_url: "https://api.deepseek.com", api_key_env: "DS_KEY", context_window_tokens: 1048576 },
    },
    profiles: {
      fast: { model: "flash", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] }, max_steps: 5 },
      deep: { model: "flash", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] }, max_steps: 30 },
    },
  });
  const fast = await loadConfig({ home, env: { DS_KEY: "fixture-secret" }, requireModel: true });
  const deep = await loadConfig({ home, env: { DS_KEY: "fixture-secret" }, flags: { profile: "deep" }, requireModel: true });
  assert.equal(fast.profile?.modelAlias, "flash");
  assert.equal(fast.profile?.model, "deepseek-flash");
  assert.equal(fast.profile?.method, "openai-chat-completions");
  assert.equal(fast.profile?.provider, "deepseek");
  assert.equal(fast.maxSteps, 5);
  assert.equal(deep.maxSteps, 30);
  assert.equal(deep.profile?.model, fast.profile?.model);
});

test("direct key and env key are exclusive; inactive env key stays unresolved", async () => {
  const home = fixture({
    default_profile: "local",
    models: {
      local: { provider: "ollama", method: "openai-chat-completions", model_id: "small" },
      cloud: { provider: "custom", method: "openai-chat-completions", model_id: "large",
        base_url: "https://example.com/v1", api_key: "literal-secret" },
      missing: { provider: "anthropic", method: "anthropic-messages", model_id: "remote",
        api_key_env: "NO_SUCH_KEY" },
    },
    profiles: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } }, cloud: { model: "cloud", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } }, missing: { model: "missing", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } },
  });
  const local = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(local.profile?.modelAlias, "local");
  const cloud = await loadConfig({ home, env: {}, flags: { profile: "cloud" }, requireModel: true });
  assert.equal(cloud.profile?.apiKey, "literal-secret");
  assert.doesNotMatch(JSON.stringify(readConfigDocument({ home, env: {} }).data.profiles), /literal-secret/);
  await assert.rejects(loadConfig({ home, env: {}, flags: { profile: "missing" }, requireModel: true }), /NO_SUCH_KEY/);
});

test("flat profile and removed direct model flags are rejected", async () => {
  const home = fixture({ default_profile: "old", profiles: {
    old: { provider: "ollama", model: "small", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } },
  } });
  await assert.rejects(loadConfig({ home, env: {}, requireModel: true }), /models|provider|invalid|unknown/i);
  assert.throws(() => parseCliArgs(["--provider", "ollama", "hello"]), /unknown option/);
  assert.throws(() => parseCliArgs(["--model", "small", "hello"]), /unknown option/);
});

test("local alias is never sent as upstream model ID", async () => {
  const endpoint = await startMockProvider([{ frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] }]);
  try {
    const home = fixture({ default_profile: "run", models: { flash: {
      provider: "deepseek", method: "openai-chat-completions", model_id: "deepseek-flash",
      base_url: endpoint.url, api_key: "fixture-key",
    } }, profiles: { run: { model: "flash", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
    const runtime = await loadConfig({ home, env: {}, requireModel: true });
    await createProvider(runtime.profile!).generate({ system: "tiny", messages: [{ role: "user", content: "hello" }], tools: [], timeoutMs: 1000 });
    assert.equal((endpoint.requests[0]?.body as { model: string }).model, "deepseek-flash");
  } finally { await endpoint.close(); }
});

test("a known service cannot silently use another adapter's default endpoint", async () => {
  const home = fixture({ default_profile: "run", models: { wrong: {
    provider: "openai", method: "anthropic-messages", model_id: "example",
    api_key_env: "OPENAI_API_KEY",
  } }, profiles: { run: { model: "wrong", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } });
  await assert.rejects(loadConfig({ home, env: { OPENAI_API_KEY: "fixture" }, requireModel: true }), /base_url is required/);
});

test("retention defaults to seven days and only canonical config may set it", async () => {
  const home = fixture({});
  assert.equal(readSessionRetentionDays({ home, env: {} }), 7);
  const canonical = join(home, ".config", "raw", "config.json");
  writeFileSync(canonical, JSON.stringify({ sessions: { retention_days: 30 } }));
  assert.equal(readSessionRetentionDays({ home, env: {} }), 30);
  const alternate = join(home, "alternate.json");
  writeFileSync(alternate, JSON.stringify({}));
  const loaded = await loadConfig({ home, env: {}, configPath: alternate, requireModel: false });
  assert.equal(loaded.sessionsRetentionDays, 30);
  writeFileSync(alternate, JSON.stringify({ sessions: { retention_days: 1 } }));
  await assert.rejects(loadConfig({ home, env: {}, configPath: alternate, requireModel: false }), /canonical|global/i);
});

test("retention rejects invalid numbers and unknown settings", () => {
  const home = fixture({});
  const canonical = join(home, ".config", "raw", "config.json");
  for (const value of [0, -1, 1.5, "7", null, true]) {
    writeFileSync(canonical, JSON.stringify({ sessions: { retention_days: value } }));
    assert.throws(() => readSessionRetentionDays({ home, env: {} }), /positive integer/i);
  }
  writeFileSync(canonical, JSON.stringify({ sessions: { retention_days: 7, pin: true } }));
  assert.throws(() => readSessionRetentionDays({ home, env: {} }), /unknown sessions field/i);
});
