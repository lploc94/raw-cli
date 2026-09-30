import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ToolRegistry } from "../src/tools/registry.js";
import { compileWhen, matchesWhen } from "../src/tools/policy.js";

const schema = { type: "object" as const, properties: { files: { type: "array", items: { type: "object",
  properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  required: ["files"], additionalProperties: false };

function fixture(rules: ConstructorParameters<typeof ToolRegistry>[0], descriptor?: (args: Record<string, unknown>, context: { cwd: string }) => unknown) {
  const registry = new ToolRegistry(rules);
  let invoked = 0;
  registry.register({ name: "write", canonicalName: "local/write", description: "write",
    inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false },
    conditionSources: ["effects"], effectsSchema: schema,
    describeEffects: descriptor ?? ((_args, context) => ({ files: [{ path: resolve(context.cwd, "protected.txt") }] })),
    handler: async () => { invoked++; return { isError: false, content: [{ type: "text", text: "done" }] }; },
  });
  return { registry, invoked: () => invoked };
}

test("effect predicates ask before handler without synthesizing arguments", async () => {
  const { registry, invoked } = fixture([{ match: "local/write", effect: "ask",
    when: { source: "effects", any: "files[*].path", regex: "protected\\.txt$" } }]);
  const args = { patch: "original patch" };
  const observed: unknown[] = [];
  const result = await registry.dispatch("write", args, { cwd: "/workspace", maxOutputBytes: 8192,
    onHook: async (_event, _identity, _name, original, _result, effects) => { observed.push({ original, effects }); return {}; },
    approve: (request) => { observed.push(request); return false; },
  });
  assert.equal(result.code, "approval_denied");
  assert.equal(invoked(), 0);
  assert.deepEqual(args, { patch: "original patch" });
  assert.deepEqual((observed[0] as { original: unknown }).original, args);
  assert.deepEqual((observed[1] as { arguments: unknown }).arguments, args);
  assert.deepEqual((observed[1] as { effects: unknown }).effects, { files: [{ path: "/workspace/protected.txt" }] });
});

test("descriptor failure or invalid effects never invokes the handler", async () => {
  for (const descriptor of [() => { throw new Error("bad descriptor"); }, () => ({ files: [{ path: 1 }] })]) {
    const { registry, invoked } = fixture([], descriptor);
    const result = await registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 });
    assert.equal(result.isError, true);
    assert.equal(invoked(), 0);
  }
});

test("condition source is mandatory and cannot fall back to arguments", () => {
  assert.throws(() => compileWhen({ any: "patch", regex: ".*" } as never));
  assert.throws(() => fixture([{ match: "local/write", effect: "ask", when: { source: "arguments", any: "patch", regex: ".*" } }]));
  const when = compileWhen({ source: "effects", any: "files[*].path", regex: "protected" });
  assert.equal(matchesWhen(when, { files: [{ path: "protected" }] }, {}), false);
  assert.equal(matchesWhen(when, {}, { files: [{ path: "protected" }] }), true);
});

test("effects are prepared once from current input and cannot be mutated by hooks", async () => {
  let described = 0;
  const { registry, invoked } = fixture([], (args, context) => {
    described++;
    return { files: [{ path: resolve(context.cwd, String(args.patch)) }] };
  });
  for (const path of ["one.txt", "nested/two.txt"]) {
    let received = "";
    const result = await registry.dispatch("write", { patch: path }, { cwd: "/workspace", maxOutputBytes: 8192,
      onHook: async (event, _identity, _name, args, _result, effects) => {
        assert.equal(args.patch, path);
        const files = effects!.files as Array<{ path: string }>;
        received = files[0]!.path;
        assert.throws(() => { files[0]!.path = "/different"; }, TypeError);
        assert.equal(event === "PreToolUse" || event === "PostToolUse", true);
        return {};
      },
    });
    assert.equal(result.isError, false);
    assert.equal(received, resolve("/workspace", path));
  }
  assert.equal(described, 2);
  assert.equal(invoked(), 2);
  assert.doesNotThrow(() => registry.definitions());
});

test("unconditional deny prevents descriptor execution and invalid effects schemas do not register", async () => {
  let described = 0;
  const { registry } = fixture([{ match: "local/write", effect: "deny" }], () => { described++; return { files: [] }; });
  const result = await registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 });
  assert.equal(result.code, "tool_denied");
  assert.equal(described, 0);
  const asyncFixture = fixture([], () => Promise.resolve({ files: [] }));
  assert.equal((await asyncFixture.registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 })).code, "invalid_effects");
  const invalid = new ToolRegistry();
  assert.throws(() => invalid.register({ name: "bad", description: "bad", inputSchema: { type: "object" },
    effectsSchema: { type: "object", $ref: "https://example.invalid/schema" }, conditionSources: ["effects"],
    describeEffects: () => ({}), handler: async () => ({ isError: false, content: [] }) }));
  assert.equal(invalid.definitions().length, 0);
});

test("gates receive only the validated serialized effects snapshot", async () => {
  for (const descriptor of [
    () => Object.create({ files: [{ path: "/protected.txt" }] }),
    () => ({ files: [{ path: "/protected.txt" }], toJSON: () => ({}) }),
  ]) {
    const { registry, invoked } = fixture([], descriptor);
    const result = await registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 });
    assert.equal(result.isError, true);
    assert.equal(invoked(), 0);
  }
});

