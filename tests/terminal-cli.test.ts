import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { testConfig } from "./fixtures/config.js";
import { terminalScreen } from "./fixtures/terminal-screen.js";
import { posixOnly } from "./fixtures/platform.js";
import { cliConfig } from "./fixtures/cli-agent.js";
import { fakeClaudeEnv } from "./fixtures/fake-claude.js";

async function run(args: string[], env: NodeJS.ProcessEnv, pty: boolean) {
  const command = pty ? "python3" : process.execPath;
  const prefix = pty ? ["tests/fixtures/pty-bridge.py", process.execPath] : [];
  const child = spawn(command, [...prefix, "--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
    { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  if (!pty) child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

test("shared PTY shows header, tool activity and highlighted streamed code", { skip: posixOnly("pty") }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-terminal-cli-"));
  writeFileSync(join(cwd, "sample.ts"), "const answer = 42;\n");
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ path: join(cwd, "sample.ts") }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "# Found\n\n```ts\nconst " }), openAiFrame({ content: "answer = 42;\n```" }, "stop"), openAiDone] },
  ]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const env = { ...process.env, OPENAI_API_KEY: "key", TERM: "xterm-256color", NO_COLOR: "",
      XDG_STATE_HOME: join(cwd, "state"), XDG_CONFIG_HOME: join(cwd, "config"), RAW_TEST_PTY_COLUMNS: "80", RAW_TEST_PTY_ROWS: "24" };
    const result = await run(["--config", config, "--display", "normal", "find code"], env, true);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /◆ raw.*agent fixture/);
    assert.match(result.stdout, /↳ Read/);
    assert.match(result.stdout, /✓ ok/);
    assert.match(result.stdout, /Found/);
    assert.match(result.stdout, /\u001b\[(?:3[0-7]|9[0-7])mconst/);
    const visible = terminalScreen(result.stdout, 80).join("\n");
    assert.equal(visible.match(/Found/g)?.length, 1, visible);
    assert.equal(visible.match(/const answer = 42;/g)?.length, 2, visible);
    assert.equal(provider.requests.length, 2);
  } finally { await provider.close(); }
});

test("redirected stdout stays byte-exact assistant Markdown without terminal escapes", async () => {
  const provider = await startMockProvider([{ frames: [openAiFrame({ content: "# Title\n\n```js\nconst x = 1;\n```" }, "stop"), openAiDone] }]);
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-pipe-"));
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const result = await run(["--config", config, "--color", "always", "title"], {
      ...process.env, OPENAI_API_KEY: "key", TERM: "xterm", XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    }, false);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "# Title\n\n```js\nconst x = 1;\n```\n");
    assert.doesNotMatch(result.stdout + result.stderr, /\u001b\[/);
  } finally { await provider.close(); }
});

test("compact and verbose flags change successful tool detail on a shared terminal", { skip: posixOnly("pty") }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-density-"));
  writeFileSync(join(root, "snippet.ts"), "const densityProbe = 7;\n");
  const call = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read", type: "function", function: {
    name: "read_file", arguments: JSON.stringify({ path: join(root, "snippet.ts") }),
  } }] }, "tool_calls"), openAiDone] };
  const answer = { frames: [openAiFrame({ content: "Done" }, "stop"), openAiDone] };
  const provider = await startMockProvider([call, answer, call, answer]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const env = { ...process.env, OPENAI_API_KEY: "key", TERM: "xterm-256color", NO_COLOR: "",
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
    const compact = await run(["--config", config, "--display", "compact", "read once"], env, true);
    const verbose = await run(["--config", config, "--display", "verbose", "read again"], env, true);
    assert.equal(compact.code, 0, compact.stdout + compact.stderr);
    assert.equal(verbose.code, 0, verbose.stdout + verbose.stderr);
    assert.doesNotMatch(terminalScreen(compact.stdout, 80).join("\n"), /const densityProbe/);
    assert.match(terminalScreen(verbose.stdout, 80).join("\n"), /const densityProbe/);
    assert.equal(provider.requests.length, 4);
  } finally { await provider.close(); }
});

test("ASCII icons still distinguish read and success when color is disabled", { skip: posixOnly("pty") }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-ascii-"));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "r", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ path: join(root, "a.txt") }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Done" }, "stop"), openAiDone] },
  ]);
  try {
    const result = await run(["--config", testConfig("openai", "fixture", provider.url),
      "--color", "never", "--icons", "ascii", "read"], {
      ...process.env, OPENAI_API_KEY: "key", TERM: "xterm-256color", NO_COLOR: "1",
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    }, true);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[read\] Read/);
    assert.match(result.stdout, /\[ok\] ok/);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
  } finally { await provider.close(); }
});

