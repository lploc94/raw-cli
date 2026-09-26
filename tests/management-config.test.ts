import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readManagedConfig, mutateConfig, saveConfigText, initializeConfig } from "../src/management/config.js";
import { createStarterConfig } from "../src/management/starter.js";
import { editAgent, editModel } from "../src/management/agents.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-management-"));
  const env = { XDG_CONFIG_HOME: root }; const path = join(root, "raw", "config.json");
  mkdirSync(join(root, "raw"));
  const data = { default_agent: "one", models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture",
    api_key: "preserve-fixture-secret" } }, agents: { one: { model: "local", system_prompt: "original", tools: { use: ["builtin/bash", "builtin/read_file"] } },
      two: { model: "local", max_steps: 7, tools: { use: [] } } } };
  writeFileSync(path, JSON.stringify(data));
  return { root, path, data, options: { configPath: path, env }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test("revision-aware edits preserve unrelated secrets, supported fields and ordered selections", async () => {
  const f = fixture();
  try {
    const before = await readManagedConfig(f.options);
    const after = await editAgent({ ...f.options, expectedRevision: before.revision }, { action: "patch", name: "one", value: { system_prompt: "updated" } });
    assert.deepEqual((after.data!.agents as typeof f.data.agents).two, f.data.agents.two);
    assert.deepEqual((after.data!.agents as typeof f.data.agents).one.tools.use, f.data.agents.one.tools.use);
    assert.deepEqual(after.data!.models, f.data.models);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    await assert.rejects(editAgent({ ...f.options, expectedRevision: before.revision }, { action: "patch", name: "two", value: { max_steps: 9 } }), /conflict/i);
    assert.equal(readFileSync(f.path, "utf8"), after.source);
  } finally { f.cleanup(); }
});

test("serialized writers and an external edit during an async mutation cannot overwrite newer bytes", async () => {
  const f = fixture();
  try {
    const before = await readManagedConfig(f.options);
    const results = await Promise.allSettled([1, 2].map((n) => mutateConfig({ ...f.options, expectedRevision: before.revision }, (data) => {
      (data.agents as Record<string, Record<string, unknown>>).one!.max_steps = n + 1;
    })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const current = await readManagedConfig(f.options);
    const external = JSON.stringify({ ...f.data, default_agent: "two" });
    await assert.rejects(mutateConfig({ ...f.options, expectedRevision: current.revision }, async (data) => {
      data.default_agent = "one"; writeFileSync(f.path, external);
    }), /conflict/i);
    assert.equal(readFileSync(f.path, "utf8"), external);
  } finally { f.cleanup(); }
});

test("strict candidate validation uses the actual config authority, rejects malformed saves and supports repair", async () => {
  const f = fixture();
  try {
    const before = await readManagedConfig(f.options);
    for (const source of ['{"agents":{},"agents":{}}', '{"models":{},}', '{/* comment */}', '{"alien":true}']) {
      await assert.rejects(saveConfigText({ ...f.options, expectedRevision: before.revision }, source), /JSON|duplicate|unknown/);
      assert.equal(readFileSync(f.path, "utf8"), before.source);
    }
    const alternate = join(f.root, "other.json"); writeFileSync(alternate, "{}");
    const options = { ...f.options, configPath: alternate }; const other = await readManagedConfig(options);
    await assert.rejects(saveConfigText({ ...options, expectedRevision: other.revision }, '{"sessions":{"retention_days":2}}'), /canonical/);
    writeFileSync(f.path, "{broken"); const broken = await readManagedConfig(f.options);
    assert.ok(broken.diagnostic); assert.equal(broken.data, undefined);
    const repaired = await saveConfigText({ ...f.options, expectedRevision: broken.revision }, JSON.stringify(f.data));
    assert.equal(repaired.diagnostic, undefined);
    await assert.rejects(editModel({ ...f.options, expectedRevision: repaired.revision }, { action: "delete", name: "local" }), /used|referenced/);
    await assert.rejects(editAgent({ ...f.options, expectedRevision: repaired.revision }, { action: "delete", name: "one" }), /default/);
  } finally { f.cleanup(); }
});

test("CLI/browser starter factory has the six skills and initialization never overwrites", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-starter-"));
  const options = { configPath: join(root, "raw", "config.json"), env: { XDG_CONFIG_HOME: root } };
  try {
    const initialized = await initializeConfig(options);
    assert.deepEqual(initialized.data, createStarterConfig());
    assert.equal(((initialized.data!.agents as Record<string, { skills: { use: string[] } }>).raw!.skills.use).length, 6);
    await assert.rejects(initializeConfig(options), /already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
