import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

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
      name: "write_file", arguments: '{"path":"sentinel.txt","content":"real-write"}',
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Changed sentinel" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await raw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "-y", "write sentinel"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Changed sentinel\n");
    assert.equal(await readFile(join(root, "sentinel.txt"), "utf8"), "real-write");
    assert.match(JSON.stringify(fixture.requests[1]?.body), /real-write/);
  } finally { await fixture.close(); }
});

test("T-08a/b: non-TTY approval fails before side effect; -y executes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-approval-"));
  const response = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "edit", type: "function", function: {
    name: "write_file", arguments: '{"path":"nope.txt","content":"created"}',
  } }] }, "tool_calls"), openAiDone] };
  const fixture = await startMockProvider([response]);
  try {
    const result = await raw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "write file"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /approval/i);
    await assert.rejects(access(join(root, "nope.txt")));
  } finally { await fixture.close(); }
});

test("T-08 review: non-TTY REPL exits 2 on first tool needing approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-repl-approval-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
    name: "write_file", arguments: '{"path":"denied.txt","content":"never"}',
  } }] }, "tool_calls"), openAiDone] }]);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "--interactive"],
  { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdout.resume();
  try {
    child.stdin.write("write denied\n");
    const code = await Promise.race([new Promise<number | null>((resolve) => child.once("exit", resolve)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("REPL did not exit after approval failure")), 3000))]);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /approval required/i);
    await assert.rejects(access(join(root, "denied.txt")));
  } finally { child.kill("SIGKILL"); await fixture.close(); }
});

test("T-08 review: SIGINT during MCP startup reaps owned stdio child", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-startup-cancel-"));
  const pidFile = join(root, "mcp.pid");
  const started = join(root, "mcp-started");
  await writeFile(join(root, "raw-mcp.json"), JSON.stringify({ mcpServers: { delayed: {
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/mcp-stdio.ts")],
    env: { MCP_PID_FILE: pidFile, MCP_LIST_STARTED_FILE: started, MCP_LIST_DELAY_MS: "1200" }, tools: [],
  } } }));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--provider", "ollama", "--model", "fixture", "-y", "task"],
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

test("T-08b: real PTY approval allows a write; denial prevents the side effect", async () => {
  for (const choice of ["y", "n"] as const) {
    const root = await mkdtemp(join(tmpdir(), `raw-cli-pty-${choice}-`));
    const fixture = await startMockProvider([
      { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: join(root, "marker"), content: "ok" }),
      } }] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "handled" }, "stop"), openAiDone] },
    ]);
    const { child, output } = ptyRaw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "write marker"],
      { ...process.env, OPENAI_API_KEY: "key" });
    try {
      await waitFor(output, "allow write_file");
      child.stdin.write(`${choice}\n`);
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      assert.equal(code, 0, output());
      if (choice === "y") assert.equal(await readFile(join(root, "marker"), "utf8"), "ok");
      else {
        await assert.rejects(access(join(root, "marker")));
        assert.match(JSON.stringify(fixture.requests[1]?.body), /approval denied/);
      }
    } finally { child.kill("SIGTERM"); await fixture.close(); }
  }
});