test("changing only UI settings on resume preserves the OpenAI cache key and tool schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-resume-ui-"));
  const provider = await startMockProvider([
    { frames: [openAiFrame({ content: "first" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "second" }, "stop"), openAiDone] },
  ]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const env = { ...process.env, OPENAI_API_KEY: "key", XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
    const first = await run(["--config", config, "one"], env, false);
    assert.equal(first.code, 0, first.stderr);
    const id = first.stderr.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1];
    assert.ok(id);
    const document = JSON.parse(readFileSync(config, "utf8"));
    document.ui = { density: "verbose", color: "never", icons: "ascii" };
    writeFileSync(config, JSON.stringify(document));
    const next = await run(["--resume", id, "two"], env, false);
    assert.equal(next.code, 0, next.stderr);
    const before = provider.requests[0]?.body as { prompt_cache_key: string; tools: unknown; messages: Array<unknown> };
    const after = provider.requests[1]?.body as { prompt_cache_key: string; tools: unknown; messages: Array<unknown> };
    assert.ok(before.prompt_cache_key);
    assert.equal(after.prompt_cache_key, before.prompt_cache_key);
    assert.deepEqual(after.tools, before.tools);
    assert.deepEqual(after.messages[0], before.messages[0]);
    assert.match(next.stderr, new RegExp(`raw --resume ${id} "query"`));
  } finally { await provider.close(); }
});

test("compact shared-terminal header is one line and resume identifies the active session", { skip: posixOnly("pty") }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-header-"));
  const provider = await startMockProvider([
    { frames: [openAiFrame({ content: "first", "finish_reason": "stop" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "second", "finish_reason": "stop" }, "stop"), openAiDone] },
  ]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const env = { ...process.env, OPENAI_API_KEY: "key", TERM: "xterm-256color", NO_COLOR: "",
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
    const first = await run(["--config", config, "--display", "compact", "first"], env, true);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const firstPlain = first.stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    assert.match(firstPlain, /◆ raw · agent fixture · model fixture\r?\n/);
    assert.doesNotMatch(firstPlain, new RegExp(`${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\r?\n`));
    const id = firstPlain.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1];
    assert.ok(id);
    const second = await run(["--resume", id, "--display", "compact", "second"], env, true);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    const secondPlain = second.stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    assert.match(secondPlain, /◆ raw · agent fixture · model fixture · Resumed/);
    assert.equal(provider.requests.length, 2);
  } finally { await provider.close(); }
});

// cli-background-work Phase 5: the terminal runs the CLI's own turns, and a one-shot run waits for its background tasks.
async function backgroundRaw(fake: NodeJS.ProcessEnv, args: string[], options: { stdin?: string; keepStdin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-bg-"));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify(cliConfig({ default_agent: "ext", agents: { ext: { cli: { kind: "claude" }, tools: { use: [] } } } })));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), "--config", config, ...args], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...fakeClaudeEnv(root), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), NO_COLOR: "1", ...fake } });
  const run = { root, child, stdout: "", stderr: "", code: undefined as number | null | undefined, exitedAt: 0 };
  child.stdout.setEncoding("utf8").on("data", (part: string) => { run.stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { run.stderr += part; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code, signal) => { run.exitedAt = Date.now(); run.code = code ?? (signal ? 128 : null); resolve(run.code); }));
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  if (!options.keepStdin) child.stdin.end();
  const stops = () => { try { return readdirSync(join(root, "fake")).filter((name) => name.startsWith("calls-")).flatMap((name) =>
    readFileSync(join(root, "fake", name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>))
    .filter((call) => call.method === "_session/async_task/stop").map((call) => call.asyncTaskId); } catch { return []; } };
  return { run, exited, stops, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function until(check: () => boolean, what: string, ms = 20000): Promise<number> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
  return Date.now();
}
const WAITING = "raw: waiting for 1 background task(s) of Claude Code; Ctrl-C stops them\n";

test("background: a one-shot run waits for the task and prints Claude Code's own turn after the first answer", async () => {
  const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "300", FAKE_ACP_BG_TURN: "claude" }, ["bg"]);
  try {
    assert.equal(await exited, 0, run.stderr);
    assert.match(run.stdout, /started[\s\S]*Noted: Background job finished\./);
    assert.equal(run.stderr.split(WAITING).length - 1, 1, run.stderr);
  } finally { cleanup(); }
});

test("background: Ctrl-C while a one-shot run waits stops the task in the CLI and exits 130", { skip: posixOnly("signals") }, async () => {
  const { run, exited, stops, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "60000" }, ["bg"]);
  try {
    await until(() => run.stderr.includes(WAITING), "the waiting line");
    run.child.kill("SIGINT");
    assert.equal(await exited, 130, run.stderr);
    assert.match(run.stderr, /raw: stopped 1 background task\(s\)\n/);
    assert.deepEqual(stops(), ["task-1"]);
  } finally { cleanup(); }
});

