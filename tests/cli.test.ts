import assert from "node:assert/strict";
import { testConfig } from "./fixtures/config.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "raw-cli-test-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "raw-cli-test-state-"));

async function raw(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args], {
    cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdin.end(options.input ?? "");
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

function ptyRaw(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn("python3", ["tests/fixtures/pty-bridge.py", process.execPath, "--import", import.meta.resolve("tsx"),
    join(process.cwd(), "bin/raw.ts"), ...args], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { output += part; });
  return { child, output: () => output };
}

async function waitFor(read: () => string, token: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!read().includes(token)) {
    if (Date.now() > until) throw new Error(`missing ${token}: ${read().slice(-500)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("T-08a: one-shot streams once and a real write result reaches follow-up inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-task-"));
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "edit", type: "function", function: {
      name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"sentinel.txt","content":"real-write"}]}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Changed sentinel" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await raw(["--config", testConfig("openai", "fixture", fixture.url), "write sentinel"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Changed sentinel\n");
    assert.match(result.stderr, /raw: write_file \{"operations":\[\{"path":"sentinel.txt","mode":"overwrite","content_bytes":10\}\]\}/);
    assert.doesNotMatch(result.stderr, /real-write/);
    assert.equal(await readFile(join(root, "sentinel.txt"), "utf8"), "real-write");
    assert.match(JSON.stringify(fixture.requests[1]?.body), /real-write/);
  } finally { await fixture.close(); }
});

test("CLI streams provider thinking to stderr and shows bash arguments before execution", async () => {
  const fixture = await startMockProvider([
    { frames: [
      openAiFrame({ reasoning: "Inspect " }),
      openAiFrame({ reasoning: "files." }),
      openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
        name: "bash", arguments: JSON.stringify({ commands: [{ command: "printf sample", timeout_ms: 1000 }] }),
      } }] }, "tool_calls"), openAiDone,
    ] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await raw(["--config", testConfig("local", "fixture", fixture.url), "run a command"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "done\n");
    assert.match(result.stderr, /raw: thinking\nInspect files\.\n/);
    assert.match(result.stderr, /raw: bash \{"commands":\[\{"command":"printf sample","timeout_ms":1000\}\]\}/);
    assert.match(result.stderr, /raw: ↳ bash result\nstatuses: 0:ok\(exit0\)\n\{"index":0,"status":"ok","exit_code":0/);
    assert.match(result.stderr, /"stdout":"sample"/);
    assert.doesNotMatch(result.stderr, /\x1b\[/);
    assert.doesNotMatch(result.stderr, /allow bash|\[y\/N\]/i);
    assert.match(JSON.stringify(fixture.requests[1]?.body), /sample/);
  } finally { await fixture.close(); }
});

test("CLI shows rejected bash arguments and the model receives the expected batch shape", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "bad-shell", type: "function", function: {
      name: "bash", arguments: '{"command":"pwd"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "good-shell", type: "function", function: {
      name: "bash", arguments: '{"commands":[{"command":"pwd"}]}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await raw(["--config", testConfig("local", "fixture", fixture.url), "inspect"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /raw: ⚠ bash \{"command":"pwd"\}/);
    assert.match(result.stderr, /unknown bash property "command"; use \{"commands":\[\{"command":"\.\.\."\}\]\}/);
    assert.match(result.stderr, /raw: bash \{"commands":\[\{"command":"pwd"\}\]\}/);
    assert.equal((result.stderr.match(/raw: ⚠ bash/g) ?? []).length, 1);
    assert.match(JSON.stringify(fixture.requests[1]?.body), /unknown bash property/);
  } finally { await fixture.close(); }
});

test("CLI shows rejected write argument keys without printing the payload", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "bad-write", type: "function", function: {
      name: "write_file", arguments: '{"path":"sentinel.txt","content":"private-payload"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await raw(["--config", testConfig("local", "fixture", fixture.url), "inspect"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /raw: ⚠ write_file \{"argument_keys":\["path","content"\]\}/);
    assert.doesNotMatch(result.stderr, /private-payload/);
    assert.match(result.stderr, /unknown write_file property "path"/);
  } finally { await fixture.close(); }
});

test("TTY starts tool activity on a new line after unfinished assistant text", async () => {
  const fixture = await startMockProvider([
    { frames: [
      openAiFrame({ content: "I will inspect the repo." }),
      openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
        name: "bash", arguments: JSON.stringify({ commands: [{ command: "pwd" }] }),
      } }] }, "tool_calls"), openAiDone,
    ] },
    { frames: [openAiFrame({ content: "Done." }, "stop"), openAiDone] },
  ]);
  const { child, output } = ptyRaw(["--config", testConfig("local", "fixture", fixture.url), "inspect"],
    { ...process.env, NO_COLOR: "1" });
  try {
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
    assert.match(output().replace(/\r/g, ""), /I will inspect the repo\.\nraw: bash \{"commands":\[\{"command":"pwd"\}\]\}\nraw: ↳ bash result\n/);
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("tool result preview retains statuses and bounds body to 2000 characters and 9 lines", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
      name: "bash", arguments: JSON.stringify({ commands: [{ command:
        "printf 'HEAD\\n'; for i in {1..20}; do printf 'line-%02d\\n' \"$i\"; done; printf '%03000d\\nTAIL\\n' 0" }] }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Done" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await raw(["--config", testConfig("local", "fixture", fixture.url), "inspect"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Done\n");
    const start = result.stderr.indexOf("raw: ↳ bash result");
    assert.ok(start >= 0);
    const lines = result.stderr.slice(start).split(/\nraw: (?:session usage:|context:|continue:)/, 1)[0]!.trimEnd().split("\n");
    assert.ok(lines.length <= 11, `preview used ${lines.length} lines including status summary`);
    assert.match(lines[1]!, /^statuses:/);
    const preview = lines.slice(2).join("\n");
    assert.ok(lines.length - 2 <= 9);
    assert.ok(Array.from(preview).length <= 2000);
    assert.match(preview, /HEAD/);
    assert.match(preview, /TAIL/);
    assert.match(preview, /hidden/);
    assert.ok(JSON.stringify(fixture.requests[1]?.body).includes("0".repeat(3000)), "full output must reach the model");
  } finally { await fixture.close(); }
});

test("TTY renders thinking in dim color while keeping the answer separate", async () => {
  const fixture = await startMockProvider([{ frames: [
    openAiFrame({ reasoning_content: "Checking context." }),
    openAiFrame({ content: "ready" }, "stop"), openAiDone,
  ] }]);
  const { child, output } = ptyRaw(["--config", testConfig("deepseek", "fixture", fixture.url), "check"],
    { ...process.env, DEEPSEEK_API_KEY: "key", NO_COLOR: "", TERM: "xterm-256color" });
  try {
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
    assert.match(output(), /raw: \x1b\[2mthinking\x1b\[0m/);
    assert.match(output(), /\x1b\[2mChecking context\.\x1b\[0m/);
    assert.match(output(), /ready/);
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08a/b: non-TTY tool call executes without an approval flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-auto-tool-"));
  const response = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "edit", type: "function", function: {
    name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"nope.txt","content":"created"}]}',
  } }] }, "tool_calls"), openAiDone] };
  const fixture = await startMockProvider([response, { frames: [openAiFrame({ content: "completed" }, "stop"), openAiDone] }]);
  try {
    const result = await raw(["--config", testConfig("openai", "fixture", fixture.url), "write file"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "completed\n");
    assert.equal(await readFile(join(root, "nope.txt"), "utf8"), "created");
    assert.doesNotMatch(result.stderr, /approval|allow .+\?/i);
  } finally { await fixture.close(); }
});

test("explicit agent ask fails closed in headless mode even with -y", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-ask-headless-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function",
    function: { name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"blocked.txt","content":"no"}]}' } }] }, "tool_calls"), openAiDone] }]);
  try {
    const configPath = testConfig("openai", "fixture", fixture.url);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    document.agents.fixture.tools = { ...document.agents.fixture.tools, rules: [{ match: "builtin/write_file", effect: "ask" }] };
    await writeFile(configPath, JSON.stringify(document));
    const result = await raw(["--config", configPath, "-y", "write"], { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /approval required/);
    await assert.rejects(access(join(root, "blocked.txt")));
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test("conditional Bash ask leaves safe headless commands automatic and gates rm with -y", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-conditional-"));
  const marker = join(root, "protected.txt");
  await writeFile(marker, "keep");
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "safe", type: "function", function: {
      name: "bash", arguments: '{"commands":[{"command":"printf safe"}]}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "safe done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "danger", type: "function", function: {
      name: "bash", arguments: '{"commands":[{"command":"rm -f protected.txt"}]}' } }] }, "tool_calls"), openAiDone] },
  ]);
  try {
    const configPath = testConfig("openai", "fixture", fixture.url);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    document.agents.fixture.tools.rules = [{ match: "builtin/bash", effect: "ask",
      when: { any: "commands[*].command", regex: String.raw`(^|[;&|()\n])\s*(sudo\s+)?(/usr/bin/|/bin/)?rm(\s|$)` } }];
    await writeFile(configPath, JSON.stringify(document));
    const env = { ...process.env, OPENAI_API_KEY: "key" };
    const safe = await raw(["--config", configPath, "-y", "safe"], { cwd: root, env });
    assert.equal(safe.code, 0, safe.stderr);
    assert.doesNotMatch(safe.stderr, /approval required/);
    const danger = await raw(["--config", configPath, "-y", "danger"], { cwd: root, env });
    assert.equal(danger.code, 2, danger.stderr);
    assert.match(danger.stderr, /approval required/);
    assert.equal(await readFile(marker, "utf8"), "keep");
  } finally { await fixture.close(); }
});

test("explicit agent ask prompts once in a TTY and -y does not bypass it", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-ask-tty-"));
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ operations: [
        { mode: "overwrite", path: join(root, "allowed.txt"), content: "secret-first-payload" },
        { mode: "append", path: join(root, "also-allowed.txt"), content: "secret-second-payload" },
      ] }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  const configPath = testConfig("openai", "fixture", fixture.url);
  const document = JSON.parse(await readFile(configPath, "utf8"));
  document.agents.fixture.tools = { ...document.agents.fixture.tools, rules: [{ match: "builtin/write_file", effect: "ask" }] };
  await writeFile(configPath, JSON.stringify(document));
  const { child, output } = ptyRaw(["--config", configPath, "-y", "write"], { ...process.env, OPENAI_API_KEY: "key" });
  try {
    await waitFor(output, "allow write_file");
    await assert.rejects(access(join(root, "allowed.txt")));
    assert.match(output(), /allowed\.txt/);
    assert.match(output(), /also-allowed\.txt/);
    assert.doesNotMatch(output(), /secret-first-payload|secret-second-payload/);
    child.stdin.write("y\n");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
    assert.equal(await readFile(join(root, "allowed.txt"), "utf8"), "secret-first-payload");
    assert.equal(await readFile(join(root, "also-allowed.txt"), "utf8"), "secret-second-payload");
    assert.doesNotMatch(output(), /secret-first-payload|secret-second-payload/);
    assert.equal((output().match(/allow write_file/g) ?? []).length, 1);
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08 review: piped REPL executes a tool without approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-repl-auto-tool-"));
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
      name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"written.txt","content":"created"}]}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "completed" }, "stop"), openAiDone] },
  ]);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--config", testConfig("openai", "fixture", fixture.url), "--interactive"],
  { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  try {
    child.stdin.write("write file\n");
    await waitFor(() => stdout, "completed");
    child.stdin.write("/exit\n");
    const code = await Promise.race([new Promise<number | null>((resolve) => child.once("exit", resolve)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("REPL did not exit")), 3000))]);
    assert.equal(code, 0, stderr);
    assert.equal(await readFile(join(root, "written.txt"), "utf8"), "created");
    assert.doesNotMatch(stderr, /approval|allow .+\?/i);
  } finally { child.kill("SIGKILL"); await fixture.close(); }
});

test("T-08 review: SIGINT during MCP startup reaps owned stdio child", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-startup-cancel-"));
  const pidFile = join(root, "mcp.pid");
  const started = join(root, "mcp-started");
  const configPath = testConfig("ollama");
  const document = JSON.parse(await readFile(configPath, "utf8"));
  document.mcp = { servers: { delayed: { transport: "stdio", command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/mcp-stdio.ts")],
    env: { MCP_PID_FILE: pidFile, MCP_LIST_STARTED_FILE: started, MCP_LIST_DELAY_MS: "1200" } } } };
  document.agents.fixture.tools.use.push("mcp/delayed/selected");
  await writeFile(configPath, JSON.stringify(document));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--config", configPath, "-y", "task"],
  { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  child.stdout.resume(); child.stderr.resume();
  let mcpPid = 0;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(started); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    await access(started);
    mcpPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(mcpPid > 0);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 130);
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(mcpPid, 0); } catch { return; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("MCP child survived startup cancellation");
  } finally { child.kill("SIGKILL"); if (mcpPid) { try { process.kill(mcpPid, "SIGKILL"); } catch { /* already reaped */ } } }
});

test("T-08b: real PTY executes a write without a permission prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-pty-auto-"));
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
      name: "write_file", arguments: JSON.stringify({ operations: [{ mode: "overwrite", path: join(root, "marker"), content: "ok" }] }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "handled" }, "stop"), openAiDone] },
  ]);
  const { child, output } = ptyRaw(["--config", testConfig("openai", "fixture", fixture.url), "write marker"],
    { ...process.env, OPENAI_API_KEY: "key" });
  try {
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
    assert.equal(await readFile(join(root, "marker"), "utf8"), "ok");
    assert.doesNotMatch(output(), /allow write_file|\[y\/N\]/i);
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08 review: queued REPL command follows an automatic tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-pty-queued-tool-"));
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
      name: "write_file", arguments: JSON.stringify({ operations: [{ mode: "overwrite", path: join(root, "marker"), content: "written" }] }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "write handled" }, "stop"), openAiDone] },
  ]);
  const { child, output } = ptyRaw(["--config", testConfig("openai", "fixture", fixture.url), "--interactive"],
    { ...process.env, OPENAI_API_KEY: "key" });
  try {
    await waitFor(output, "> ");
    child.stdin.write("run write\n/exit\n");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
    assert.match(output(), /write handled/);
    assert.equal(await readFile(join(root, "marker"), "utf8"), "written");
    assert.doesNotMatch(output(), /allow write_file|\[y\/N\]/i);
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08b: Ctrl-C during an active PTY tool aborts it and exits 130", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-pty-cancel-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
    name: "bash", arguments: JSON.stringify({ commands: [{ command: `sleep 0.5; printf late > ${join(root, "marker")}` }] }),
  } }] }, "tool_calls"), openAiDone] }]);
  const { child, output } = ptyRaw(["--config", testConfig("openai", "fixture", fixture.url), "-y", "run shell"],
    { ...process.env, OPENAI_API_KEY: "key", NO_COLOR: "", TERM: "xterm-256color" });
  try {
    await waitFor(output, "⚙ bash");
    child.stdin.write("\x03");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 130, output());
    assert.match(output(), /\x1b\[1;36m⚙ bash\x1b\[0m/);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await assert.rejects(access(join(root, "marker")));
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08b: REPL Ctrl-C aborts active work, then Ctrl-C while idle exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-repl-cancel-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
    name: "bash", arguments: JSON.stringify({ commands: [{ command: `sleep 1.5; printf late > ${join(root, "marker")}` }] }),
  } }] }, "tool_calls"), openAiDone] }]);
  const { child, output } = ptyRaw(["--config", testConfig("openai", "fixture", fixture.url), "--interactive", "-y"],
    { ...process.env, OPENAI_API_KEY: "key" });
  try {
    await waitFor(output, "> ");
    child.stdin.write("run shell\n");
    await waitFor(output, join(root, "marker"));
    child.stdin.write("\x03");
    await waitFor(output, "raw: cancelled");
    const until = Date.now() + 3000;
    while (output().lastIndexOf("\n> ") <= output().indexOf("raw: cancelled")) {
      if (Date.now() > until) throw new Error(`REPL did not return to prompt: ${output()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.stdin.write("\x03");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 130, output());
    await new Promise((resolve) => setTimeout(resolve, 1650));
    await assert.rejects(access(join(root, "marker")));
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08b: EOF during an active piped REPL turn aborts owned Bash", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-repl-eof-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
    name: "bash", arguments: JSON.stringify({ commands: [{ command: `sleep 0.5; printf late > ${join(root, "marker")}` }] }),
  } }] }, "tool_calls"), openAiDone] }]);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--config", testConfig("openai", "fixture", fixture.url), "--interactive", "-y"],
  { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdout.resume();
  try {
    child.stdin.write("run shell\n");
    await waitFor(() => stderr, "raw: bash");
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await assert.rejects(access(join(root, "marker")));
  } finally { child.kill("SIGKILL"); await fixture.close(); }
});