test("T-08 review: queued REPL command is retained while a later approval answer is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-pty-queued-approval-"));
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "write", type: "function", function: {
      name: "write_file", arguments: JSON.stringify({ path: join(root, "marker"), content: "never" }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "denial handled" }, "stop"), openAiDone] },
  ]);
  const { child, output } = ptyRaw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "--interactive"],
    { ...process.env, OPENAI_API_KEY: "key" });
  try {
    await waitFor(output, "> ");
    child.stdin.write("run write\n/exit\n");
    await waitFor(output, "allow write_file");
    child.stdin.write("n\n");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
    assert.match(output(), /denial handled/);
    await assert.rejects(access(join(root, "marker")));
    assert.match(JSON.stringify(fixture.requests[1]?.body), /approval denied/);
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08b: Ctrl-C during an active PTY tool aborts it and exits 130", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-pty-cancel-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
    name: "bash", arguments: JSON.stringify({ command: `sleep 0.5; printf late > ${join(root, "marker")}` }),
  } }] }, "tool_calls"), openAiDone] }]);
  const { child, output } = ptyRaw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "-y", "run shell"],
    { ...process.env, OPENAI_API_KEY: "key" });
  try {
    await waitFor(output, "raw: bash");
    child.stdin.write("\x03");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 130, output());
    await new Promise((resolve) => setTimeout(resolve, 650));
    await assert.rejects(access(join(root, "marker")));
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08b: REPL Ctrl-C aborts active work, then Ctrl-C while idle exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-repl-cancel-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
    name: "bash", arguments: JSON.stringify({ command: `sleep 0.5; printf late > ${join(root, "marker")}` }),
  } }] }, "tool_calls"), openAiDone] }]);
  const { child, output } = ptyRaw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "--interactive", "-y"],
    { ...process.env, OPENAI_API_KEY: "key" });
  try {
    await waitFor(output, "> ");
    const firstPrompt = output().lastIndexOf("> ");
    child.stdin.write("run shell\n");
    await waitFor(output, "raw: bash");
    child.stdin.write("\x03");
    await waitFor(output, "raw: cancelled");
    const until = Date.now() + 3000;
    while (output().lastIndexOf("> ") <= firstPrompt) {
      if (Date.now() > until) throw new Error(`REPL did not return to prompt: ${output()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.stdin.write("\x03");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 130, output());
    await new Promise((resolve) => setTimeout(resolve, 650));
    await assert.rejects(access(join(root, "marker")));
  } finally { child.kill("SIGTERM"); await fixture.close(); }
});

test("T-08b: EOF during an active piped REPL turn aborts owned Bash", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-repl-eof-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "shell", type: "function", function: {
    name: "bash", arguments: JSON.stringify({ command: `sleep 0.5; printf late > ${join(root, "marker")}` }),
  } }] }, "tool_calls"), openAiDone] }]);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--provider", "openai", "--model", "fixture", "--base-url", fixture.url, "--interactive", "-y"],
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
  const { child, output } = ptyRaw(["--provider", "ollama", "--model", "fixture", "--interactive"], process.env);
  try {
    await waitFor(output, "> ");
    child.stdin.write("\x04");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output());
  } finally { child.kill("SIGTERM"); }
});

test("T-08a: profile selection and -- task delimiter reach the chosen model", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-profile-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ content: "profile-answer" }, "stop"), openAiDone] }]);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ default_profile: "local", profiles: {
    local: { provider: "ollama", model: "unused", base_url: "http://127.0.0.1:9/v1" },
    selected: { provider: "openai", model: "fixture", base_url: fixture.url },
  } }));
  try {
    const result = await raw(["--config", config, "--profile", "selected", "--", "-leading task"],
      { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "profile-answer\n");
    assert.match(JSON.stringify(fixture.requests[0]?.body), /-leading task/);
  } finally { await fixture.close(); }
});

test("T-08a: max steps, provider error and invalid arguments use distinct exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-cli-exit-"));
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "edit", type: "function", function: {
    name: "write_file", arguments: '{"path":"never.txt","content":"no"}',
  } }] }, "tool_calls"), openAiDone] }]);
  try {
    const max = await raw(["--provider", "openai", "--model", "fixture", "--base-url", fixture.url,
      "--max-steps", "1", "-y", "write"], { cwd: root, env: { ...process.env, OPENAI_API_KEY: "key" } });
    assert.equal(max.code, 3, max.stderr);
    await assert.rejects(access(join(root, "never.txt")));
  } finally { await fixture.close(); }
  const secret = "credential-sentinel";
  const failed = await startMockProvider([{ status: 401, body: { error: { message: `bad ${secret}` } } }]);
  try {
    const error = await raw(["--provider", "openai", "--model", "fixture", "--base-url", failed.url, "hello"],
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
  const config = join(root, "raw-mcp.json");
  await writeFile(config, "{");
  const malformed = await raw(["--provider", "ollama", "--model", "fixture", "-y", "task"], { cwd: root });
  assert.equal(malformed.code, 2, malformed.stderr);
  await writeFile(config, JSON.stringify({ mcpServers: { bad: { command: "node", url: "http://127.0.0.1:1" } } }));
  const invalid = await raw(["--provider", "ollama", "--model", "fixture", "-y", "task"], { cwd: root });
  assert.equal(invalid.code, 2, invalid.stderr);
  await writeFile(config, JSON.stringify({ mcpServers: { unreachable: { command: "raw-missing-mcp-command", tools: [] } } }));
  const connection = await raw(["--provider", "ollama", "--model", "fixture", "-y", "task"], { cwd: root });
  assert.equal(connection.code, 1, connection.stderr);
});