test("background: a one-shot run without background work does not wait", async () => {
  const { run, exited, cleanup } = await backgroundRaw({}, ["hello"]);
  try {
    assert.equal(await exited, 0, run.stderr);
    assert.match(run.stdout, /echo:hello/);
    assert.doesNotMatch(run.stderr, /waiting for/);
  } finally { cleanup(); }
});

test("background: the REPL shows Claude Code's own turn without input, and /exit reports the tasks it stops", async (t) => {
  await t.test("a CLI turn while the REPL waits for a line", async () => {
    const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "300", FAKE_ACP_BG_TURN: "claude" }, [], { stdin: "bg\n", keepStdin: true });
    try {
      await until(() => run.stdout.includes("Noted: Background job finished."), "the CLI turn's answer");
      run.child.stdin.end();
      assert.equal(await exited, 0, run.stderr);
    } finally { cleanup(); }
  });
  await t.test("/exit with a running task", async () => {
    const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "60000" }, [], { stdin: "bg\n", keepStdin: true });
    try {
      await until(() => run.stdout.includes("started"), "the first answer");
      run.child.stdin.end("/exit\n");
      assert.equal(await exited, 0, run.stderr);
      assert.match(run.stderr, /raw: stopped 1 background task\(s\) of Claude Code: Background job\n/);
    } finally { cleanup(); }
  });
});

test("background: an adapter that exits while a one-shot run waits ends it with the lost tasks and exit 1", async () => {
  const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "60000", FAKE_ACP_EXIT_AFTER_BG: "1", FAKE_ACP_EXIT_AFTER_BG_MS: "800" }, ["bg"]);
  try {
    const waiting = await until(() => run.stderr.includes(WAITING), "the waiting line");
    assert.equal(await exited, 1, run.stderr);
    assert.match(run.stderr, /raw: Claude Code exited; 1 background task\(s\) were lost: Background job\n/);
    assert.ok(run.exitedAt - waiting < 1800, `${run.exitedAt - waiting} ms after the waiting line`);
  } finally { cleanup(); }
});

test("background: a one-shot run does not end in the gap before Claude Code's own turn", async () => {
  const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "200", FAKE_ACP_BG_TURN: "claude", FAKE_ACP_TURN_GAP_MS: "60" }, ["bg"]);
  try {
    assert.equal(await exited, 0, run.stderr);
    assert.match(run.stdout, /Noted: Background job finished\./);
  } finally { cleanup(); }
});

test("background: SIGTERM or SIGHUP while a one-shot run waits stops the task in the CLI and ends the run", { skip: posixOnly("signals") }, async (t) => {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) await t.test(signal, async () => {
    const { run, exited, stops, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "60000" }, ["bg"]);
    try {
      await until(() => run.stderr.includes(WAITING), "the waiting line");
      run.child.kill(signal);
      assert.equal(await exited, 130, run.stderr);
      assert.match(run.stderr, /raw: stopped 1 background task\(s\)\n/);
      assert.deepEqual(stops(), ["task-1"]);
    } finally { if (run.code === undefined) run.child.kill("SIGKILL"); cleanup(); }
  });
});

test("background: the REPL reports tasks an exited adapter lost and tasks /clear stops", async (t) => {
  await t.test("an adapter that exits while the REPL waits for a line", async () => {
    const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "60000", FAKE_ACP_EXIT_AFTER_BG: "1", FAKE_ACP_EXIT_AFTER_BG_MS: "300" }, [], { stdin: "bg\n", keepStdin: true });
    try {
      await until(() => run.stderr.includes("raw: Claude Code exited; 1 background task(s) were lost: Background job\n"), "the lost line");
      run.child.stdin.end("/exit\n");
      assert.equal(await exited, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /raw: stopped/);
    } finally { if (run.code === undefined) run.child.kill("SIGKILL"); cleanup(); }
  });
  await t.test("/clear with a running task", async () => {
    const { run, exited, cleanup } = await backgroundRaw({ FAKE_ACP_BG_MS: "60000" }, [], { stdin: "bg\n", keepStdin: true });
    try {
      await until(() => run.stdout.includes("started"), "the first answer");
      run.child.stdin.write("/clear\n");
      await until(() => run.stderr.includes("raw: conversation cleared\n"), "the clear");
      assert.match(run.stderr, /raw: stopped 1 background task\(s\) of Claude Code: Background job\nraw: conversation cleared\n/);
      run.child.stdin.end("/exit\n");
      assert.equal(await exited, 0, run.stderr);
    } finally { if (run.code === undefined) run.child.kill("SIGKILL"); cleanup(); }
  });
});
