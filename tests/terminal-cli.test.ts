import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { testConfig } from "./fixtures/config.js";
import { terminalScreen } from "./fixtures/terminal-screen.js";

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

test("shared PTY shows header, tool activity and highlighted streamed code", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-terminal-cli-"));
  writeFileSync(join(cwd, "sample.ts"), "const answer = 42;\n");
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ files: [{ path: join(cwd, "sample.ts") }] }),
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
    assert.match(result.stdout, /↳ read_file/);
    assert.match(result.stdout, /✓ read_file/);
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

test("compact and verbose flags change successful tool detail on a shared terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-density-"));
  writeFileSync(join(root, "snippet.ts"), "const densityProbe = 7;\n");
  const call = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read", type: "function", function: {
    name: "read_file", arguments: JSON.stringify({ files: [{ path: join(root, "snippet.ts") }] }),
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

test("ASCII icons still distinguish read and success when color is disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-terminal-ascii-"));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "r", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ files: [{ path: join(root, "a.txt") }] }),
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
    assert.match(result.stdout, /\[read\] read_file/);
    assert.match(result.stdout, /\[ok\] read_file/);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
  } finally { await provider.close(); }
});
