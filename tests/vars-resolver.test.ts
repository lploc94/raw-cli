import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseVariableDefinitions, selectVariables } from "../src/vars/config.js";
import { createVariableResolver } from "../src/vars/resolver.js";

function make(vars: Record<string, unknown>, options = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "raw-vars-"));
  const parsed = parseVariableDefinitions(vars, {}, configDir);
  return { dir: configDir, resolver: createVariableResolver({ config: { configDir, providers: parsed.providers,
    variables: selectVariables(Object.keys(vars), parsed.variables, "vars") }, ...options }) };
}
const literal = (value: unknown) => ({ description: "example", access: "read", source: { kind: "literal", value } });
test("metadata is lazy; TTL is monotonic, caches successes, and reads return copies", async () => {
  let clock = 0; const env: NodeJS.ProcessEnv = { TOKEN: "one" };
  const { resolver } = make({ token: { ...literal(""), source: { kind: "env", name: "TOKEN" }, cache_ttl_ms: 100 }, obj: literal({ n: [1] }) }, { env, monotonicNow: () => clock });
  assert.equal(resolver.list().length, 2);
  assert.equal((await resolver.read("token")).value, "one");
  env.TOKEN = "two"; clock = 99; assert.equal((await resolver.read("token")).cached, true);
  clock = 100; assert.equal((await resolver.read("token")).value, "two");
  delete env.TOKEN; clock = 200; await assert.rejects(resolver.read("token"), /var_env_missing/);
  env.TOKEN = ""; assert.equal((await resolver.read("token")).value, "");
  const first = await resolver.read("obj"); (first.value as { n: number[] }).n.push(2);
  assert.deepEqual((await resolver.read("obj")).value, { n: [1] });
});
test("read/use access, actual env scalar types, NUL and abort are enforced", async () => {
  const { resolver } = make({ hidden: { ...literal("a; $(no)\n'"), access: "use", cache_ttl_ms: 1000 }, no: literal(false), zero: literal(0), obj: literal({}), nul: literal("x\0y") });
  assert.deepEqual(await resolver.resolveEnv({ A: "hidden", B: "no", C: "zero" }), { A: "a; $(no)\n'", B: "false", C: "0" });
  await assert.rejects(resolver.read("hidden"), /var_read_denied/);
  assert.throws(() => resolver.validateEnvRefs({ A: "absent" }), /var_not_selected/);
  assert.throws(() => resolver.validateEnvRefs({ A: "obj" }), /var_env_type/);
  await assert.rejects(resolver.resolveEnv({ A: "nul" }), /var_env_nul/);
  await assert.rejects(resolver.read("zero", { signal: AbortSignal.abort() }), /aborted/);
});
test("files decode strict UTF-8, preserve text, and reject invalid/oversized data", async () => {
  const { dir, resolver } = make({ text: { ...literal(""), source: { kind: "file", path: "text" } }, data: { ...literal(""), source: { kind: "file", path: "data", format: "json" } } });
  writeFileSync(join(dir, "text"), "hello\n"); writeFileSync(join(dir, "data"), '{"ok":false}');
  assert.equal((await resolver.read("text")).value, "hello\n"); assert.deepEqual((await resolver.read("data")).value, { ok: false });
  writeFileSync(join(dir, "text"), Buffer.from([0xff])); await assert.rejects(resolver.read("text"), /var_file_invalid/);
  writeFileSync(join(dir, "text"), "a".repeat(65537)); await assert.rejects(resolver.read("text"), /var_file_too_large/);
  writeFileSync(join(dir, "data"), "invalid"); await assert.rejects(resolver.read("data"), /var_file_invalid/);
});
test("system.time is sampled on read, not discovery, and independent resolvers have independent cache", async () => {
  let samples = 0;
  const { resolver } = make({ now: { description: "clock", access: "read", source: { kind: "provider", name: "system.time" } } }, { now: () => { samples++; return 0; } });
  resolver.list(); assert.equal(samples, 0);
  const v = await resolver.read("now"); assert.equal(v.value, "1970-01-01T00:00:00.000Z"); assert.equal(v.observed_at, v.value); assert.equal(samples, 1);
  const vars = { x: { ...literal(""), source: { kind: "env", name: "X" }, cache_ttl_ms: 1000 } };
  assert.equal((await make(vars, { env: { X: "a" } }).resolver.read("x")).value, "a");
  assert.equal((await make(vars, { env: { X: "b" } }).resolver.read("x")).value, "b");
});

test("provider execution is lazy, successful values obey TTL, and type errors are never cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-provider-cache-")); const counter = join(dir, "count"); let clock = 0;
  const defs = parseVariableDefinitions({ sensor: { description: "sensor", type: "object", access: "read", cache_ttl_ms: 100,
    source: { kind: "provider", name: "fixture", params: { field: "a" } } } },
    { fixture: { command: process.execPath, args: [resolve("tests/fixtures/var-provider.mjs"), "ok"] } }, dir);
  const config = { configDir: dir, providers: defs.providers, variables: [defs.variables.sensor!] };
  const resolver = createVariableResolver({ config, env: { VAR_COUNT: counter }, monotonicNow: () => clock });
  resolver.list(); assert.equal(existsSync(counter), false);
  await resolver.read("sensor"); await resolver.read("sensor"); assert.equal(readFileSync(counter, "utf8"), "x");
  clock = 100; await resolver.read("sensor"); assert.equal(readFileSync(counter, "utf8"), "xx");
  const wrong = createVariableResolver({ config: { ...config, variables: [{ ...config.variables[0]!, type: "number" }] }, env: { VAR_COUNT: counter } });
  await assert.rejects(wrong.read("sensor"), /var_type_mismatch/); await assert.rejects(wrong.read("sensor"), /var_type_mismatch/);
  assert.equal(readFileSync(counter, "utf8"), "xxxx");
});
