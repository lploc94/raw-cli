import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ComponentManager } from "../src/management/components.js";
import { readManagedConfig } from "../src/management/config.js";
import { installPackage, linkPackage } from "../src/packages/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-component-management-"));
  const configPath = join(root, "agent", "config.json"); mkdirSync(join(root, "agent")); writeFileSync(configPath, "{}");
  const manager = new ComponentManager({ configPath, env: { XDG_CONFIG_HOME: join(root, "global"), XDG_DATA_HOME: join(root, "data") } });
  return { root, configPath, manager, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
const tool = (id: string) => JSON.stringify({ api_version: 1, id, version: "1.0.0", name: id, description: "A fixture tool",
  input_schema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false }, entry: "./index.mjs" });

test("hook folders stay passive in catalog and honor edit revisions and selection usage", async () => {
  const f = fixture();
  try {
    writeFileSync(f.configPath, JSON.stringify({ models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "test" } },
      agents: { raw: { model: "m", tools: { use: [] } } } }));
    const marker = join(f.root, "EXECUTED");
    const hook = await f.manager.create("hooks", "local/guard", {
      "hook.json": JSON.stringify({ name: "guard", events: [{ name: "PreToolUse", match: "builtin/bash" }], command: "node", args: ["./index.mjs"], timeout_ms: 1000 }),
      "index.mjs": `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`,
    });
    assert.equal(hook.validation, "valid");
    assert.ok((await f.manager.list("hooks")).some(item => item.id === "local/guard"));
    assert.equal(existsSync(marker), false);
    const file = await f.manager.readFile("hooks", hook.id, "hook.json");
    await f.manager.saveFile("hooks", hook.id, "hook.json", file.revision, file.source + "\n");
    await assert.rejects(f.manager.saveFile("hooks", hook.id, "hook.json", file.revision, file.source), /conflict/);
    const revision = (await readManagedConfig({ configPath: f.configPath, env: { XDG_CONFIG_HOME: join(f.root, "global") } })).revision;
    await f.manager.attach("hooks", hook.id, "raw", revision);
    assert.deepEqual((await f.manager.inspect("hooks", hook.id)).usedBy, ["raw"]);
    await assert.rejects(f.manager.remove("hooks", hook.id), /detach|usage/);
    assert.equal(existsSync(marker), false);
  } finally { f.cleanup(); }
});

test("catalog/create/edit statically validate tools without importing their executable entry", async () => {
  const f = fixture();
  try {
    const sentinel = join(f.root, "IMPORTED");
    const asset = await f.manager.create("tools", "agent/example", { "tool.json": tool("example"),
      "index.mjs": `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'bad'); throw new Error('must not import');` });
    assert.equal(asset.validation, "valid"); assert.equal(existsSync(sentinel), false);
    const listed = await f.manager.list("tools"); assert.ok(listed.some((row) => row.id === "agent/example" && row.validation === "valid"));
    const file = await f.manager.readFile("tools", asset.id, "index.mjs");
    const saved = await f.manager.saveFile("tools", asset.id, "index.mjs", file.revision, "export async function handler() { return { isError: false, content: [] }; }");
    await assert.rejects(f.manager.saveFile("tools", asset.id, "index.mjs", file.revision, "stale"), /conflict/);
    assert.equal((await f.manager.readFile("tools", asset.id, "index.mjs")).source, saved.source);
    assert.equal(existsSync(sentinel), false);
    mkdirSync(join(f.root, "agent", "tools", "broken")); writeFileSync(join(f.root, "agent", "tools", "broken", "tool.json"), "{bad");
    assert.ok((await f.manager.list("tools")).some((row) => row.id === "agent/broken" && row.validation === "invalid"));
  } finally { f.cleanup(); }
});

