import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVariableConfig, loadConfig } from "../src/config.js";

function fixture(extra: Record<string, unknown> = {}, selection: unknown = ["zero", "clock", "missing"]) {
  const dir = mkdtempSync(join(tmpdir(), "raw-vars-config-"));
  const path = join(dir, "raw.json");
  writeFileSync(path, JSON.stringify({ default_agent: "raw", models: { cloud: { provider: "openai", method: "openai-chat-completions", model_id: "test", api_key_env: "MISSING" } },
    agents: { raw: { model: "cloud", tools: { use: [] }, system_prompt_file: "absent.md", vars: selection } },
    vars: { zero: { description: "zero", access: "read", source: { kind: "literal", value: 0 } }, clock: { description: "time", access: "read", source: { kind: "provider", name: "system.time" } },
      missing: { description: "not read yet", access: "use", source: { kind: "file", path: "missing.json", format: "json" } } }, ...extra }));
  return { path, dir };
}

test("vars-only projection is frozen, selected and does not load credentials/prompt/source", () => {
  const { path, dir } = fixture();
  const result = loadVariableConfig({ configPath: path, env: {} });
  assert.deepEqual(result.variables.map(v => v.name), ["zero", "clock", "missing"]);
  assert.deepEqual(result.variables.map(v => v.type), ["number", "string", "json"]);
  assert.equal(result.variables[2]!.source.kind, "file");
  assert.equal(result.configDir, dir);
  assert.ok(Object.isFrozen(result.variables));
  assert.ok(Object.isFrozen(result.variables[0]!.source));
});

test("all JSON literal kinds retain values and infer types; absent selection is empty", async () => {
  for (const value of [null, false, 0, "", [], {}]) {
    const { path } = fixture({ vars: { x: { description: "x", access: "read", source: { kind: "literal", value } } } }, ["x"]);
    assert.deepEqual((loadVariableConfig({ configPath: path }).variables[0]!.source as { value: unknown }).value, value);
  }
  const { path } = fixture({}, undefined);
  assert.equal(loadVariableConfig({ configPath: path, flags: { agent: "raw" } }).agentName, "raw");
  const f = fixture({}, []);
  assert.deepEqual(loadVariableConfig({ configPath: f.path }).variables, []);
  await assert.rejects(loadConfig({ configPath: path, env: {} }), /credential/);
});

test("strict vars declarations reject invalid types, fields, timers, and references", () => {
  const good = { description: "x", access: "read", source: { kind: "literal", value: 1 } };
  for (const bad of [{ ...good, access: "write" }, { ...good, unknown: 1 }, { ...good, type: "string" }, { ...good, cache_ttl_ms: -1 }, { ...good, cache_ttl_ms: 2147483648 },
    { ...good, source: { kind: "env", name: "NOT VALID" } }, { ...good, source: { kind: "provider", name: "absent" } },
    { ...good, source: { kind: "provider", name: "system.time", params: { x: 1 } } }, { ...good, source: { kind: "file", path: "x", format: "binary" } }]) {
    const { path } = fixture({ vars: { x: bad } }, ["x"]);
    assert.throws(() => loadVariableConfig({ configPath: path }), /vars|provider/);
  }
  for (const names of [["zero", "zero"], ["absent"], "zero"]) {
    const { path } = fixture({}, names); assert.throws(() => loadVariableConfig({ configPath: path }), /vars/);
  }
  const { path } = fixture({ var_providers: { "system.time": { command: "node" } } });
  assert.throws(() => loadVariableConfig({ configPath: path }), /reserved/);
});

test("provider paths/defaults are static and unselected malformed declarations still fail", () => {
  const { path, dir } = fixture({ var_providers: { sensor: { command: "./bin/sensor", args: ["script.js"] } },
    vars: { x: { description: "x", access: "read", source: { kind: "provider", name: "sensor", params: { field: "c" } } } } }, ["x"]);
  const spec = loadVariableConfig({ configPath: path }).providers.sensor!;
  assert.equal(spec.command, join(dir, "bin/sensor")); assert.equal(spec.cwd, dir); assert.equal(spec.timeoutMs, 5000);
  const bad = fixture({ vars: { unselected: { source: { kind: "literal", value: 1 } } } }, []);
  assert.throws(() => loadVariableConfig({ configPath: bad.path }), /vars/);
});
