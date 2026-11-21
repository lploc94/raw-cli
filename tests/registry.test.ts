import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_TOOL_DEFINITIONS, createTestToolRegistry, ToolRegistry } from "./fixtures/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";

test("a delegated call keeps the session id of the call that delegated", async () => {
  const registry = new ToolRegistry();
  const seen: Array<string | undefined> = [];
  registry.register({ name: "target", canonicalName: "agent/target", description: "target", inputSchema: { type: "object" },
    handler: async (_args, context) => { seen.push(context.sessionId); return { isError: false, content: [] }; } });
  registry.register({ name: "outer", description: "outer", inputSchema: { type: "object" },
    delegate: () => ({ identity: "agent/target", arguments: {}, finish: (result) => result }),
    handler: async () => { throw new Error("must delegate"); } });
  await registry.dispatch("outer", {}, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true, sessionId: "session-7" });
  await registry.dispatch("outer", {}, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
  assert.deepEqual(seen, ["session-7", undefined]);
});

test("the bundled powershell tool takes bash's arguments under its own name and description", async () => {
  const [bash, powershell] = await loadBundledTools(["bash", "powershell"]);
  assert.equal(powershell!.name, "powershell");
  assert.match(powershell!.description, /^Run one PowerShell command \(pwsh 7 when installed, otherwise Windows PowerShell 5\.1, where && and \|\| do not exist: use ; and if \(\$\?\) \{ … \}\)/);
  const schema = (tool: typeof bash) => JSON.stringify(tool!.inputSchema).replace(/"description":"[^"]*"/g, "");
  assert.equal(schema(powershell), schema(bash));
  assert.equal((powershell!.inputSchema.properties!.command as { description: string }).description, "The PowerShell command to run.");
});

test("packaged bundled plugins preserve exact definitions and semantic batch preflight", async () => {
  const names = ["read_file", "write_file", "bash", "view_image"];
  const plugins = await loadBundledTools(names);
  const registry = new ToolRegistry();
  for (const plugin of plugins) registry.register(plugin);
  assert.deepEqual(registry.definitions(), createTestToolRegistry([], true).definitions());
  // Intentional revisions: bash, read_file and write_file take one action in the trained shape (docs/tool-ux-design.md §4.2);
  // bash names Git Bash on Windows. Definitions are sent sorted by name (bash, read_file, view_image, write_file); the same
  // definitions in the earlier read_file, write_file, bash, view_image order hashed to 63159c22….
  assert.equal(createHash("sha256").update(JSON.stringify(registry.definitions())).digest("hex"),
    "4e3d3886ccc06289f004d61492f1a1d7e3d7d4e82790f551128e6fbf9f797d2c");

  const cwd = await mkdtemp(join(tmpdir(), "raw-bundled-"));
  const marker = join(cwd, "side-effect");
  let approvals = 0;
  const ctx = { cwd, maxOutputBytes: 8192, autoApprove: false, approve: async () => { approvals++; return true; } };
  for (const plugin of await loadBundledTools(["edit_file", "apply_patch"])) registry.register(plugin);
  const oldWrite = await registry.dispatch("write_file", { operations: [{ path: marker, mode: "overwrite", content: "must not write" }] }, ctx);
  assert.equal(oldWrite.code, "invalid_arguments");
  assert.match(JSON.stringify(oldWrite), /write_file writes one whole file: .*use edit_file to change part of a file/);
  const invalidWrite = await registry.dispatch("write_file", { path: marker, content: 1 }, ctx);
  assert.equal(invalidWrite.code, "invalid_arguments");
  assert.match(JSON.stringify(invalidWrite), /content must be a string/);
  const invalidBash = await registry.dispatch("bash", { command: `touch '${marker}'`, timeout: 0 }, ctx);
  assert.equal(invalidBash.code, "invalid_arguments");
  const batchBash = await registry.dispatch("bash", { commands: [{ command: `touch '${marker}'` }] }, ctx);
  assert.equal(batchBash.code, "invalid_arguments");
  const oldRead = await registry.dispatch("read_file", { files: [{ path: marker }] }, ctx);
  assert.equal(oldRead.code, "invalid_arguments");
  assert.match(JSON.stringify(oldRead), /read_file reads one file: .*call read_file once per file/);
  const invalidRead = await registry.dispatch("read_file", { path: marker, offset: 0 }, ctx);
  assert.equal(invalidRead.code, "invalid_arguments");
  const invalidEdit = await registry.dispatch("edit_file", { path: marker, old_string: "", new_string: "x" }, ctx);
  assert.equal(invalidEdit.code, "invalid_arguments");
  const invalidPatch = await registry.dispatch("apply_patch", { patch: `*** Begin Patch\n*** Add File: ${marker}\n*** End` }, ctx);
  assert.equal(invalidPatch.code, "invalid_arguments");
  assert.equal(approvals, 0);
  await assert.rejects(access(marker));

  const write = await registry.dispatch("write_file", { path: marker, content: "ok" }, { ...ctx, autoApprove: true });
  assert.equal(write.isError, false);
  assert.equal(await readFile(marker, "utf8"), "ok");
  const read = await registry.dispatch("read_file", { path: marker }, { ...ctx, autoApprove: true });
  assert.equal(read.isError, false);
  assert.match(JSON.stringify(read), /│ok/);
  assert.equal((await registry.dispatch("view_image", { path: marker }, { ...ctx, autoApprove: true })).isError, true);
  const imageArgs = await registry.dispatch("view_image", { path: 3 }, { ...ctx, autoApprove: true });
  assert.equal(imageArgs.code, "invalid_arguments");
  assert.match(JSON.stringify(imageArgs), /path must be a string/);
});