test("owned file edits reject traversal/escaping symlinks; builtins fork explicitly", async () => {
  const f = fixture();
  try {
    const skill = await f.manager.create("skills", "agent/notes", { "SKILL.md": "---\nname: notes\ndescription: Use when making notes.\n---\nWrite clear notes.\n", "references/detail.md": "details" });
    assert.equal(skill.validation, "valid");
    await assert.rejects(f.manager.readFile("skills", skill.id, "../../config.json"), /path|escape/);
    const outside = join(f.root, "outside.md"); writeFileSync(outside, "untouched");
    symlinkSync(outside, join(f.root, "agent", "skills", "notes", "escape.md"));
    await assert.rejects(f.manager.readFile("skills", skill.id, "escape.md"), /escape/);
    await assert.rejects(f.manager.saveFile("tools", "builtin/bash", "index.mjs", "bad", "bad"), /read.only|fork/i);
    const fork = await f.manager.clone("tools", "builtin/bash", "agent/my_shell");
    assert.equal(fork.readOnly, false); assert.equal(fork.name, "my_shell");
    assert.equal(readFileSync(outside, "utf8"), "untouched");
  } finally { f.cleanup(); }
});

test("invalid assets never publish and a failed attachment leaves a valid unselected component", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.manager.create("tools", "agent/bad", { "tool.json": tool("wrong"), "index.mjs": "export const handler = () => {};" }), /manifest/);
    assert.equal(existsSync(join(f.root, "agent", "tools", "bad")), false);
    const asset = await f.manager.create("tools", "agent/good", { "tool.json": tool("good"), "index.mjs": "export const handler = () => {};" });
    assert.deepEqual(asset.usedBy, []);
    await assert.rejects(f.manager.attach("tools", asset.id, "missing", "wrong-revision"), /conflict|agent/);
    assert.equal((await f.manager.inspect("tools", asset.id)).validation, "valid");
    await f.manager.remove("tools", asset.id);
    assert.equal(existsSync(join(f.root, "agent", "tools", "good")), false);
  } finally { f.cleanup(); }
});

test("removal sees local/agent aliases of the same owned folder", async () => {
  const f = fixture(); const base = join(f.root, "same"); const configPath = join(base, "raw", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "test" } },
    agents: { raw: { model: "m", tools: { use: ["agent/shared"] } } } }));
  const manager = new ComponentManager({ configPath, env: { XDG_CONFIG_HOME: base } });
  try {
    await manager.create("tools", "local/shared", { "tool.json": tool("shared"), "index.mjs": "export function handler() {}" });
    assert.deepEqual((await manager.inspect("tools", "local/shared")).usedBy, ["raw"]);
    await assert.rejects(manager.remove("tools", "local/shared"), /detach|usage/);
    assert.equal(existsSync(join(base, "raw", "tools", "shared")), true);
  } finally { f.cleanup(); }
});

test("immutable packages are read-only while linked component edits reach authored source without imports", async () => {
  const f = fixture(); const source = join(f.root, "package-source");
  const env = { XDG_DATA_HOME: join(f.root, "data"), XDG_CONFIG_HOME: join(f.root, "global") };
  const folder = join(source, "tools", "external"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), tool("external"));
  writeFileSync(join(folder, "index.mjs"), "throw new Error('must not import');");
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/components", version: "1.0.0",
    description: "Test components", files: ["tools/external/tool.json", "tools/external/index.mjs"], exports: { tools: { external: "tools/external" } } }));
  try {
    await installPackage({ configPath: f.configPath, source, alias: "installed", env });
    await linkPackage({ configPath: f.configPath, source, alias: "dev", env });
    assert.equal((await f.manager.inspect("tools", "pkg/installed/tools/external")).readOnly, true);
    await assert.rejects(f.manager.saveFile("tools", "pkg/installed/tools/external", "index.mjs", "bad", "bad"), /read.only/);
    const linked = await f.manager.inspect("tools", "pkg/dev/tools/external"); assert.equal(linked.source, "linked");
    const file = await f.manager.readFile("tools", linked.id, "index.mjs");
    await f.manager.saveFile("tools", linked.id, "index.mjs", file.revision, "export function handler() {}\n");
    assert.equal(readFileSync(join(folder, "index.mjs"), "utf8"), "export function handler() {}\n");
  } finally { f.cleanup(); }
});
