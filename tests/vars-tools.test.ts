import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";

async function fixture(rules: unknown[] = [], tools = ["builtin/bash", "builtin/list_vars", "builtin/read_var"]) {
  const dir = mkdtempSync(join(tmpdir(), "raw-var-tools-"));
  const path = join(dir, "raw.json");
  writeFileSync(path, JSON.stringify({ default_agent: "raw", models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "test" } },
    var_providers: { failure: { command: process.execPath, args: [resolve("tests/fixtures/var-provider.mjs"), "exit"] } },
    vars: { token: { description: "credential", access: "use", source: { kind: "literal", value: "literal; $(no) '" } }, flag: { description: "flag", access: "read", source: { kind: "literal", value: false } },
      failure: { description: "bad", access: "use", source: { kind: "provider", name: "failure" } } },
    agents: { raw: { model: "local", tools: { use: tools, rules }, vars: ["token", "flag", "failure"] } } }));
  const runtime = await loadConfig({ configPath: path, env: {}, requireModel: false });
  return { dir, runtime, async load() { return createRuntimeTools({ runtime, cwd: dir, env: { ...process.env, VAR_COUNT: join(dir, "provider-count") } }); } };
}
const ctx = (cwd: string) => ({ cwd, maxOutputBytes: 8192, autoApprove: true });
test("linked variable tools expose metadata only and enforce read/use without schema injection", async () => {
  const f = await fixture(); const tools = await f.load();
  try {
    assert.doesNotMatch(JSON.stringify(tools.registry.definitions()), /credential|literal;|failure.*bad/);
    const catalog = await tools.registry.dispatch("list_vars", {}, ctx(f.dir));
    assert.equal(catalog.isError, false); assert.doesNotMatch(JSON.stringify(catalog), /literal;|source|cacheTtl/);
    const read = await tools.registry.dispatch("read_var", { name: "flag" }, ctx(f.dir));
    assert.equal((read.content[0] as { value: { value: unknown } }).value.value, false);
    const hidden = await tools.registry.dispatch("read_var", { name: "token" }, ctx(f.dir));
    assert.equal(hidden.code, "var_read_denied"); assert.doesNotMatch(JSON.stringify(hidden), /literal;/);
    const small = await tools.registry.dispatch("read_var", { name: "flag" }, { ...ctx(f.dir), maxOutputBytes: 1 });
    assert.equal(small.isError, true);
  } finally { await tools.mcp.close(); }
});
test("Bash binds literal env per command, leaves args intact, and validates the entire batch first", async () => {
  const f = await fixture(); const tools = await f.load();
  try {
    const args = { commands: [{ command: `printf '%s' "$TOKEN" > received`, env_refs: { TOKEN: "token" } }, { command: 'test -z "$TOKEN"' }] };
    const saved = structuredClone(args);
    const result = await tools.registry.dispatch("bash", args, ctx(f.dir));
    assert.equal(result.isError, false); assert.deepEqual(args, saved);
    assert.equal(readFileSync(join(f.dir, "received"), "utf8"), "literal; $(no) '");
    assert.doesNotMatch(JSON.stringify(result), /literal;/);
    const invalid = await tools.registry.dispatch("bash", { commands: [{ command: 'touch never' }, { command: 'true', env_refs: { X: 'absent' } }] }, ctx(f.dir));
    assert.equal(invalid.isError, true); assert.equal(existsSync(join(f.dir, "never")), false);
    const partial = await tools.registry.dispatch("bash", { commands: [{ command: 'touch first' }, { command: 'touch middle', env_refs: { X: 'failure' } }, { command: 'touch last' }] }, ctx(f.dir));
    assert.equal(partial.isError, true); assert.equal(existsSync(join(f.dir, "first")), true);
    assert.equal(existsSync(join(f.dir, "middle")), false); assert.equal(existsSync(join(f.dir, "last")), false);
    assert.match(JSON.stringify(partial), /prior_var_error/);
  } finally { await tools.mcp.close(); }
});
test("conditional Bash asks only for matching commands and denial never executes", async () => {
  const f = await fixture([{ match: "builtin/bash", effect: "ask", when: { any: "commands[*].command", regex: "rm" } }]);
  const tools = await f.load(); let asks = 0;
  try {
    const context = { ...ctx(f.dir), approve: () => { asks++; return false; } };
    await tools.registry.dispatch("bash", { commands: [{ command: "true" }] }, context); assert.equal(asks, 0);
    const result = await tools.registry.dispatch("bash", { commands: [{ command: "rm marker", env_refs: { X: "failure" } }] }, context);
    assert.equal(result.code, "approval_denied"); assert.equal(asks, 1); assert.equal(existsSync(join(f.dir, "provider-count")), false);
  } finally { await tools.mcp.close(); }
});
test("custom plugins receive scoped vars service, not just builtin handlers", async () => {
  const f = await fixture([], ["agent/custom"]); const folder = join(f.dir, "tools", "custom"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 1, id: "custom", version: "1.0.0", name: "custom", description: "custom", entry: "./index.mjs", input_schema: { type: "object", properties: {}, additionalProperties: false } }));
  writeFileSync(join(folder, "index.mjs"), 'export async function handler(args,context){const env=await context.vars.resolveEnv({X:"token"},{signal:context.signal});return {content:[{type:"json",value:{present:env.X.length>0,names:context.vars.list().map(v=>v.name)}}]}}');
  const tools = await f.load();
  try { const result = await tools.registry.dispatch("custom", {}, ctx(f.dir)); assert.doesNotMatch(JSON.stringify(result), /literal;/); assert.match(JSON.stringify(result), /present.*true/); }
  finally { await tools.mcp.close(); }
});

test("standalone handlers fail clearly without host vars and oversized catalogs fail before resolution", async () => {
  const f = await fixture();
  await assert.rejects(createRuntimeTools({ runtime: { ...f.runtime, maxOutputBytes: 1 }, cwd: f.dir }), /catalog/);
  const { handler } = await import("../src/tools/bundled/read_var/index.js");
  assert.equal((await handler({ name: "token" }, ctx(f.dir))).code, "vars_unavailable");
});