test("input schema is fully checked before descriptor even with a permissive semantic validator", async () => {
  let described = 0;
  let validated = 0;
  const registry = new ToolRegistry();
  registry.register({ name: "nested", description: "nested", inputSchema: { type: "object", required: ["operations"],
    properties: { operations: { type: "array", minItems: 1, maxItems: 2, items: { type: "object", required: ["path"],
      properties: { path: { type: "string", minLength: 1 }, mode: { enum: ["create", "replace"] } }, additionalProperties: false } } }, additionalProperties: false },
    effectsSchema: schema, conditionSources: ["effects"],
    describeEffects: () => { described++; return { files: [] }; },
    validateArgs: () => { validated++; return undefined; }, handler: async () => ({ isError: false, content: [] }) });
  for (const operations of ["not an array", [], [{ path: 1 }], [{ path: "a", mode: "delete" }], [{ path: "a" }, { path: "b" }, { path: "c" }]]) {
    assert.equal((await registry.dispatch("nested", { operations }, { cwd: "/workspace", maxOutputBytes: 8192 })).code, "invalid_arguments");
  }
  assert.equal(described, 0);
  assert.equal(validated, 5);
});

test("async effects descriptors fail one call without an unhandled rejection", () => {
  const script = `import { ToolRegistry } from './src/tools/registry.ts';
    for (const describeEffects of [async () => ({}), async () => { throw new Error('async failure'); }, () => ({then(resolve, reject) { reject(new Error('thenable failure')); }})]) {
      let invoked = 0;
      const registry = new ToolRegistry();
      registry.register({ name:'bad', description:'bad', inputSchema:{type:'object'}, effectsSchema:{type:'object'},
        conditionSources:['effects'], describeEffects, handler:async () => { invoked++; return {isError:false,content:[]}; } });
      const result = await registry.dispatch('bad', {}, {cwd:process.cwd(),maxOutputBytes:8192});
      if (!result.isError || invoked) throw new Error('async descriptor accepted');
    }
    await new Promise(resolve => setImmediate(resolve));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("builtin write operations and patches share effects gates including rename destinations", async () => {
  const { readFile } = await import("node:fs/promises");
  const { describeEffects, validateArgs, handler } = await import("../src/tools/bundled/write_file/index.js");
  const manifest = JSON.parse(await readFile(new URL("../src/tools/bundled/write_file/tool.json", import.meta.url), "utf8"));
  const registry = new ToolRegistry([{ match: "builtin/write_file", effect: "ask", when: { source: "effects", any: "files[*].path", regex: "protected\\.txt$" } }]);
  registry.register({ name: "write_file", canonicalName: "builtin/write_file", description: "write", inputSchema: manifest.input_schema,
    conditionSources: ["effects"], effectsSchema: manifest.effects_schema, describeEffects, validateArgs, handler });
  const cases = [
    { operations: [{ path: "protected.txt", mode: "overwrite", content: "no" }] },
    { patch: "*** Begin Patch\n*** Add File: protected.txt\n+no\n*** End Patch" },
    { patch: "*** Begin Patch\n*** Delete File: protected.txt\n*** End Patch" },
    { patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: protected.txt\n@@\n-old\n+new\n*** End Patch" },
  ];
  for (const args of cases) {
    let approved = false;
    const result = await registry.dispatch("write_file", args, { cwd: "/nonexistent-phase7", maxOutputBytes: 8192,
      approve: (request) => { approved = true; assert.deepEqual(request.arguments, args); assert.ok((request.effects!.files as Array<{path:string}>).some(f => f.path === "/nonexistent-phase7/protected.txt")); return false; } });
    assert.equal(approved, true);
    assert.equal(result.code, "approval_denied");
    const denied = await registry.dispatch("write_file", args, { cwd: "/nonexistent-phase7", maxOutputBytes: 8192, autoApprove: true,
      onHook: async (event, _identity, _name, original, _result, effects) => { assert.deepEqual(original, args); assert.ok(effects); return event === "PreToolUse" ? { blocked: "denied", reason: "protected" } : {}; } });
    assert.equal(denied.code, "hook_denied");
  }
  assert.ok(validateArgs({ patch: cases[1]!.patch, operations: [] }));
  assert.ok(validateArgs({}));
  assert.throws(() => describeEffects({ patch: "malformed" }, { cwd: "/tmp" }));
});

test("write validator does not invent cwd aliases and real effects reject actual aliases", async () => {
  const { validateArgs, describeEffects } = await import("../src/tools/bundled/write_file/index.js");
  const patch = "*** Begin Patch\n*** Add File: ../a\n+one\n*** Add File: /a\n+two\n*** End Patch";
  assert.equal(validateArgs({ patch }), undefined);
  assert.deepEqual(describeEffects({ patch }, { cwd: "/work/project" }), { files: [
    { path: "/work/a", operation: "write" }, { path: "/a", operation: "write" },
  ] });
  assert.throws(() => describeEffects({ patch }, { cwd: "/work" }));
});
