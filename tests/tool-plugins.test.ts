import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadToolPlugins } from "../src/tools/plugins/loader.js";
import { ToolRegistry } from "../src/tools/registry.js";

const nestedSchema = {
  type: "object", properties: { payload: { type: "object", properties: {
    value: { type: "string" }, block: { type: "boolean" },
  }, required: ["value"], additionalProperties: false } },
  required: ["payload"], additionalProperties: false,
};

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "raw-plugin-"));
  return { root, configPath: join(root, "agent", "raw.json"),
    env: { XDG_CONFIG_HOME: join(root, "global") }, cwd: root };
}

async function plugin(folder: string, id: string, name = id, source?: string, manifestPatch: Record<string, unknown> = {}) {
  await mkdir(folder, { recursive: true });
  const manifest = { api_version: 1, id, version: "1.0.0", name,
    description: `Fixture ${name}`, input_schema: nestedSchema, entry: "./index.mjs", ...manifestPatch };
  await writeFile(join(folder, "tool.json"), JSON.stringify(manifest));
  await writeFile(join(folder, "index.mjs"), source ?? `export async function handler(args) {
    return { isError: false, content: [{ type: "json", value: { echo: args.payload.value } }] };
  }
  export function validateArgs(args) { return args?.payload?.block ? "blocked by semantic validator" : undefined; }
`);
}

test("one loader selects bundled, global, and config-local tools without importing unselected code", async () => {
  const options = await workspace();
  const globalRoot = join(options.env.XDG_CONFIG_HOME, "raw", "tools");
  const agentRoot = join(dirname(options.configPath), "tools");
  const untouched = join(options.root, "unselected-imported");
  await plugin(join(globalRoot, "chosen"), "chosen", "global_chosen");
  await plugin(join(agentRoot, "chosen"), "chosen", "agent_chosen");
  await plugin(join(agentRoot, "unselected"), "unselected", "not_visible", `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(untouched)}, "imported");
    export async function handler() { throw new Error("must not run"); }
  `);
  await writeFile(join(agentRoot, "unselected", "tool.json"), "{");
  const tools = await loadToolPlugins({ ...options, selectedIds: ["builtin/read_file", "local/chosen", "agent/chosen"] });
  assert.deepEqual(tools.map((item) => item.id), ["builtin/read_file", "local/chosen", "agent/chosen"]);
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool.registration);
  assert.deepEqual(registry.definitions().map((item) => item.name), ["read_file", "global_chosen", "agent_chosen"]);
  await assert.rejects(readFile(untouched));
});

test("editing only a selected entry changes its source identity and reloads its handler", async () => {
  const options = await workspace();
  const folder = join(dirname(options.configPath), "tools", "editable");
  const source = (value: string) => `export async function handler() { return { isError: false,
    content: [{ type: "text", text: ${JSON.stringify(value)} }] }; }`;
  await plugin(folder, "editable", "editable", source("old"));
  const first = (await loadToolPlugins({ ...options, selectedIds: ["agent/editable"] }))[0]!;
  await writeFile(join(folder, "index.mjs"), source("new"));
  const second = (await loadToolPlugins({ ...options, selectedIds: ["agent/editable"] }))[0]!;
  assert.notEqual(first.sourceDigest, second.sourceDigest);
  assert.deepEqual(first.registration.inputSchema, second.registration.inputSchema);
  const context = { cwd: options.cwd, maxOutputBytes: 8192, autoApprove: true };
  const before = new ToolRegistry(); before.register(first.registration);
  const after = new ToolRegistry(); after.register(second.registration);
  assert.match(JSON.stringify(await before.dispatch("editable", { payload: { value: "x" } }, context)), /old/);
  assert.match(JSON.stringify(await after.dispatch("editable", { payload: { value: "x" } }, context)), /new/);
});

test("editing an imported helper changes the next same-process tool snapshot only once", async () => {
  const options = await workspace();
  const folder = join(dirname(options.configPath), "tools", "helper_tool");
  await plugin(folder, "helper_tool", "helper_tool", `import { value } from "./helper.mjs";
    export async function handler() { return { isError: false, content: [{ type: "text", text: value }] }; }`);
  await writeFile(join(folder, "helper.mjs"), 'export const value = "old";\n');
  const first = (await loadToolPlugins({ ...options, selectedIds: ["agent/helper_tool"] }))[0]!;
  await writeFile(join(folder, "helper.mjs"), 'export const value = "new";\n');
  const second = (await loadToolPlugins({ ...options, selectedIds: ["agent/helper_tool"] }))[0]!;
  const third = (await loadToolPlugins({ ...options, selectedIds: ["agent/helper_tool"] }))[0]!;
  const call = async (tool: typeof first) => {
    const registry = new ToolRegistry(); registry.register(tool.registration);
    return JSON.stringify(await registry.dispatch("helper_tool", { payload: { value: "x" } },
      { cwd: options.cwd, maxOutputBytes: 8192, autoApprove: true }));
  };
  assert.match(await call(first), /old/);
  assert.match(await call(second), /new/);
  assert.equal(second.sourceDigest, third.sourceDigest);
  assert.notEqual(first.sourceDigest, second.sourceDigest);
});