test("T-08b: idle PTY EOF closes REPL cleanly", async () => {
  const { child, output } = ptyRaw(["--config", testConfig("ollama"), "--interactive"], process.env);
  try {
    await waitFor(output, "> ");
    child.stdin.write("\x04");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
  } finally { child.kill("SIGTERM"); }
});

test("T-08a: agent selection and -- task delimiter reach the chosen model", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-agent-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ content: "agent-answer" }, "stop"), openAiDone] }]);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ default_agent: "local", models: {
    local: { provider: "ollama", method: "openai-chat-completions", model_id: "unused", base_url: "http://127.0.0.1:9/v1" },
    selected: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: fixture.url },
  }, agents: { local: { model: "local", tools: { use: [] } }, selected: { model: "selected", tools: { use: [] } } } }));
  try {
    const result = await raw(["--config", config, "--agent", "selected", "--", "-leading task"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "agent-answer\n");
    assert.match(JSON.stringify(fixture.requests[0]?.body), /-leading task/);
  } finally { await fixture.close(); }
});

test("T-08a: max steps, provider error and invalid arguments use distinct exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-exit-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "edit", type: "function", function: {
    name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"never.txt","content":"no"}]}',
  } }] }, "tool_calls"), openAiDone] }]);
  try {
    const max = await raw(["--config", testConfig("openai", "fixture", fixture.url),
      "--max-steps", "1", "-y", "write"], { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(max.code, 3, max.stderr);
    await assert.rejects(access(join(root, "never.txt")));
  } finally { await fixture.close(); }
  const secret = "credential-sentinel";
  const failed = await startMockProvider([{ status: 401, body: { error: { message: `bad ${secret}` } } }]);
  try {
    const error = await raw(["--config", testConfig("openai", "fixture", failed.url), "hello"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: secret } });
    assert.equal(error.code, 1);
    assert.doesNotMatch(error.stderr, new RegExp(secret));
  } finally { await failed.close(); }
  const invalid = await raw(["--no-such-flag"], { cwd: root });
  assert.equal(invalid.code, 2);
  for (const args of [["--interactive", "task"], ["first", "second"], ["--provider"], ["--acp", "task"], ["--ws"],
    ["--model", "one", "--model", "two"], ["--provider", "unsupported", "--model", "fixture", "task"],
    ["--provider", "openai-compatible", "--model", "fixture", "task"]]) {
    const syntax = await raw(args, { cwd: root });
    assert.equal(syntax.code, 2, `${args.join(" ")}: ${syntax.stderr}`);
  }
});

test("T-08 review: malformed MCP config exits 2 while unreachable server exits 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-mcp-errors-"));
  const config = testConfig("ollama");
  const base = JSON.parse(await readFile(config, "utf8"));
  await writeFile(config, "{");
  const malformed = await raw(["--config", config, "-y", "task"], { cwd: root });
  assert.equal(malformed.code, 2, malformed.stderr);
  await writeFile(config, JSON.stringify({ ...base, mcp: { servers: { bad: { transport: "stdio", command: "node", url: "http://127.0.0.1:1" } } },
    agents: { fixture: { model: "fixture", tools: { use: ["mcp/bad/echo"] } } } }));
  const invalid = await raw(["--config", config, "-y", "task"], { cwd: root });
  assert.equal(invalid.code, 2, invalid.stderr);
  await writeFile(config, JSON.stringify({ ...base, mcp: { servers: { unreachable: { transport: "stdio", command: "raw-missing-mcp-command" } } },
    agents: { fixture: { model: "fixture", tools: { use: ["mcp/unreachable/echo"] } } } }));
  const connection = await raw(["--config", config, "-y", "task"], { cwd: root });
  assert.equal(connection.code, 1, connection.stderr);
});
