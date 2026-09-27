import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadSelectedHooks } from "../src/hooks/loader.js";
import { runHook } from "../src/hooks/runner.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raw-hooks-config-"));
  const configPath = join(root, "raw.json");
  const globalConfigRoot = join(root, "global", "raw");
  const writeConfig = async (hooks?: unknown) => writeFile(configPath, JSON.stringify({
    default_agent: "raw", models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { raw: { model: "local", tools: { use: [] }, ...(hooks === undefined ? {} : { hooks }) } },
  }));
  const makeHook = async (scope: "agent" | "local", name: string, manifest: Record<string, unknown>) => {
    const folder = join(scope === "agent" ? root : globalConfigRoot, "hooks", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "hook.json"), JSON.stringify(manifest));
    await writeFile(join(folder, "run.mjs"), "process.stdout.write('{}')\n");
    return folder;
  };
  return { root, configPath, globalConfigRoot, writeConfig, makeHook };
}

const manifest = (name: string) => ({ name, events: [{ name: "PreToolUse", match: "builtin/bash",
  when: { any: "commands[*].command", regex: "rm\\s" } }], command: "node", args: ["./run.mjs"] });

test("agent config selects exact ordered hook IDs; unselected broken hook remains inert", async () => {
  const f = await fixture();
  await f.makeHook("agent", "guard", manifest("guard"));
  await f.makeHook("local", "notify", { name: "notify", events: [{ name: "Stop" }], command: "node", args: ["./run.mjs"] });
  await f.makeHook("agent", "broken", { name: "broken", events: [], command: "node" });
  await f.writeConfig({ use: ["local/notify", "agent/guard"] });
  const config = await loadConfig({ configPath: f.configPath, requireModel: false,
    env: { XDG_CONFIG_HOME: join(f.root, "global") } });
  assert.deepEqual(config.hookIds, ["local/notify", "agent/guard"]);
  const hooks = await loadSelectedHooks({ selectedIds: config.hookIds, configPath: f.configPath,
    globalConfigRoot: f.globalConfigRoot });
  assert.deepEqual(hooks.map(h => h.id), ["local/notify", "agent/guard"]);
  assert.equal(hooks[1]!.events[0]!.name, "PreToolUse");
  assert.match(hooks[1]!.args[0]!, /run\.mjs$/);
  await f.writeConfig();
  assert.deepEqual((await loadConfig({ configPath: f.configPath, requireModel: false })).hookIds, []);
  assert.equal((await readFile(join(f.root, "hooks", "broken", "hook.json"), "utf8")).includes("broken"), true);
});

test("hook selection and manifest reject duplicates, malformed event filter and escaping assets", async () => {
  const f = await fixture();
  await f.makeHook("agent", "guard", manifest("guard"));
  await f.writeConfig({ use: ["agent/guard", "agent/guard"] });
  await assert.rejects(loadConfig({ configPath: f.configPath, requireModel: false }), /duplicate/i);
  await f.writeConfig({ use: ["agent/guard"] });
  const folder = join(f.root, "hooks", "guard");
  await writeFile(join(folder, "hook.json"), JSON.stringify({ name: "guard", events: [{ name: "Stop", match: "*" }], command: "node" }));
  await assert.rejects(loadSelectedHooks({ selectedIds: ["agent/guard"], configPath: f.configPath }), /match|tool event/i);
  await writeFile(join(folder, "hook.json"), JSON.stringify(manifest("guard")));
  await writeFile(join(f.root, "outside.mjs"), "process.stdout.write('{}')");
  await symlink(join(f.root, "outside.mjs"), join(folder, "escape.mjs"));
  await writeFile(join(folder, "hook.json"), JSON.stringify({ ...manifest("guard"), args: ["./escape.mjs"] }));
  await assert.rejects(loadSelectedHooks({ selectedIds: ["agent/guard"], configPath: f.configPath }), /escape|outside|contain/i);
});

test("a loaded hook retains its script bytes until the next attachment", async () => {
  const f = await fixture();
  const folder = await f.makeHook("agent", "guard", manifest("guard"));
  await writeFile(join(folder, "run.mjs"), "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({message:'first'})));\n");
  const load = () => loadSelectedHooks({ selectedIds: ["agent/guard"], configPath: f.configPath });
  const first = (await load())[0]!;
  await writeFile(join(folder, "run.mjs"), "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({message:'second'})));\n");
  const request = { protocol_version: 1 as const, event: "PreToolUse" as const, cwd: f.root,
    tool: { identity: "builtin/bash", name: "bash", arguments: { commands: [{ command: "rm old" }] } } };
  assert.equal((await runHook(first, request)).message, "first");
  assert.equal((await runHook((await load())[0]!, request)).message, "second");
});
