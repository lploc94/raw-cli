import assert from "node:assert/strict";
import { testConfig } from "./fixtures/config.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), OPENAI_API_KEY: "key" };
  assert.equal((await run(bin, ["--version"], consumer, env)).stdout.trim(), "0.1.0");
  assert.match((await run(bin, ["--help"], consumer, env)).stdout, /Usage: raw/);

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
    document.profiles.fixture.mcp = { pkg: ["selected"] };
    await writeFile(configPath, JSON.stringify(document));
    const mcp = await run(bin, [...args, "call MCP"], consumer, env);
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.equal(mcp.stdout, "installed-mcp-done\n");
    assert.match(JSON.stringify(fixture.requests[3]?.body), /pkg:selected:probe/);

    document.models.fixture.vision = true;
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
    const resumed = await run(bin, ["--resume", sessionId, "installed followup"], consumer, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, "installed-session-second\n");
    assert.match(JSON.stringify(fixture.requests[7]?.body), /installed-session-first/);
    const shown = await run(bin, ["sessions", "show", sessionId], consumer, env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /installed-session-first/);
    const stats = await run(bin, ["sessions", "stats"], consumer, env);
    assert.equal(stats.code, 0, stats.stderr);
    assert.ok((JSON.parse(stats.stdout) as { databaseBytes: number }).databaseBytes > 0);

    const parentScript = `import { createAcpClient, createToolRegistry } from "raw-cli";
const options = { command: ${JSON.stringify(bin)}, args: ${JSON.stringify(["--acp", "--stdio", ...args])} };
let id;
const first = await createAcpClient(options);
try { id = await first.newSession(process.cwd()); const answer = await first.prompt(id, "ACP installed");
if (answer.stopReason !== "end_turn" || createToolRegistry().definitions().length !== 3) throw new Error("initial ACP failed");
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

    await writeFile(join(consumer, "consumer.ts"), 'import { createToolRegistry, listSessions, getSessionHistory, type AgentOptions, type CompactSettings, type UserInput, type ApiMethod, type SessionHistoryOptions } from "raw-cli";\nconst options: AgentOptions | undefined = undefined;\nconst compact: CompactSettings = { keepRecentTurns: 2, maxOutputTokens: 512 };\nconst input: UserInput = "hello";\nconst method: ApiMethod = "openai-responses";\nconst history: SessionHistoryOptions | undefined = undefined;\nconst names: string[] = createToolRegistry().definitions().map(tool => tool.name);\nvoid options; void compact; void input; void method; void history; void names; void listSessions; void getSessionHistory;\n');
    const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--target", "esnext", "--module", "nodenext", "--moduleResolution", "nodenext",
      "--typeRoots", join(repo, "node_modules/@types"), "consumer.ts"], { cwd: consumer, encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  } finally { await fixture.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
