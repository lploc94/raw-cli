import assert from "node:assert/strict";
import { testConfig } from "./fixtures/config.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, keepStdin = false) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  if (!keepStdin) child.stdin.end();
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
  for (const name of ["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill", "list_vars", "read_var", "todo", "ask_user", "process"]) {
    const example = join(consumer, "node_modules", "raw-cli", "examples", "tools", name);
    await access(join(example, "tool.json"));
    await access(join(example, "index.mjs"));
  }
  await access(join(consumer, "node_modules", "raw-cli", "examples", "agents", "project-helper", "raw.json"));
  assert.equal(await readFile(join(consumer, "node_modules", "raw-cli", "docs", "skill-authoring.md"), "utf8"),
    await readFile(join(repo, "docs", "skill-authoring.md"), "utf8"));
  assert.equal(await readFile(join(consumer, "node_modules", "raw-cli", "docs", "terminal-output.md"), "utf8"),
    await readFile(join(repo, "docs", "terminal-output.md"), "utf8"));
  const skillIds = ["configure_raw", "create_skill", "create_tool", "create_hook", "create_agent", "add_mcp", "create_package"];
  const packagedSkill = join(consumer, "node_modules", "raw-cli", "dist", "skills", "builtin", "configure_raw");
  for (const id of skillIds) {
    const folder = join(consumer, "node_modules", "raw-cli", "dist", "skills", "builtin", id);
    const body = await readFile(join(folder, "SKILL.md"), "utf8");
    const skill = parseSkillMarkdown(body, id);
    assert.equal(skill.name, id.replaceAll("_", "-"));
    assert.ok(skill.description);
    assert.ok(skill.markdown.trim());
    assert.ok(Buffer.byteLength(skill.markdown) <= 8192);
    assert.equal(body, await readFile(join(repo, "src", "skills", "bundled", id, "SKILL.md"), "utf8"));
    assert.equal(body, await readFile(join(consumer, "node_modules", "raw-cli", "examples", "skills", id, "SKILL.md"), "utf8"));
  }
  for (const name of ["manifest.md", "packages.md"]) {
    const reference = await readFile(join(repo, "src", "skills", "bundled", "create_package", "references", name), "utf8");
    for (const base of ["dist/skills/builtin", "examples/skills"]) {
      assert.equal(await readFile(join(consumer, "node_modules", "raw-cli", base, "create_package", "references", name), "utf8"), reference);
    }
  }
  const skillBody = await readFile(join(packagedSkill, "SKILL.md"), "utf8");
  for (const name of ["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill", "list_vars", "read_var", "todo", "ask_user", "process"]) {
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
  const installedAsk = await run(process.execPath, ["--input-type=module", "--eval", `
import { loadToolPlugins, ToolRegistry, ProcessSupervisor } from "raw-cli";
const registry = new ToolRegistry();
for (const item of await loadToolPlugins({ selectedIds: ["builtin/ask_user"], configPath: "ignored.json" })) registry.register(item.registration);
const result = await registry.dispatch("ask_user", { questions: [{id:"q",label:"Q",kind:"text"}] }, { cwd: process.cwd(), maxOutputBytes: 8192, interactions: { request: async input => {
  if (input.panel !== "questions" || input.document.blocks[0].fields[0].id !== "q") throw new Error("bad packaged form");
  return {status:"answered",answers:{q:"installed 雪"}};
} } });
if (result.isError || result.content[0].value.answers.q !== "installed 雪") throw new Error(JSON.stringify(result));
const standalone = await import("./node_modules/raw-cli/examples/tools/ask_user/index.mjs");
const forked = await standalone.handler({questions:[{id:"fork",label:"Fork",kind:"text"}]}, {interactions:{request:async () => ({status:"cancelled"})}});
if (forked.code !== "interaction_cancelled") throw new Error("standalone fork failed");
const processes = new ProcessSupervisor();
try {
  for (const item of await loadToolPlugins({ selectedIds: ["builtin/process"], configPath: "ignored.json" })) registry.register(item.registration);
  const context = { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true, processes: processes.forSession("installed") };
  const started = await registry.dispatch("process", { action: "start", command: "sleep 30" }, context);
  if (started.isError || started.content[0].type !== "json") throw new Error(JSON.stringify(started));
  const stopped = await registry.dispatch("process", { action: "stop", id: started.content[0].value.id }, context);
  if (stopped.isError || stopped.content[0].value.state !== "stopped") throw new Error(JSON.stringify(stopped));
} finally { await processes.close(); }
`], consumer, { ...process.env });
  assert.equal(installedAsk.code, 0, installedAsk.stderr);
  const installedSkillLoader = await run(process.execPath, ["--input-type=module", "--eval", `
import { loadSelectedSkills } from "raw-cli";
const selected = await loadSelectedSkills({ selectedIds: ["builtin/configure_raw", "builtin/create_skill", "builtin/create_tool", "builtin/create_hook", "builtin/create_agent", "builtin/add_mcp", "builtin/create_package"], configPath: "ignored.json", maxOutputBytes: 8192 });
if (selected.length !== 7 || selected[0].name !== "configure-raw" || !selected[0].markdown.includes("default_agent") || selected[6].name !== "create-package") throw new Error("installed skill root failed");
`], consumer, { ...process.env, XDG_CONFIG_HOME: join(root, "other-config") });
  assert.equal(installedSkillLoader.code, 0, installedSkillLoader.stderr);
  const builtinProbe = async (ids: string[], xdg = join(root, "other-config")) => run(process.execPath,
    ["--input-type=module", "--eval", `import { loadSelectedSkills } from "raw-cli";
try { await loadSelectedSkills({ selectedIds: ${JSON.stringify(ids)}, configPath: "ignored.json", maxOutputBytes: 8192 }); }
catch (error) { process.stderr.write(String(error)); process.exitCode = 2; }`], consumer,
    { ...process.env, XDG_CONFIG_HOME: xdg });
  const manifestPath = join(packagedSkill, "SKILL.md");
  await writeFile(manifestPath, "{broken");
  assert.match((await builtinProbe(["builtin/configure_raw"])).stderr, /frontmatter/);
  await writeFile(manifestPath, skillBody);
  const outside = join(root, "outside-skill.md");
  await writeFile(outside, "outside");
  const markdownPath = join(packagedSkill, "SKILL.md");
  await unlink(markdownPath);
  await symlink(outside, markdownPath);
  assert.match((await builtinProbe(["builtin/configure_raw"])).stderr, /escapes folder/);
  await unlink(markdownPath);
  await writeFile(markdownPath, skillBody);
  const duplicateRoot = join(root, "other-config", "raw", "skills", "configure-raw");
  await mkdir(duplicateRoot, { recursive: true });
  await writeFile(join(duplicateRoot, "SKILL.md"), "---\nname: configure-raw\ndescription: Duplicate\n---\nduplicate");
  assert.match((await builtinProbe(["builtin/configure_raw", "local/configure-raw"])).stderr, /duplicate skill name/);
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), OPENAI_API_KEY: "key" };
  assert.equal((await run(bin, ["--version"], consumer, env)).stdout.trim(), "0.1.0");
  assert.match((await run(bin, ["--help"], consumer, env)).stdout, /Usage: raw/);

  assert.equal(await readFile(join(consumer, "node_modules/raw-cli/docs/vars.md"), "utf8"), await readFile(join(repo, "docs/vars.md"), "utf8"));
  const providerExample = join(root, "relocated-provider");
  await cp(join(consumer, "node_modules/raw-cli/examples/providers/host-info"), providerExample, { recursive: true });
  const varsPath = join(providerExample, "raw.json");
  const varsEnv = { ...env, RAW_EXAMPLE_TOKEN: "installed-use-value-7321", XDG_STATE_HOME: join(root, "vars-state") };
  const listedVars = await run(bin, ["--config", varsPath, "vars", "list"], consumer, varsEnv);
  assert.equal(listedVars.code, 0, listedVars.stderr);
  assert.equal(JSON.parse(listedVars.stdout).vars.length, 3);
  const gotVar = await run(bin, ["--config", varsPath, "vars", "get", "hostname"], consumer, varsEnv);
  assert.equal(gotVar.code, 0, gotVar.stderr); assert.equal(JSON.parse(gotVar.stdout).value, hostname());
  await assert.rejects(access(varsEnv.XDG_STATE_HOME));
  const variableCall = (name: string, args: unknown, id: string) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
  const varsProvider = await startMockProvider([
    variableCall("list_vars", {}, "catalog"), variableCall("read_var", { name: "hostname" }, "hostname"),
    variableCall("bash", { commands: [{ command: 'test "$TOKEN" = "$RAW_EXAMPLE_TOKEN" && printf verified > vars-verified', env_refs: { TOKEN: "token" } }] }, "consume"),
    { frames: [openAiFrame({ content: "vars-ready" }, "stop"), openAiDone] },
  ]);
  try {
    const doc = JSON.parse(await readFile(varsPath, "utf8"));
    doc.models.local = { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: varsProvider.url };
    await writeFile(varsPath, JSON.stringify(doc));
    const task = await run(bin, ["--config", varsPath, "inspect vars"], consumer, varsEnv);
    assert.equal(task.code, 0, task.stderr);
    assert.equal(await readFile(join(consumer, "vars-verified"), "utf8"), "verified");
    assert.equal(varsProvider.requests.length, 4);
    assert.match(JSON.stringify(varsProvider.requests[2]!.body), /observed_at/);
    assert.doesNotMatch(JSON.stringify(varsProvider.requests), /installed-use-value-7321/);
  } finally { await varsProvider.close(); }

  const terminalProvider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "terminal-read", type: "function", function: {
      name: "read_file", arguments: '{"files":[{"path":"installed-preview.ts"}]}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "# Installed result\n\n```ts\nconst installedPreview = 7;\n```" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "# Pipe result\n\n```ts\nconst piped = true;\n```" }, "stop"), openAiDone] },
  ]);
  try {
    await writeFile(join(consumer, "installed-preview.ts"), "const installedPreview = 7;\n");
    const terminalConfig = testConfig("openai", "fixture", terminalProvider.url);
    const terminalEnv = { ...env, TERM: "xterm-256color", NO_COLOR: "",
      RAW_TEST_PTY_COLUMNS: "80", RAW_TEST_PTY_ROWS: "24" };
    const tty = await run("python3", [join(repo, "tests", "fixtures", "pty-bridge.py"), bin,
      "--config", terminalConfig, "--theme", "dark", "--icons", "unicode", "installed terminal"], consumer, terminalEnv, true);
    assert.equal(tty.code, 0, tty.stdout + tty.stderr);
    assert.match(tty.stdout, /↳ read_file/);
    const ttyPlain = tty.stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    assert.match(ttyPlain, /const installedPreview = 7;/);
    assert.match(tty.stdout, /Installed result/);
    assert.match(tty.stdout, /\u001b\[(?:3[0-7]|9[0-7])mconst/);
    assert.match(tty.stdout, /Context/);
    assert.match(tty.stdout, /raw --resume [0-9a-f-]+ "query"/);
    const pipe = await run(bin, ["--config", terminalConfig, "--color", "always", "--icons", "ascii", "pipe"], consumer, terminalEnv);
    assert.equal(pipe.code, 0, pipe.stderr);
    assert.equal(pipe.stdout, "# Pipe result\n\n```ts\nconst piped = true;\n```\n");
    assert.doesNotMatch(pipe.stdout + pipe.stderr, /\u001b\[/);
    assert.equal(terminalProvider.requests.length, 3);
  } finally { await terminalProvider.close(); }

  const starterProvider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "starter-list", type: "function", function: { name: "list_skills", arguments: "{}" } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "starter-load", type: "function", function: { name: "load_skill", arguments: '{"name":"configure-raw"}' } }] }, "tool_calls"), openAiDone] },
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
    assert.doesNotMatch(JSON.stringify(starterProvider.requests[0]?.body), /"name":"process"|ask_user|configure_raw|create_skill|create_tool|create_agent|add_mcp|create_package/);
    assert.match(JSON.stringify(starterProvider.requests[1]?.body), /configure-raw/);
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
    assert.match(saved.stderr, new RegExp(`raw --resume ${sessionId} "query"`));
    const resumed = await run(bin, ["--resume", sessionId, "installed followup"], consumer, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, "installed-session-second\n");
    assert.match(resumed.stderr, new RegExp(`raw --resume ${sessionId} "query"`));
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

    await writeFile(join(consumer, "consumer.ts"), 'import { ToolRegistry, listSessions, getSessionHistory, type AgentOptions, type CompactSettings, type UserInput, type ApiMethod, type SessionHistoryOptions, type VariableContext, createVariableResolver, loadVariableConfig } from "raw-cli";\nconst options: AgentOptions | undefined = undefined;\nconst compact: CompactSettings = { keepRecentTurns: 2, maxOutputTokens: 512 };\nconst input: UserInput = "hello";\nconst method: ApiMethod = "openai-responses";\nconst history: SessionHistoryOptions | undefined = undefined;\nconst names: string[] = new ToolRegistry().definitions().map(tool => tool.name);\nconst vars: VariableContext | undefined = undefined; void vars; void createVariableResolver; void loadVariableConfig; void options; void compact; void input; void method; void history; void names; void listSessions; void getSessionHistory;\n');
    const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--target", "esnext", "--module", "nodenext", "--moduleResolution", "nodenext",
      "--typeRoots", join(repo, "node_modules/@types"), "consumer.ts"], { cwd: consumer, encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  } finally { await fixture.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
