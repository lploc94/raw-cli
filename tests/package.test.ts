import assert from "node:assert/strict";
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
  await writeFile(join(consumer, "package.json"), '{"name":"raw-consumer","private":true,"type":"module","devDependencies":{"@types/node":"24.10.1"}}\n');
  const install = spawnSync("npm", ["install", "--offline", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: consumer, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const bin = join(consumer, "node_modules", ".bin", "raw");
  await access(bin);
  const env = { ...process.env, OPENAI_API_KEY: "key" };
  assert.equal((await run(bin, ["--version"], consumer, env)).stdout.trim(), "0.1.0");
  assert.match((await run(bin, ["--help"], consumer, env)).stdout, /Usage: raw/);

  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
      name: "write_file", arguments: '{"path":"installed-sentinel.txt","content":"installed-write"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-task-done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "mcp", type: "function", function: {
      name: `mcp_pkg_selected_${createHash("sha256").update("pkg\0selected").digest("hex").slice(0, 12)}`,
      arguments: '{"value":"probe"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-mcp-done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "installed-acp-done" }, "stop"), openAiDone] },
  ]);
  try {
    const args = ["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "-y"];
    const task = await run(bin, [...args, "write sentinel"], consumer, env);
    assert.equal(task.code, 0, task.stderr);
    assert.equal(task.stdout, "installed-task-done\n");
    assert.equal(await readFile(join(consumer, "installed-sentinel.txt"), "utf8"), "installed-write");
    assert.match(JSON.stringify(fixture.requests[1]?.body), /installed-write/);

    await writeFile(join(consumer, "raw-mcp.json"), JSON.stringify({ mcpServers: { pkg: {
      command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(repo, "tests/fixtures/mcp-stdio.ts")],
      env: { MCP_LABEL: "pkg" }, tools: ["selected"],
    } } }));
    const mcp = await run(bin, [...args, "call MCP"], consumer, env);
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.equal(mcp.stdout, "installed-mcp-done\n");
    assert.match(JSON.stringify(fixture.requests[3]?.body), /pkg:selected:probe/);

    const parentScript = `import { createAcpClient, createToolRegistry } from "raw-cli";
const parent = await createAcpClient({ command: ${JSON.stringify(bin)}, args: ${JSON.stringify(["--acp", "--stdio", ...args])} });
try { const id = await parent.newSession(process.cwd()); const answer = await parent.prompt(id, "ACP installed");
if (answer.stopReason !== "end_turn" || createToolRegistry().definitions().length !== 3) process.exitCode = 1;
else process.stdout.write("installed-parent-ok\\n"); } finally { await parent.close(); }`;
    const parent = await run(process.execPath, ["--input-type=module", "--eval", parentScript], consumer, env);
    assert.equal(parent.code, 0, parent.stderr);
    assert.match(parent.stdout, /installed-parent-ok/);
    assert.match(JSON.stringify(fixture.requests[4]?.body), /ACP installed/);

    await writeFile(join(consumer, "consumer.ts"), 'import { createToolRegistry, type AgentOptions } from "raw-cli";\nconst options: AgentOptions | undefined = undefined;\nconst names: string[] = createToolRegistry().definitions().map(tool => tool.name);\nvoid options; void names;\n');
    const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--target", "esnext", "--module", "nodenext", "--moduleResolution", "nodenext",
      "--typeRoots", join(repo, "node_modules/@types"), "consumer.ts"], { cwd: consumer, encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  } finally { await fixture.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
