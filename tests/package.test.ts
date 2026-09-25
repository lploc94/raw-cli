import assert from "node:assert/strict";
import { testConfig } from "./fixtures/config.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

test("T-08d: packed consumer executes installed CLI task/MCP/ACP and imports library/types outside checkout", async () => {
  const repo = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "raw-installed-"));
  try {
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = join(root, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);
  const consumer = join(root, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"name":"raw-consumer","private":true,"type":"module"}\n');
  const install = spawnSync("npm", ["install", "--prefer-offline", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: consumer, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const bin = join(consumer, "node_modules", ".bin", "raw");
  await access(bin);
  for (const name of ["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill"]) {
    const example = join(consumer, "node_modules", "raw-cli", "examples", "tools", name);
    await access(join(example, "tool.json"));
    await access(join(example, "index.mjs"));
  }
  await access(join(consumer, "node_modules", "raw-cli", "examples", "agents", "project-helper", "raw.json"));
  const skillIds = ["configure_raw", "create_skill", "create_tool", "create_agent", "add_mcp"];
  const packagedSkill = join(consumer, "node_modules", "raw-cli", "dist", "skills", "builtin", "configure_raw");
  for (const id of skillIds) {
    const folder = join(consumer, "node_modules", "raw-cli", "dist", "skills", "builtin", id);
    const manifest = JSON.parse(await readFile(join(folder, "skill.json"), "utf8")) as { id: string; name: string; description: string };
    assert.equal(manifest.id, id);
    assert.equal(manifest.name, id);
    assert.ok(manifest.description);
    const body = await readFile(join(folder, "SKILL.md"), "utf8");
    assert.ok(body.length > 2000);
    assert.equal(body, await readFile(join(consumer, "node_modules", "raw-cli", "examples", "skills", id, "SKILL.md"), "utf8"));
  }
  const skillBody = await readFile(join(packagedSkill, "SKILL.md"), "utf8");
  for (const name of ["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill"]) {
    const folder = join(consumer, "node_modules", "raw-cli", "dist", "tools", "builtin", name);
    const manifest = JSON.parse(await readFile(join(folder, "tool.json"), "utf8")) as { id: string; entry: string; input_schema: { type: string } };
    assert.equal(manifest.id, name);
    assert.equal(manifest.entry, "./index.mjs");
    assert.equal(manifest.input_schema.type, "object");
    await access(join(folder, "index.mjs"));
  }
  const standalone = await run(process.execPath, ["--input-type=module", "--eval", `
import { pathToFileURL } from "node:url";
const module = await import(pathToFileURL(${JSON.stringify(join(consumer, "node_modules", "raw-cli", "dist", "tools", "builtin", "write_file", "index.mjs"))}).href);
if (typeof module.handler !== "function" || typeof module.validateArgs !== "function") throw new Error("missing plugin exports");
const invalid = module.validateArgs({ operations: [
  { path: "sentinel", mode: "overwrite", content: "x" },
  { path: "sentinel", mode: "replace_lines", start_line: 2, end_line: 1, content: "x", expected_sha256: "0".repeat(64) },
] });
if (!/operations\\[1\\].*invalid line range/.test(invalid)) throw new Error("missing semantic batch validator");
`], consumer, { ...process.env });
  assert.equal(standalone.code, 0, standalone.stderr);
  const installedLoader = await run(process.execPath, ["--input-type=module", "--eval", `
import { loadToolPlugins } from "raw-cli";
const tools = await loadToolPlugins({ selectedIds: ["builtin/read_file"], configPath: "ignored.json" });
if (tools.length !== 1 || tools[0].registration.name !== "read_file") throw new Error("installed bundled root failed");
`], consumer, { ...process.env });
  assert.equal(installedLoader.code, 0, installedLoader.stderr);
  const installedSkillLoader = await run(process.execPath, ["--input-type=module", "--eval", `
import { loadSelectedSkills } from "raw-cli";
const selected = await loadSelectedSkills({ selectedIds: ["builtin/configure_raw", "builtin/create_skill", "builtin/create_tool", "builtin/create_agent", "builtin/add_mcp"], configPath: "ignored.json", maxOutputBytes: 8192 });
if (selected.length !== 5 || selected[0].name !== "configure_raw" || !selected[0].markdown.includes("default_agent")) throw new Error("installed skill root failed");
`], consumer, { ...process.env, XDG_CONFIG_HOME: join(root, "other-config") });
  assert.equal(installedSkillLoader.code, 0, installedSkillLoader.stderr);
  const builtinProbe = async (ids: string[], xdg = join(root, "other-config")) => run(process.execPath,
    ["--input-type=module", "--eval", `import { loadSelectedSkills } from "raw-cli";
try { await loadSelectedSkills({ selectedIds: ${JSON.stringify(ids)}, configPath: "ignored.json", maxOutputBytes: 8192 }); }
catch (error) { process.stderr.write(String(error)); process.exitCode = 2; }`], consumer,
    { ...process.env, XDG_CONFIG_HOME: xdg });
  const manifestPath = join(packagedSkill, "skill.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, "{broken");
  assert.match((await builtinProbe(["builtin/configure_raw"])).stderr, /invalid skill manifest JSON/);
  await writeFile(manifestPath, originalManifest);
  const outside = join(root, "outside-skill.md");
  await writeFile(outside, "outside");
  const markdownPath = join(packagedSkill, "SKILL.md");
  await unlink(markdownPath);
  await symlink(outside, markdownPath);
  assert.match((await builtinProbe(["builtin/configure_raw"])).stderr, /escapes folder/);
  await unlink(markdownPath);
  await writeFile(markdownPath, skillBody);
  const duplicateRoot = join(root, "other-config", "raw", "skills", "duplicate");
  await mkdir(duplicateRoot, { recursive: true });
  await writeFile(join(duplicateRoot, "skill.json"), JSON.stringify({ api_version: 1, id: "duplicate", version: "1.0.0", name: "configure_raw", description: "Duplicate" }));
  await writeFile(join(duplicateRoot, "SKILL.md"), "duplicate");
  assert.match((await builtinProbe(["builtin/configure_raw", "local/duplicate"])).stderr, /duplicate skill name/);
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), OPENAI_API_KEY: "key" };
  assert.equal((await run(bin, ["--version"], consumer, env)).stdout.trim(), "0.1.0");
  assert.match((await run(bin, ["--help"], consumer, env)).stdout, /Usage: raw/);

  const starterProvider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "starter-list", type: "function", function: { name: "list_skills", arguments: "{}" } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "starter-load", type: "function", function: { name: "load_skill", arguments: '{"name":"configure_raw"}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "starter-ready" }, "stop"), openAiDone] },
  ]);
  try {
    const starterXdg = join(root, "starter-config");
    const starterEnv = { ...env, XDG_CONFIG_HOME: starterXdg, XDG_STATE_HOME: join(root, "starter-state") };
    const initialized = await run(bin, ["config", "init"], consumer, starterEnv);
    assert.equal(initialized.code, 0, initialized.stderr);
    const starterPath = join(starterXdg, "raw", "config.json");
    const starterSource = await readFile(starterPath, "utf8");
    const starter = JSON.parse(starterSource);
    assert.equal(starter.default_agent, "raw");
    assert.deepEqual(starter.agents.raw.skills.use, skillIds.map((id) => `builtin/${id}`));
    assert.equal((await stat(starterPath)).mode & 0o777, 0o600);
    starter.models.local.provider = "openai";
    starter.models.local.model_id = "fixture";
    starter.models.local.base_url = starterProvider.url;
    await writeFile(starterPath, JSON.stringify(starter));
    const task = await run(bin, ["setup Raw"], consumer, starterEnv);
    assert.equal(task.code, 0, task.stderr);
    assert.equal(task.stdout, "starter-ready\n");
    assert.equal(starterProvider.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(starterProvider.requests[0]?.body), /configure_raw|create_skill|create_tool|create_agent|add_mcp/);
    assert.match(JSON.stringify(starterProvider.requests[1]?.body), /configure_raw/);
    assert.match(JSON.stringify(starterProvider.requests[2]?.body), /default_agent/);
    const secondInit = await run(bin, ["config", "init"], consumer, starterEnv);
    assert.equal(secondInit.code, 2);
    assert.equal(await readFile(starterPath, "utf8"), JSON.stringify(starter));
  } finally { await starterProvider.close(); }

  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "write", type: "function", function: {
        name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"installed-sentinel.txt","content":"installed-write"}]}',
      } },
      { index: 1, id: "read", type: "function", function: {
        name: "read_file", arguments: '{"files":[{"path":"installed-sentinel.txt"}]}',
      } },
      { index: 2, id: "shell", type: "function", function: {
        name: "bash", arguments: '{"commands":[{"command":"cat installed-sentinel.txt"}]}',
      } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-task-done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "mcp", type: "function", function: {
      name: `mcp_pkg_selected_${createHash("sha256").update("pkg\0selected").digest("hex").slice(0, 12)}`,
      arguments: '{"value":"probe"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-mcp-done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "image", type: "function", function: {
      name: "view_image", arguments: '{"path":"installed.jpg"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-image-done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-session-first" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-session-second" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-acp-done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-acp-resumed" }, "stop"), openAiDone] },
  ]);
  try {
    const configPath = testConfig("openai", "fixture", fixture.url);
    const args = ["--config", configPath];
    const task = await run(bin, [...args, "write sentinel"], consumer, env);
    assert.equal(task.code, 0, task.stderr);
    assert.equal(task.stdout, "installed-task-done\n");
    assert.equal(await readFile(join(consumer, "installed-sentinel.txt"), "utf8"), "installed-write");
    assert.match(JSON.stringify(fixture.requests[1]?.body), /installed-write/);
    const replay = (fixture.requests[1]?.body as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> }).messages
      .filter((message) => message.role === "tool");
    assert.deepEqual(replay.map((message) => message.tool_call_id), ["write", "read", "shell"]);
    assert.deepEqual(replay.map((message) => (JSON.parse(message.content!) as { results: Array<{ status: string }> }).results[0]?.status),
      ["ok", "ok", "ok"]);

    const document = JSON.parse(await readFile(configPath, "utf8"));
    document.mcp = { servers: { pkg: { transport: "stdio", command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), join(repo, "tests/fixtures/mcp-stdio.ts")], env: { MCP_LABEL: "pkg" } } } };
    document.agents.fixture.tools.use.push("mcp/pkg/selected");
    await writeFile(configPath, JSON.stringify(document));
    const mcp = await run(bin, [...args, "call MCP"], consumer, env);
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.equal(mcp.stdout, "installed-mcp-done\n");
    assert.match(JSON.stringify(fixture.requests[3]?.body), /pkg:selected:probe/);

    document.models.fixture.vision = true;
    document.agents.fixture.tools.use.push("builtin/view_image");
    await writeFile(configPath, JSON.stringify(document));
    const jpeg = await readFile(join(repo, "tests/fixtures/vision.jpg"));
    await writeFile(join(consumer, "installed.jpg"), jpeg);
    const vision = await run(bin, [...args, "inspect installed.jpg"], consumer, env);
    assert.equal(vision.code, 0, vision.stderr);
    assert.equal(vision.stdout, "installed-image-done\n");
    assert.match(JSON.stringify(fixture.requests[4]?.body), /view_image/);
    assert.ok(JSON.stringify(fixture.requests[5]?.body).includes(jpeg.toString("base64")));
    assert.match(JSON.stringify(fixture.requests[5]?.body), /image_url/);

    const saved = await run(bin, [...args, "installed first"], consumer, env);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout, "installed-session-first\n");
    const listed = await run(bin, ["sessions"], consumer, env);
    assert.equal(listed.code, 0, listed.stderr);
    const sessionId = listed.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    assert.ok(sessionId);
    assert.match(saved.stderr, new RegExp(`raw: continue: raw --resume ${sessionId} "query"`));
    const resumed = await run(bin, ["--resume", sessionId, "installed followup"], consumer, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, "installed-session-second\n");
    assert.match(resumed.stderr, new RegExp(`raw: continue: raw --resume ${sessionId} "query"`));
    assert.match(JSON.stringify(fixture.requests[7]?.body), /installed-session-first/);
    const shown = await run(bin, ["sessions", "show", sessionId], consumer, env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /installed-session-first/);
    const stats = await run(bin, ["sessions", "stats"], consumer, env);
    assert.equal(stats.code, 0, stats.stderr);
    assert.ok((JSON.parse(stats.stdout) as { databaseBytes: number }).databaseBytes > 0);

    const parentScript = `import { createAcpClient, BUILTIN_TOOL_DEFINITIONS } from "raw-cli";
const options = { command: ${JSON.stringify(bin)}, args: ${JSON.stringify(["--acp", "--stdio", ...args])} };
let id;
const first = await createAcpClient(options);
try { id = await first.newSession(process.cwd()); const answer = await first.prompt(id, "ACP installed");
if (answer.stopReason !== "end_turn" || BUILTIN_TOOL_DEFINITIONS.length !== 3) throw new Error("initial ACP failed");
} finally { await first.close(); }
const replay = [];
const second = await createAcpClient({ ...options, onUpdate: ({ update }) => replay.push(update) });
try { if (!(await second.listSessions(process.cwd())).sessions.some(item => item.sessionId === id)) throw new Error("ACP list failed");
await second.loadSession(id, process.cwd());
if (!JSON.stringify(replay).includes("installed-acp-done")) throw new Error("ACP replay failed");
} finally { await second.close(); }
const third = await createAcpClient(options);
try { await third.resumeSession(id, process.cwd());
if ((await third.prompt(id, "ACP resumed")).stopReason !== "end_turn") throw new Error("ACP resume failed");
} finally { await third.close(); }
const fourth = await createAcpClient(options);
try { await fourth.deleteSession(id); } finally { await fourth.close(); }
process.stdout.write("installed-parent-ok\\n");`;
    const parent = await run(process.execPath, ["--input-type=module", "--eval", parentScript], consumer, env);
    assert.equal(parent.code, 0, parent.stderr);
    assert.match(parent.stdout, /installed-parent-ok/);
    assert.match(JSON.stringify(fixture.requests[8]?.body), /ACP installed/);
    assert.match(JSON.stringify(fixture.requests[9]?.body), /ACP resumed/);

    await writeFile(join(consumer, "consumer.ts"), 'import { ToolRegistry, listSessions, getSessionHistory, type AgentOptions, type CompactSettings, type UserInput, type ApiMethod, type SessionHistoryOptions } from "raw-cli";\nconst options: AgentOptions | undefined = undefined;\nconst compact: CompactSettings = { keepRecentTurns: 2, maxOutputTokens: 512 };\nconst input: UserInput = "hello";\nconst method: ApiMethod = "openai-responses";\nconst history: SessionHistoryOptions | undefined = undefined;\nconst names: string[] = new ToolRegistry().definitions().map(tool => tool.name);\nvoid options; void compact; void input; void method; void history; void names; void listSessions; void getSessionHistory;\n');
    const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--target", "esnext", "--module", "nodenext", "--moduleResolution", "nodenext",
      "--typeRoots", join(repo, "node_modules/@types"), "consumer.ts"], { cwd: consumer, encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  } finally { await fixture.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
