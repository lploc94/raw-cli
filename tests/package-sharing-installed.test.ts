import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

async function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const code = await new Promise<number | null>((done) => child.on("exit", done));
  return { code, stdout, stderr };
}

function cacheKey(path: string, id: string): string {
  const db = new DatabaseSync(path);
  try { return String(db.prepare("SELECT cache_key FROM sessions WHERE id = ?").get(id)?.cache_key); }
  finally { db.close(); }
}

test("packed recipient installs mixed and standalone packages without author source or readable legacy state", async () => {
  const repo = process.cwd(), root = await mkdtemp(join(tmpdir(), "raw-package-installed-"));
  try {
    const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" });
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = join(root, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);
    const consumer = join(root, "consumer"); await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), '{"name":"raw-recipient","private":true,"type":"module"}\n');
    const install = spawnSync("npm", ["install", "--prefer-offline", "--legacy-peer-deps", "--ignore-scripts",
      "--no-audit", "--no-fund", tarball], { cwd: consumer, encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    const bin = join(consumer, "node_modules", ".bin", "raw");
    const examples = join(consumer, "node_modules", "raw-cli", "examples", "packages");
    assert.ok((await stat(join(consumer, "node_modules", "raw-cli", "docs", "packages.md"))).isFile());
    assert.ok((await stat(join(consumer, "node_modules", "raw-cli", "schemas", "raw-package.schema.json"))).isFile());
    for (const name of ["mixed-kit", "tool-only", "skill-only"]) {
      assert.ok((await stat(join(examples, name, "raw-package.json"))).isFile());
    }
    const author = join(root, "author"), recipient = join(root, "recipient"), artifacts = join(root, "artifacts");
    await mkdir(author); await mkdir(recipient); await mkdir(artifacts);
    const source = join(author, "mixed-kit"); await cp(join(examples, "mixed-kit"), source, { recursive: true });
    const archive = join(artifacts, "mixed.rawpkg");
    const env = { ...process.env, XDG_CONFIG_HOME: join(recipient, "config-home"),
      XDG_DATA_HOME: join(recipient, "data-home"), XDG_STATE_HOME: join(recipient, "state-home") };
    const packed = await run(bin, ["package", "pack", source, "--out", archive], author, env);
    assert.equal(packed.code, 0, packed.stderr);
    const archiveDigest = createHash("sha256").update(await readFile(archive)).digest("hex");
    await rm(author, { recursive: true, force: true });
    const mcpAlias = `mcp_search_echo_text_${createHash("sha256").update("search\0echo_text").digest("hex").slice(0, 12)}`;
    const call = (name: string, args: unknown, id: string, index: number) => ({ index, id, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    const provider = await startMockProvider([
      { frames: [openAiFrame({ tool_calls: [call("package_echo", { text: "one" }, "echo-v1", 0),
        call("list_skills", {}, "skills-v1", 1), call("read_var", { name: "host_label" }, "var-v1", 2),
        call(mcpAlias, { text: "mcp-one" }, "mcp-v1", 3)] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ tool_calls: [call("load_skill", { name: "repo-review" }, "load-v1", 0)] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "first-answer" }, "stop"), openAiDone] },
      { frames: [openAiFrame({ tool_calls: [call("package_echo", { text: "two" }, "echo-v2", 0),
        call("read_var", { name: "host_label" }, "var-v2", 1),
        call("load_skill", { name: "repo-review" }, "load-v2", 2)] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "changed-answer" }, "stop"), openAiDone] },
      { frames: [openAiFrame({ content: "stable-answer" }, "stop"), openAiDone] },
      { frames: [openAiFrame({ content: "label-answer" }, "stop"), openAiDone] },
    ]);
    try {
      const configPath = join(recipient, "config.json");
      await writeFile(configPath, JSON.stringify({ models: { local: { provider: "ollama",
        method: "openai-chat-completions", model_id: "recipient", base_url: provider.url } }, agents: {} }));
      const legacyDir = join(env.XDG_STATE_HOME, "raw"); await mkdir(legacyDir, { recursive: true });
      const legacy = join(legacyDir, "sessions.sqlite");
      const old = new DatabaseSync(legacy); old.exec("PRAGMA user_version = 4"); old.close();
      const oldBytes = await readFile(legacy);
      const registration = await run(bin, ["package", "install", archive, "--as", "kit", "--config", configPath], recipient, env);
      assert.equal(registration.code, 0, registration.stderr);
      const binding = await run(bin, ["agent", "add", "helper", "--from", "pkg/kit/agents/helper",
        "--model", "local", "--config", configPath], recipient, env);
      assert.equal(binding.code, 0, binding.stderr);
      const first = await run(bin, ["--config", configPath, "--agent", "helper", "first"], recipient, env);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(first.stdout, "first-answer\n");
      const id = first.stderr.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1]; assert.ok(id);
      assert.deepEqual(await readFile(legacy), oldBytes);
      const active = join(legacyDir, "stores", "storage-v6", "sessions.sqlite");
      const firstKey = cacheKey(active, id);
      assert.match(JSON.stringify(provider.requests[0]?.body), /mixed-kit Raw example/);
      assert.match(JSON.stringify(provider.requests[1]?.body), /mixed-v1: one/);
      assert.match(JSON.stringify(provider.requests[1]?.body), /mixed-example-host/);
      assert.match(JSON.stringify(provider.requests[1]?.body), /mcp-one/);
      assert.match(JSON.stringify(provider.requests[2]?.body), /Review a repository change/);
      const listedVars = await run(bin, ["vars", "list", "--config", configPath, "--agent", "helper"], recipient, env);
      assert.equal(listedVars.code, 0, listedVars.stderr);
      assert.match(listedVars.stdout, /host_label/);
      const value = await run(bin, ["vars", "get", "host_label", "--config", configPath, "--agent", "helper"], recipient, env);
      assert.equal(value.code, 0, value.stderr);
      assert.equal((JSON.parse(value.stdout) as { value: unknown }).value, "mixed-example-host");
      const recipientSource = join(root, "updated-kit"); await cp(join(examples, "mixed-kit"), recipientSource, { recursive: true });
      await writeFile(join(recipientSource, "prompts", "helper.md"), "Updated mixed-kit prompt.\n");
      await writeFile(join(recipientSource, "tools", "echo", "helper.mjs"), 'export const prefix = "mixed-v2";\n');
      await writeFile(join(recipientSource, "skills", "repo-review", "SKILL.md"),
        (await readFile(join(recipientSource, "skills", "repo-review", "SKILL.md"), "utf8")) + "\nUpdated review guidance.\n");
      await writeFile(join(recipientSource, "assets", "providers", "host-label.mjs"),
        (await readFile(join(recipientSource, "assets", "providers", "host-label.mjs"), "utf8"))
          .replace("mixed-example-host", "mixed-example-host-v2"));
      const updateArchive = join(artifacts, "mixed-updated.rawpkg");
      assert.equal((await run(bin, ["package", "pack", recipientSource, "--out", updateArchive], recipient, env)).code, 0);
      assert.equal((await run(bin, ["package", "update", "kit", "--from", updateArchive, "--config", configPath], recipient, env)).code, 0);
      const second = await run(bin, ["--resume", id, "second"], recipient, env);
      assert.equal(second.code, 0, second.stderr); assert.equal(second.stdout, "changed-answer\n");
      assert.match(JSON.stringify(provider.requests[4]?.body), /mixed-v2: two/);
      assert.match(JSON.stringify(provider.requests[4]?.body), /mixed-example-host-v2/);
      assert.match(JSON.stringify(provider.requests[4]?.body), /Updated review guidance/);
      const changedKey = cacheKey(active, id); assert.notEqual(changedKey, firstKey);
      const third = await run(bin, ["--resume", id, "third"], recipient, env);
      assert.equal(third.code, 0, third.stderr); assert.equal(third.stdout, "stable-answer\n");
      assert.equal(cacheKey(active, id), changedKey);
      assert.deepEqual((provider.requests[5]?.body as { messages: unknown[] }).messages.slice(0,
        (provider.requests[4]?.body as { messages: unknown[] }).messages.length),
      (provider.requests[4]?.body as { messages: unknown[] }).messages);
      assert.deepEqual((provider.requests[5]?.body as { tools: unknown[] }).tools,
        (provider.requests[4]?.body as { tools: unknown[] }).tools);
      const manifestPath = join(recipientSource, "raw-package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.version = "1.0.1"; await writeFile(manifestPath, JSON.stringify(manifest));
      const labelArchive = join(artifacts, "mixed-label.rawpkg");
      assert.equal((await run(bin, ["package", "pack", recipientSource, "--out", labelArchive], recipient, env)).code, 0);
      assert.equal((await run(bin, ["package", "update", "kit", "--from", labelArchive, "--config", configPath], recipient, env)).code, 0);
      const fourth = await run(bin, ["--resume", id, "fourth"], recipient, env);
      assert.equal(fourth.code, 0, fourth.stderr); assert.equal(fourth.stdout, "label-answer\n");
      assert.equal(cacheKey(active, id), changedKey);
      assert.deepEqual((provider.requests[6]?.body as { messages: unknown[] }).messages.slice(0,
        (provider.requests[5]?.body as { messages: unknown[] }).messages.length),
      (provider.requests[5]?.body as { messages: unknown[] }).messages);
      assert.deepEqual((provider.requests[6]?.body as { tools: unknown[] }).tools,
        (provider.requests[5]?.body as { tools: unknown[] }).tools);
      for (const [name, alias] of [["tool-only", "solo-tool"], ["skill-only", "solo-skill"]] as const) {
        const standaloneArchive = join(artifacts, `${name}.rawpkg`);
        const packedStandalone = await run(bin, ["package", "pack", join(examples, name), "--out", standaloneArchive],
          recipient, env);
        assert.equal(packedStandalone.code, 0, packedStandalone.stderr);
        const installedStandalone = await run(bin, ["package", "install", standaloneArchive, "--as", alias,
          "--config", configPath], recipient, env);
        assert.equal(installedStandalone.code, 0, installedStandalone.stderr);
      }
      const local = JSON.parse(await readFile(configPath, "utf8")) as { agents: Record<string, unknown> };
      local.agents.direct = { model: "local", tools: { use: ["builtin/list_skills", "builtin/load_skill",
        { ref: "pkg/solo-tool/tools/echo", as: "solo_echo" }] },
        skills: { use: [{ ref: "pkg/solo-skill/skills/repo-review", as: "solo_review" }] } };
      await writeFile(configPath, JSON.stringify(local));
      const standaloneSdk = await run(process.execPath, ["--input-type=module", "--eval", `
import { loadConfig, createRuntimeTools } from "raw-cli";
const config = await loadConfig({ configPath: ${JSON.stringify(configPath)}, flags: { agent: "direct" }, requireModel: false });
const tools = await createRuntimeTools({ runtime: config, cwd: ${JSON.stringify(recipient)} });
try {
  if (!tools.selectedNames.includes("solo_echo") || tools.skills[0]?.name !== "solo_review") throw new Error("standalone exports not selected");
  process.stdout.write("standalone-ok\\n");
} finally { await tools.mcp.close(); }
`], consumer, env);
      assert.equal(standaloneSdk.code, 0, standaloneSdk.stderr);
      assert.match(standaloneSdk.stdout, /standalone-ok/);
      const fork = join(recipient, "forked-kit");
      const forked = await run(bin, ["package", "fork", "kit", "--out", fork, "--config", configPath], recipient, env);
      assert.equal(forked.code, 0, forked.stderr);
      await writeFile(join(fork, "prompts", "helper.md"), "Forked recipient prompt.\n");
      await writeFile(join(fork, "tools", "echo", "helper.mjs"), 'export const prefix = "forked";\n');
      const linked = await run(bin, ["package", "link", fork, "--as", "dev", "--config", configPath], recipient, env);
      assert.equal(linked.code, 0, linked.stderr);
      const linkedAgent = await run(bin, ["agent", "add", "dev", "--from", "pkg/dev/agents/helper",
        "--model", "local", "--config", configPath], recipient, env);
      assert.equal(linkedAgent.code, 0, linkedAgent.stderr);
      const linkedSdk = await run(process.execPath, ["--input-type=module", "--eval", `
import { loadConfig, createRuntimeTools } from "raw-cli";
const config = await loadConfig({ configPath: ${JSON.stringify(configPath)}, flags: { agent: "dev" }, requireModel: false });
if (!config.systemPrompt.includes("Forked recipient prompt")) throw new Error("forked prompt not loaded");
const tools = await createRuntimeTools({ runtime: config, cwd: ${JSON.stringify(recipient)} });
try { if (!tools.selectedNames.includes("package_echo")) throw new Error("linked tool missing"); }
finally { await tools.mcp.close(); }
process.stdout.write("link-ok\\n");
`], consumer, env);
      assert.equal(linkedSdk.code, 0, linkedSdk.stderr);
      assert.match(linkedSdk.stdout, /link-ok/);
      await writeFile(join(consumer, "sharing-consumer.ts"), `
import { installPackage, updatePackage, removePackage, linkPackage, forkPackage,
  listInstalledPackages, resolveInstalledPackage, resolveInstalledDependency,
  addPackageAgent, loadVariableConfigAsync, exportAgentPackage, packPackage,
  type AddPackageAgentOptions, type PackageStoreOptions, type RawPackageManifest } from "raw-cli";
const store: PackageStoreOptions = { configPath: "config.json" };
const binding: AddPackageAgentOptions = { configPath: "config.json", name: "writer",
  from: "pkg/kit/agents/writer", model: "local", inputs: {} };
const manifest: RawPackageManifest | undefined = undefined;
void store; void binding; void manifest; void installPackage; void updatePackage;
void removePackage; void linkPackage; void forkPackage; void listInstalledPackages;
void resolveInstalledPackage; void resolveInstalledDependency; void addPackageAgent;
void loadVariableConfigAsync; void exportAgentPackage; void packPackage;
`);
      const declarations = spawnSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit", "--strict", "--skipLibCheck", "--target", "esnext", "--module", "nodenext",
        "--moduleResolution", "nodenext", "--typeRoots", join(repo, "node_modules", "@types"),
        "sharing-consumer.ts"], { cwd: consumer, encoding: "utf8" });
      assert.equal(declarations.status, 0, `${declarations.stdout}\n${declarations.stderr}`);
      assert.ok(archiveDigest.length === 64);
      const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
      process.stdout.write(`installed-sharing-evidence ${JSON.stringify({ sourceCommit, archiveDigest,
        installedBinary: bin, sessionId: id, keys: { first: firstKey, changed: changedKey },
        requestCount: provider.requests.length })}\n`);
    } finally { await provider.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