test("registry has only three built-ins and rejects invalid/hidden calls before approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-reg-"));
  const marker = join(cwd, "marker");
  const registry = createTestToolRegistry();
  assert.deepEqual(registry.definitions().map((d) => d.name), ["bash", "read_file", "write_file"]);
  let approvals = 0;
  const ctx = { cwd, maxOutputBytes: 8192, autoApprove: false, approve: async () => { approvals++; return true; } };
  for (const [name, args] of [
    ["write_file", { operations: [{ path: marker, mode: "overwrite", content: "bad" }] }],
    ["write_file", { path: marker, content: 1 }],
    ["bash", { command: "true", timeout: 0 }],
    ["bash", { command: "" }],
    ["read_file", { "": 0, files: [{ path: marker }] }],
    ["read_file", { "": 0, path: 3 }],
    ["write_file", { "": 0, operations: [{ path: marker, mode: "overwrite", content: "bad" }] }],
    ["write_file", { "": 0, path: marker }],
    ["bash", { "": 0, commands: [{ command: "true" }] }],
    ["bash", { "": 0, command: 3 }],
    ["missing", {}],
  ] as const) {
    assert.equal((await registry.dispatch(name, args, ctx)).isError, true);
  }
  const batchCommand = await registry.dispatch("bash", { commands: ["pwd"] }, ctx);
  assert.equal(batchCommand.code, "invalid_arguments");
  assert.match(JSON.stringify(batchCommand), /bash takes one command: \{\\"command\\":\\"npm test\\"\}; call bash once per command/);
  assert.equal(approvals, 0);
  assert.equal((await registry.dispatch("write_file", { path: marker, content: "bad" }, { ...ctx, whitelist: [] })).code, "tool_not_exposed");
  assert.equal(approvals, 0);
  assert.equal((await registry.dispatch("write_file", { path: marker, content: "bad" }, { ...ctx, approve: async () => false })).code, "approval_denied");
  assert.equal((await registry.dispatch("write_file", { path: marker, content: "bad" }, { cwd, maxOutputBytes: 8192, autoApprove: false })).code, "approval_required");
  await assert.rejects(access(marker));
  assert.throws(() => registry.register({ name: "bash", description: "duplicate", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ isError: false, content: [] }) }));
  const prototypeArgs = JSON.parse('{"command":"true","__proto__":1}') as unknown;
  // A normalized tool drops an unknown top-level key, __proto__ included, and tells the model; nothing is polluted.
  const prototypeCall = await registry.dispatch("bash", prototypeArgs, { ...ctx, autoApprove: true });
  assert.equal(prototypeCall.isError, false);
  assert.match(JSON.stringify(prototypeCall.content), /\[ignored unknown argument: __proto__\]/);
  assert.equal(({} as Record<string, unknown>).command, undefined);
  assert.equal((await registry.dispatch("bash", { command: "true", timeout: 1.5 }, ctx)).code, "invalid_arguments");
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
  const run = createTestToolRegistry().dispatch("write_file", { path: marker, content: "bad" }, {
    cwd, maxOutputBytes: 8192, autoApprove: false, signal: abort.signal, approve: () => pending,
  });
  abort.abort();
  assert.equal((await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("approval did not cancel")), 500))]) as { code: string }).code, "aborted");
  allow(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(access(marker));
});

test("tool definitions are sent sorted by name, whatever the registration or whitelist order", () => {
  // Names chosen so registration, whitelist and code-unit order all differ; uppercase sorts before lowercase in code-unit order.
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const }, handler: async () => ({ isError: false, content: [] }) });
  const first = new ToolRegistry();
  for (const name of ["zeta", "alpha", "Beta", "_x"]) first.register(tool(name));
  const second = new ToolRegistry();
  for (const name of ["_x", "Beta", "zeta", "alpha"]) second.register(tool(name));
  const expected = ["Beta", "_x", "alpha", "zeta"];
  assert.deepEqual(first.definitions().map((d) => d.name), expected, "registration order zeta, alpha, Beta, _x");
  assert.deepEqual(second.definitions(["zeta", "_x", "alpha", "Beta"]).map((d) => d.name), expected, "whitelist order zeta, _x, alpha, Beta");
  assert.deepEqual(first.definitions(["alpha", "zeta"]).map((d) => d.name), ["alpha", "zeta"], "a whitelist still filters");
});
