import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_TOOL_DEFINITIONS, createToolRegistry } from "../src/tools/registry.js";

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
    ["missing", {}],
  ] as const) {
    assert.equal((await registry.dispatch(name, args, ctx)).isError, true);
  }
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
