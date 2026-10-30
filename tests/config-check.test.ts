import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installPackage, linkPackage } from "../src/packages/store.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { posixOnly } from "./fixtures/platform.js";

/** A sandbox: the active config is the canonical `$XDG_CONFIG_HOME/raw/config.json`; data, state and temp are private. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "raw-config-check-"));
  const dirs = { config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), tmp: join(root, "tmp"),
    bin: join(root, "bin"), work: join(root, "work") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(dirs.config, "raw"));
  const active = join(dirs.config, "raw", "config.json");
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state,
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, PATH: dirs.bin, HOME: root, NO_COLOR: "1" };
  return { root, dirs, active, env };
}

async function raw(args: string[], env: NodeJS.ProcessEnv, input = "", cwd = process.cwd()) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

const API_MODEL = { provider: "custom", method: "openai-chat-completions", model_id: "m", base_url: "http://127.0.0.1:9/v1", api_key: "k" };
const write = (path: string, data: unknown) => writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
const lines = (stdout: string) => stdout.trimEnd().split("\n");

test("config check reports every agent with its model, a CLI agent's skipped settings and missing CLI as warnings", async () => {
  const box = sandbox();
  write(box.active, { default_agent: "api", models: { local: API_MODEL, opus: { method: "claude-code-cli", model_id: "opus" },
    keyless: { provider: "openai", method: "openai-responses", model_id: "gpt" } },
  agents: { api: { model: "local", tools: { use: [] } }, claude: { model: "opus", tools: { use: [] }, request: { reasoning_effort: "high", max_output_tokens: 10 } },
    nokey: { model: "keyless", tools: { use: [] } } } });
  const result = await raw(["config", "check"], box.env);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const out = lines(result.stdout);
  assert.match(out[0]!, /^ok +api +local \(openai-chat-completions\)$/);
  assert.match(out[1]!, /^ok +claude +opus \(claude-code-cli\)$/);
  assert.ok(out.some((line) => /^ +warning: .*request\.max_output_tokens/.test(line)), result.stdout);
  assert.ok(out.some((line) => /^ +warning: Claude Code is not installed \(looked for claude on PATH\)$/.test(line)), result.stdout);
  assert.ok(out.some((line) => /^ok +nokey +keyless \(openai-responses\)$/.test(line)), result.stdout);
  assert.ok(out.some((line) => /^ +warning: .*OPENAI_API_KEY/.test(line)), result.stdout);
  assert.match(out.at(-1)!, /^3 agents, 0 errors, 3 warnings$/);
  // The key in the environment silences the credential warning; an installed CLI silences the missing-CLI one.
  const installed = join(box.dirs.bin, "claude");
  write(installed, "#!/bin/sh\nexit 0\n"); chmodSync(installed, 0o755);
  const quiet = await raw(["config", "check"], { ...box.env, OPENAI_API_KEY: "set" });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(lines(quiet.stdout).at(-1)!, process.platform === "win32" ? /^3 agents, 0 errors, [12] warnings$/ : /^3 agents, 0 errors, 1 warnings$/);
});

test("config check isolates a broken agent: it errors, the others stay ok, exit 1", async () => {
  const box = sandbox();
  write(box.active, { default_agent: "good", models: { local: API_MODEL, terra: { method: "codex-cli" } },
    agents: { good: { model: "local", tools: { use: [] } }, bad: { model: "local", tools: { use: [] }, colour: "red" }, ghost: { model: "nope", tools: { use: [] } },
      codex: { model: "terra", tools: { use: [] }, request: { mode: "workspace-write" } } } });
  const result = await raw(["config", "check"], box.env);
  assert.equal(result.code, 1, result.stderr);
  const out = lines(result.stdout);
  assert.match(out.find((line) => / good /.test(line))!, /^ok +good +local/);
  assert.match(out.find((line) => / bad /.test(line))!, /^error +bad +unknown agent bad field: colour$/);
  assert.match(out.find((line) => / ghost /.test(line))!, /^error +ghost +.*nope/);
  assert.match(out.find((line) => / codex /.test(line))!, /^ok +codex +terra \(codex-cli\)$/);
  assert.match(out.at(-1)!, /^4 agents, 2 errors, \d+ warnings$/);
  // The same rule a real run uses: loading the good agent alone works, the bad one fails with the same message.
  const run = await raw(["--agent", "bad", "hi"], box.env);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown agent bad field: colour/);
});

test("config check reports document errors once: broken JSON, a non-object agents, an unknown default_agent", async () => {
  const box = sandbox();
  const cases: Array<[unknown, RegExp]> = [
    ["{ \"agents\": ", /invalid JSON config/],
    [{ agents: [] }, /agents must be an object/],
    [{ agents: 42 }, /agents must be an object/],
    [{ agents: false }, /agents must be an object/],
    [{ default_agent: "x", agents: {} }, /unknown agent: x/],
    [{ models: { m: { method: "nope" } }, agents: {} }, /model m\.method must be one of/],
  ];
  for (const [data, message] of cases) {
    write(box.active, data);
    const result = await raw(["config", "check"], box.env);
    assert.equal(result.code, 1, `${JSON.stringify(data)}: ${result.stdout}${result.stderr}`);
    const out = lines(result.stdout);
    assert.match(out[0]!, /^error +config +/);
    assert.match(out[0]!, message);
    assert.equal(out.length, 2, result.stdout);
    assert.match(out[1]!, /^0 agents, 1 errors, 0 warnings$/);
    // A normal run on the same text fails with the same message.
    const run = await raw(["hi"], box.env);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, message);
  }
  for (const data of [{ agents: {} }, {}]) {
    write(box.active, data);
    const result = await raw(["config", "check"], box.env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "0 agents, 0 errors, 0 warnings\n");
  }
});

test("config check FILE and - check a candidate in the active config's place, without reading or touching the active file", async () => {
  const box = sandbox();
  mkdirSync(join(box.dirs.config, "raw", "prompts"));
  write(join(box.dirs.config, "raw", "prompts", "p.md"), "prompt");
  // The active file is broken: a candidate check that read it would fail.
  write(box.active, "{ broken");
  const before = { bytes: readFileSync(box.active), mtime: statSync(box.active).mtimeMs };
  const elsewhere = mkdtempSync(join(tmpdir(), "raw-candidate-"));
  const candidate = join(elsewhere, "candidate.json");
  const text = JSON.stringify({ default_agent: "a", sessions: { retention_days: 7 }, models: { local: API_MODEL },
    agents: { a: { model: "local", tools: { use: [] }, system_prompt_file: "prompts/p.md" }, b: { model: "local", tools: { use: [] }, system_prompt_file: "prompts/missing.md" } } });
  write(candidate, text);
  for (const [args, stdin] of [[["config", "check", candidate], ""], [["config", "check", "-"], text],
    [["--try-config", candidate, "config", "check"], ""]] as const) {
    const result = await raw([...args], box.env, stdin);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const out = lines(result.stdout);
    assert.match(out[0]!, /^ok +a +local/);
    // Relative to the active config's directory, not the candidate's.
    assert.equal(out[1], `error   b       cannot read system prompt file: ${join(box.dirs.config, "raw", "prompts", "missing.md")}`);
    assert.match(out.at(-1)!, /^2 agents, 1 errors, 0 warnings$/);
  }
  assert.deepEqual(readFileSync(box.active), before.bytes);
  assert.equal(statSync(box.active).mtimeMs, before.mtime);
  // A candidate given as a path that does not exist is an input error, not an empty config.
  const missing = await raw(["config", "check", join(elsewhere, "nope.json")], box.env);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read candidate config/);
});

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), info = statSync(path);
      out.push(`${path.slice(root.length)} ${info.isDirectory() ? "dir" : info.size} ${info.mtimeMs}`);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

function packageSource(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "agents"));
  write(join(root, "agents", "writer.json"), { system_prompt: "package prompt", tools: { use: ["builtin/todo"] } });
  write(join(root, "raw-package.json"), { schema_version: 1, name: "@test/writer", version: "1.0.0", description: "Writer",
    files: ["agents/writer.json"], exports: { agents: { writer: "agents/writer.json" } } });
  return root;
}

test("config check has no side effects: no process, no connection, no write to the config dir, the store or temp",
  { skip: posixOnly("modes") }, async () => {
    const box = sandbox();
    const log = join(box.root, "calls.log");
    for (const name of ["npm", "npx", "claude", "codex", "agy"]) {
      write(join(box.dirs.bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
      chmodSync(join(box.dirs.bin, name), 0o755);
    }
    const options = { configPath: box.active, env: box.env };
    write(box.active, { agents: {} });
    await installPackage({ ...options, source: packageSource("raw-check-installed-"), alias: "kit" });
    await linkPackage({ ...options, source: packageSource("raw-check-linked-"), alias: "dev" });
    const document = (broken: boolean) => ({ default_agent: "api",
      models: { local: API_MODEL, opus: { method: "claude-code-cli" } },
      mcp: { servers: { tools: { transport: "stdio", command: "npx", args: ["-y", "server"] } } },
      agents: { api: { model: "local", tools: { use: ["mcp/tools/search"] } }, claude: { model: "opus", tools: { use: [] } },
        installed: { from: "pkg/kit/agents/writer", model: "local" }, linked: { from: "pkg/dev/agents/writer", model: "opus" },
        ...(broken ? { broken: { model: "local", tools: { use: [] }, colour: 1 } } : {}) } });
    for (const broken of [false, true]) {
      write(box.active, document(broken));
      const before = [...snapshot(box.dirs.config), ...snapshot(box.dirs.data)];
      const started = Date.now();
      const result = await raw(["config", "check"], box.env);
      assert.equal(result.code, broken ? 1 : 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^ok +linked +opus \(claude-code-cli\)$/m);
      assert.match(result.stdout, /^ok +installed +local/m);
      assert.ok(Date.now() - started < 30_000);
      assert.deepEqual([...snapshot(box.dirs.config), ...snapshot(box.dirs.data)], before);
      assert.deepEqual(readdirSync(box.dirs.tmp).filter((name) => name.startsWith("raw-check-")), []);
      assert.throws(() => readFileSync(log), { code: "ENOENT" });
    }
  });

test("--try-config runs a task on the candidate in the active path context and leaves the active file unchanged", async () => {
  const box = sandbox();
  const fixture = await startMockProvider([{ frames: [openAiFrame({ content: "OK" }, "stop"), openAiDone] }]);
  try {
    mkdirSync(join(box.dirs.config, "raw", "prompts"));
    write(join(box.dirs.config, "raw", "prompts", "p.md"), "candidate prompt");
    write(box.active, { default_agent: "a", models: { local: API_MODEL }, agents: { a: { model: "local", tools: { use: [] } } } });
    const before = { bytes: readFileSync(box.active), mtime: statSync(box.active).mtimeMs };
    const candidate = join(mkdtempSync(join(tmpdir(), "raw-candidate-")), "candidate.json");
    write(candidate, { default_agent: "a", models: { local: { ...API_MODEL, base_url: fixture.url } },
      agents: { a: { model: "local", tools: { use: [] }, system_prompt_file: "prompts/p.md" }, b: { model: "local", tools: { use: [] } } } });
    const result = await raw(["--try-config", candidate, "--agent", "a", "Reply with just: OK"], box.env, "", box.dirs.work);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "OK\n");
    assert.match(JSON.stringify(fixture.requests[0]?.body), /candidate prompt/);
    assert.deepEqual(readFileSync(box.active), before.bytes);
    assert.equal(statSync(box.active).mtimeMs, before.mtime);
  } finally { await fixture.close(); }
});
