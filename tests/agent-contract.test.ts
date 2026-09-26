import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, parseCliArgs } from "../src/config.js";
import { initializeSessionSchema, SESSION_SCHEMA_VERSION } from "../src/sessions/schema.js";

function setupConfig() {
  const home = mkdtempSync(join(tmpdir(), "raw-agent-contract-"));
  const root = join(home, ".config", "raw");
  mkdirSync(root, { recursive: true });
  const model = (id: string) => ({ provider: "ollama", method: "openai-chat-completions", model_id: id });
  writeFileSync(join(root, "config.json"), JSON.stringify({
    default_agent: "raw", models: { local: model("local-model"), cloud: model("cloud-model") },
    agents: { raw: { model: "local", tools: { use: [] } }, deepseek: { model: "cloud", tools: { use: [] } } },
  }));
  return home;
}

test("agent selector uses explicit flag, then environment, then configured default", async () => {
  const home = setupConfig();
  const baseline = await loadConfig({ home, env: {}, requireModel: true });
  assert.equal(baseline.agentName, "raw");
  assert.equal(baseline.modelConfig?.model, "local-model");
  const selected = await loadConfig({ home, env: { RAW_AGENT: "deepseek" }, requireModel: true });
  assert.equal(selected.agentName, "deepseek");
  assert.equal(selected.modelConfig?.model, "cloud-model");
  const flagged = await loadConfig({ home, env: { RAW_AGENT: "deepseek" }, flags: { agent: "raw" }, requireModel: true });
  assert.equal(flagged.agentName, "raw");
  assert.deepEqual(parseCliArgs(["--agent", "deepseek", "query"]).flags, { agent: "deepseek" });
  assert.throws(() => parseCliArgs(["--profile", "raw", "query"]), /unknown option/);
});

test("legacy config and environment selectors fail", async () => {
  const home = setupConfig();
  await assert.rejects(loadConfig({ home, env: { RAW_PROFILE: "deepseek" }, requireModel: true }), /RAW_PROFILE/);
  writeFileSync(join(home, ".config", "raw", "config.json"), JSON.stringify({ default_profile: "raw", profiles: {} }));
  await assert.rejects(loadConfig({ home, env: {}, requireModel: true }), /default_profile|profiles/);
});

test("fresh session schema is v5 with agent_name and rejects v3", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeSessionSchema(database);
    assert.equal(SESSION_SCHEMA_VERSION, 5);
    const columns = database.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
    assert.ok(columns.includes("agent_name"));
    assert.ok(!columns.includes("profile_name"));
  } finally { database.close(); }
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec("PRAGMA user_version = 3");
    assert.throws(() => initializeSessionSchema(legacy), /unsupported session schema version: 3/);
  } finally { legacy.close(); }
});