test("tool version label alone does not change selected behavioral source identity", async () => {
  const options = await workspace();
  const folder = join(dirname(options.configPath), "tools", "label_only");
  await plugin(folder, "label_only", "label_only");
  const first = (await loadToolPlugins({ ...options, selectedIds: ["agent/label_only"] }))[0]!;
  const manifest = JSON.parse(await readFile(join(folder, "tool.json"), "utf8")) as Record<string, unknown>;
  manifest.version = "2.0.0";
  await writeFile(join(folder, "tool.json"), JSON.stringify(manifest));
  const second = (await loadToolPlugins({ ...options, selectedIds: ["agent/label_only"] }))[0]!;
  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.equal(second.version, "2.0.0");
});

test("an internal helper link works, while a link outside the owned tool folder is rejected", async () => {
  const options = await workspace();
  const folder = join(dirname(options.configPath), "tools", "linked_helper");
  await plugin(folder, "linked_helper", "linked_helper", `import { value } from "./helper.mjs";
    export async function handler() { return { isError: false, content: [{ type: "text", text: value }] }; }`);
  await writeFile(join(folder, "actual.mjs"), 'export const value = "inside";\n');
  await symlink("actual.mjs", join(folder, "helper.mjs"));
  const first = (await loadToolPlugins({ ...options, selectedIds: ["agent/linked_helper"] }))[0]!;
  const registry = new ToolRegistry(); registry.register(first.registration);
  assert.match(JSON.stringify(await registry.dispatch("linked_helper", { payload: { value: "x" } },
    { cwd: options.cwd, maxOutputBytes: 8192, autoApprove: true })), /inside/);
  await unlink(join(folder, "helper.mjs"));
  const outside = join(options.root, "outside.mjs");
  await writeFile(outside, 'export const value = "outside";\n');
  await symlink(outside, join(folder, "helper.mjs"));
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/linked_helper"] }), /escapes|outside/i);
});

test("selected manifest and schema failures reject before any handler import", async () => {
  const options = await workspace();
  const agentRoot = join(dirname(options.configPath), "tools");
  const marker = join(options.root, "imported");
  await plugin(join(agentRoot, "safe"), "safe", "safe", `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "imported");
    export async function handler() { return { isError: false, content: [] }; }
  `);
  await plugin(join(agentRoot, "bad"), "bad", "bad", undefined, { unexpected: true });
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/safe", "agent/bad"] }), /manifest|unknown field/i);
  await assert.rejects(readFile(marker));
  await plugin(join(agentRoot, "bad"), "bad", "bad", undefined, { input_schema: { type: "object", properties: { value: { $ref: "https://invalid.example/schema" } } } });
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/safe", "agent/bad"] }), /schema|reference/i);
  await assert.rejects(readFile(marker));
  await plugin(join(agentRoot, "bad"), "bad", "safe");
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/safe", "agent/bad"] }), /duplicate.*name/i);
  await assert.rejects(readFile(marker));
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/../safe"] }), /invalid.*id/i);
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/missing"] }), /missing|ENOENT/i);
});

test("selected symlink escape and bad exports are rejected", async () => {
  const options = await workspace();
  const agentRoot = join(dirname(options.configPath), "tools");
  const outside = join(options.root, "outside.mjs");
  await writeFile(outside, "export async function handler() { return { isError: false, content: [] }; }");
  await plugin(join(agentRoot, "escape"), "escape");
  await unlink(join(agentRoot, "escape", "index.mjs"));
  await symlink(outside, join(agentRoot, "escape", "index.mjs"));
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/escape"] }), /escape|outside/i);
  await plugin(join(agentRoot, "broken"), "broken", "broken", "export const handler = 42;");
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/broken"] }), /handler|entry/i);
  await plugin(join(agentRoot, "bad_validator"), "bad_validator", "bad_validator", `
    export async function handler() { return { isError: false, content: [] }; }
    export const validateArgs = 42;
  `);
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/bad_validator"] }), /validator/i);
});

