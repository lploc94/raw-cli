import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportAgentPackage } from "../src/packages/export.js";
import { inspectPackage } from "../src/packages/inspect.js";
import { packPackage } from "../src/packages/archive.js";
import { installPackage } from "../src/packages/store.js";
import { addPackageAgent } from "../src/packages/cli.js";
import { loadConfig } from "../src/config.js";
import { loadSelectedHooks } from "../src/hooks/loader.js";
import { runHook } from "../src/hooks/runner.js";

test("exported agent hook runs after pack/install without the author source", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-package-hooks-"));
  const author = join(root, "author"), recipient = join(root, "recipient"), packageRoot = join(root, "export");
  await mkdir(join(author, "hooks", "audit"), { recursive: true }); await mkdir(recipient);
  const configPath = join(author, "raw.json"), recipientConfig = join(recipient, "raw.json");
  const model = { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" };
  await writeFile(configPath, JSON.stringify({ default_agent: "writer", models: { local: model },
    agents: { writer: { model: "local", tools: { use: [] }, hooks: { use: ["agent/audit"] } } } }));
  await writeFile(join(author, "hooks", "audit", "hook.json"), JSON.stringify({ name: "audit", command: "node",
    args: ["./audit.mjs"], events: [{ name: "UserPromptSubmit" }] }));
  await writeFile(join(author, "hooks", "audit", "audit.mjs"),
    "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ message: 'installed hook ran' })));\n");
  const exported = await exportAgentPackage({ configPath, agentName: "writer", out: packageRoot,
    name: "@example/hooked", version: "1.0.0" });
  assert.deepEqual(exported.report.exports.hooks, ["audit"]);
  const archive = join(root, "kit.rawpkg"); await packPackage(packageRoot, archive);
  assert.deepEqual((await inspectPackage(archive)).exports.hooks, ["audit"]);
  await rm(author, { recursive: true, force: true });
  await writeFile(recipientConfig, JSON.stringify({ models: { local: model }, agents: {} }));
  const env = { XDG_CONFIG_HOME: join(recipient, "config"), XDG_DATA_HOME: join(recipient, "data"),
    XDG_STATE_HOME: join(recipient, "state") };
  await installPackage({ configPath: recipientConfig, source: archive, alias: "kit", env });
  await addPackageAgent({ configPath: recipientConfig, name: "writer", from: "pkg/kit/agents/writer", model: "local", env });
  const runtime = await loadConfig({ configPath: recipientConfig, flags: { agent: "writer" }, requireModel: false, env });
  assert.deepEqual(runtime.hookIds, ["pkg/kit/hooks/audit"]);
  const hooks = await loadSelectedHooks({ selectedIds: runtime.hookIds, configPath: recipientConfig,
    globalConfigRoot: runtime.globalConfigRoot, packageHooks: runtime.packageHooks });
  const result = await runHook(hooks[0]!, { protocol_version: 1, event: "UserPromptSubmit", cwd: recipient, input: "hello" });
  assert.equal(result.message, "installed hook ran");
  assert.match(await readFile(join(packageRoot, "agents", "writer.json"), "utf8"), /#hooks\/audit/);
});
