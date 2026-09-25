import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_TOOL_DEFINITIONS, createToolRegistry, ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";

test("packaged bundled plugins preserve exact definitions and semantic batch preflight", async () => {
  const names = ["read_file", "write_file", "bash", "view_image"];
  const plugins = await loadBundledTools(names);
  const registry = new ToolRegistry();
  for (const plugin of plugins) registry.register(plugin);
  assert.deepEqual(registry.definitions(), createToolRegistry([], true).definitions());
  // Frozen from the pre-refactor four-tool definition array at 3681c12.
  assert.equal(createHash("sha256").update(JSON.stringify(registry.definitions())).digest("hex"),
    "ebb9316cba1a92401a88e5a17955e89f64bd17bd559e756209c82b414e8bfe3d");

  const cwd = await mkdtemp(join(tmpdir(), "raw-bundled-"));
  const marker = join(cwd, "side-effect");
  let approvals = 0;
  const ctx = { cwd, maxOutputBytes: 8192, autoApprove: false, approve: async () => { approvals++; return true; } };
  const invalidWrite = await registry.dispatch("write_file", { operations: [
    { path: marker, mode: "overwrite", content: "must not write" },
    { path: marker, mode: "replace_lines", start_line: 2, end_line: 1, content: "bad", expected_sha256: "0".repeat(64) },
  ] }, ctx);
  assert.equal(invalidWrite.code, "invalid_arguments");
  assert.match(JSON.stringify(invalidWrite), /operations\[1\].*invalid line range/);
  const invalidBash = await registry.dispatch("bash", { commands: [
    { command: `touch '${marker}'` }, { command: "true", timeout_ms: 0 },
  ] }, ctx);
  assert.equal(invalidBash.code, "invalid_arguments");
  const invalidRead = await registry.dispatch("read_file", { files: [
    { path: marker }, { path: marker, start_line: 3, end_line: 2 },
  ] }, ctx);
  assert.equal(invalidRead.code, "invalid_arguments");
  assert.equal(approvals, 0);
  await assert.rejects(access(marker));

  const write = await registry.dispatch("write_file", { operations: [{ path: marker, mode: "overwrite", content: "ok" }] }, { ...ctx, autoApprove: true });
  assert.equal(write.isError, false);
  assert.equal(await readFile(marker, "utf8"), "ok");
  const read = await registry.dispatch("read_file", { files: [{ path: marker }] }, { ...ctx, autoApprove: true });
  assert.equal(read.isError, false);
  assert.match(JSON.stringify(read), /ok/);
  assert.equal((await registry.dispatch("view_image", { path: marker }, { ...ctx, autoApprove: true })).isError, true);
});

test("registry has only three built-ins and rejects invalid/hidden calls before approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-reg-"));
  const marker = join(cwd, "marker");
  const registry = createToolRegistry();
  assert.deepEqual(registry.definitions().map((d) => d.name), ["read_file", "write_file", "bash"]);
  let approvals = 0;
  const ctx = { cwd, maxOutputBytes: 8192, autoApprove: false, approve: async () => { approvals++; return true; } };
  for (const [name, args] of [
    ["write_file", { operations: [{ path: marker, mode: "overwrite", content: "bad", extra: 1 }] }],
    ["write_file", { operations: [{ path: marker, mode: "overwrite", content: 1 }] }],
    ["bash", { commands: [{ command: "true", timeout_ms: 0 }] }],
    ["read_file", { "": 0, files: [{ path: marker }] }],
    ["write_file", { "": 0, operations: [{ path: marker, mode: "overwrite", content: "bad" }] }],
    ["bash", { "": 0, commands: [{ command: "true" }] }],
    ["missing", {}],
  ] as const) {
    assert.equal((await registry.dispatch(name, args, ctx)).isError, true);
  }
  const stringCommand = await registry.dispatch("bash", { commands: ["pwd"] }, ctx);
  assert.equal(stringCommand.code, "invalid_arguments");
  assert.match(JSON.stringify(stringCommand), /commands\[0\] must be an object.*command/);
  assert.equal(approvals, 0);
  assert.equal((await registry.dispatch("write_file", { operations: [{ mode: "overwrite", path: marker, content: "bad" }] }, { ...ctx, whitelist: [] })).code, "tool_not_exposed");
  assert.equal(approvals, 0);
  assert.equal((await registry.dispatch("write_file", { operations: [{ mode: "overwrite", path: marker, content: "bad" }] }, { ...ctx, approve: async () => false })).code, "approval_denied");
  assert.equal((await registry.dispatch("write_file", { operations: [{ mode: "overwrite", path: marker, content: "bad" }] }, { cwd, maxOutputBytes: 8192, autoApprove: false })).code, "approval_required");
  await assert.rejects(access(marker));
  assert.throws(() => registry.register({ name: "bash", description: "duplicate", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ isError: false, content: [] }) }));
  const prototypeArgs = JSON.parse('{"command":"true","__proto__":1}') as unknown;
  assert.equal((await registry.dispatch("bash", prototypeArgs, ctx)).code, "invalid_arguments");
  assert.equal((await registry.dispatch("bash", { commands: [{ command: "true", timeout_ms: 2147483648 }] }, ctx)).code, "invalid_arguments");
  const capped = await registry.dispatch("x".repeat(100), {}, { cwd, maxOutputBytes: 5, autoApprove: true });
  assert.equal(capped.truncated, true);
  assert.ok((capped.retainedBytes ?? Infinity) <= 5);
  assert.equal(approvals, 0);
  assert.equal(Object.isFrozen(BUILTIN_TOOL_DEFINITIONS[0]?.inputSchema), true);
  assert.equal(Object.isFrozen(BUILTIN_TOOL_DEFINITIONS[0]?.inputSchema.required), true);
});

test("abort settles an unresolved approval and late approval cannot execute", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-approval-"));
  const marker = join(cwd, "marker");
  const abort = new AbortController();
  let allow!: (value: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { allow = resolve; });
  const run = createToolRegistry().dispatch("write_file", { operations: [{ path: marker, mode: "overwrite", content: "bad" }] }, {
    cwd, maxOutputBytes: 8192, autoApprove: false, signal: abort.signal, approve: () => pending,
  });
  abort.abort();
  assert.equal((await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("approval did not cancel")), 500))]) as { code: string }).code, "aborted");
  allow(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(access(marker));
});