test("supported JSON Schema drafts compile locally and async schemas fail before import", async () => {
  const options = await workspace();
  const root = join(dirname(options.configPath), "tools");
  await plugin(join(root, "draft7"), "draft7", "draft7", undefined, {
    input_schema: { $schema: "http://json-schema.org/draft-07/schema#", ...nestedSchema },
  });
  await plugin(join(root, "draft2020"), "draft2020", "draft2020", undefined, {
    input_schema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...nestedSchema },
  });
  assert.equal((await loadToolPlugins({ ...options, selectedIds: ["agent/draft7", "agent/draft2020"] })).length, 2);
  await plugin(join(root, "async_schema"), "async_schema", "async_schema", undefined, {
    input_schema: { ...nestedSchema, $async: true },
  });
  await assert.rejects(loadToolPlugins({ ...options, selectedIds: ["agent/async_schema"] }), /async tool schema/i);
});

test("plugin dispatch validates nested schema and semantic rules before approval or side effects", async () => {
  const options = await workspace();
  const folder = join(dirname(options.configPath), "tools", "writer");
  const marker = join(options.root, "handled");
  await plugin(folder, "writer", "custom_writer", `
    import { writeFileSync } from "node:fs";
    export function validateArgs(args) { return args?.payload?.block ? "blocked by semantic validator" : undefined; }
    export async function handler(args, context) {
      writeFileSync(${JSON.stringify(marker)}, args.payload.value);
      return { isError: false, content: [{ type: "json", value: {
        echo: args.payload.value, approvalExposed: typeof context.approve, whitelistExposed: typeof context.whitelist,
      } }] };
    }
  `);
  const [loaded] = await loadToolPlugins({ ...options, selectedIds: ["agent/writer"] });
  const registry = new ToolRegistry();
  registry.register(loaded!.registration);
  let approvals = 0;
  const context = { cwd: options.cwd, maxOutputBytes: 8192, autoApprove: false, approve: async () => { approvals++; return true; } };
  assert.equal((await registry.dispatch("custom_writer", { payload: { value: 3 } }, context)).code, "invalid_arguments");
  assert.equal((await registry.dispatch("custom_writer", { payload: { value: "x", block: true } }, context)).code, "invalid_arguments");
  assert.equal(approvals, 0);
  await assert.rejects(readFile(marker));
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await registry.dispatch("custom_writer", { payload: { value: "x" } }, { ...context, signal: aborted.signal })).code, "aborted");
  assert.equal(approvals, 0);
  const result = await registry.dispatch("custom_writer", { payload: { value: "ok" } }, context);
  assert.equal(result.isError, false);
  assert.equal(approvals, 1);
  assert.equal(await readFile(marker, "utf8"), "ok");
  assert.match(JSON.stringify(result), /echo/);
  assert.match(JSON.stringify(result), /"approvalExposed":"undefined"/);
  assert.match(JSON.stringify(result), /"whitelistExposed":"undefined"/);
  const capped = await registry.dispatch("custom_writer", { payload: { value: "x".repeat(1000) } }, { ...context, maxOutputBytes: 32 });
  assert.equal(capped.truncated, true);
  assert.ok((capped.retainedBytes ?? Infinity) <= 32);
});

test("selected plugin image content stays typed and thrown handlers normalize to errors", async () => {
  const options = await workspace();
  const root = join(dirname(options.configPath), "tools");
  await plugin(join(root, "image"), "image", "custom_image", `
    export async function handler() { return { isError: false, content: [
      { type: "image", mimeType: "image/png", data: "AA==" },
    ] }; }
  `);
  await plugin(join(root, "throws"), "throws", "custom_throws", `
    export async function handler() { throw new Error("handler failed"); }
  `);
  const plugins = await loadToolPlugins({ ...options, selectedIds: ["agent/image", "agent/throws"] });
  const registry = new ToolRegistry();
  for (const item of plugins) registry.register(item.registration);
  const ctx = { cwd: options.cwd, maxOutputBytes: 64, autoApprove: true };
  const image = await registry.dispatch("custom_image", { payload: { value: "x" } }, ctx);
  assert.equal(image.isError, false);
  assert.equal(image.content[0]?.type, "image");
  const failed = await registry.dispatch("custom_throws", { payload: { value: "x" } }, ctx);
  assert.equal(failed.code, "tool_error");
});
