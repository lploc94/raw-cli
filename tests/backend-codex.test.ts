import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { CODEX_ADAPTER, installedAdapter } from "../src/backends/adapters.js";
import { CODEX_EMPTY_PROMPT, codexConfig, codexLaunch, codexPromptRoot, sweepCodexPrompts } from "../src/backends/codex.js";
import { createAcpSessionAgent } from "../src/backends/factory.js";
import { loadConfig, type RuntimeConfig } from "../src/config.js";

const FAKE_CODEX = join(import.meta.dirname, "fixtures", "fake-codex-app-server.mjs");
const FAKE_ACP = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");
/** Text a prompt may hold that no quoting layer may change: quotes, backslashes, shell and cmd.exe specials, newlines, non-ASCII. */
const TRICKY = "He said \"hi\" \\ 100% ^caret !bang `tick` $HOME %PATH% & | < >\nline two\ttab — ünïcødé 🙂\n";

/** The real codex-acp, installed once from npm into a cache shared by test runs (Decision: installed on first use). */
const ADAPTER_HOME = process.env.RAW_TEST_ADAPTER_HOME ?? join(tmpdir(), "raw-test-adapters");
let adapter: Promise<string | undefined> | undefined;
function realAdapter(): Promise<string | undefined> {
  adapter ??= installedAdapter(CODEX_ADAPTER, { env: { ...process.env, XDG_DATA_HOME: ADAPTER_HOME }, notify: () => {} })
    .catch((error: unknown) => { if (process.env.CI) throw error; return undefined; });
  return adapter;
}

async function runtimeFor(root: string, agent: Record<string, unknown>): Promise<RuntimeConfig> {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "x", agents: { x: { tools: { use: [] }, ...agent } } }));
  return loadConfig({ configPath, env: {} });
}

/** A `codex` on PATH that is the fake app-server. */
function fakeCodex(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") writeFileSync(join(bin, "codex.cmd"), `@"${process.execPath}" "${FAKE_CODEX}" %*\r\n`);
  else { writeFileSync(join(bin, "codex"), readFileSync(FAKE_CODEX)); chmodSync(join(bin, "codex"), 0o755); }
  return bin;
}

function launchEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${fakeCodex(root)}${delimiter}${process.env.PATH ?? ""}`, XDG_DATA_HOME: ADAPTER_HOME,
    XDG_STATE_HOME: join(root, "state"), FAKE_CODEX_LOG: join(root, "codex.jsonl"), ...extra };
}

/** Runs one turn through the real adapter against the fake Codex; returns the config of the thread it started. */
async function threadConfig(root: string, agent: Record<string, unknown>, extra: Record<string, string> = {}) {
  mkdirSync(root, { recursive: true });
  const runtime = await runtimeFor(root, agent);
  const env = launchEnv(root, extra);
  const created = createAcpSessionAgent({ runtime, tools: undefined as never, cwd: root, host: {} }, codexLaunch(runtime, root, { env }));
  const notices: string[] = [];
  let duringRun: string[] = [];
  try {
    await created.run("hello", (event) => { if (event.type === "backend_notice") notices.push(event.message); });
    duringRun = existsSync(codexPromptRoot(env)) ? readdirSync(codexPromptRoot(env)) : [];
  } finally { await created.close(); }
  const log = readFileSync(join(root, "codex.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  const start = log.find((message) => message.method === "thread/start");
  assert.ok(start, `codex-acp started no thread: ${JSON.stringify(log.map((message) => message.method ?? message.argv))}`);
  return { config: start.params.config as Record<string, unknown>, argv: log[0]!.argv as string[], notices, duringRun,
    afterClose: existsSync(codexPromptRoot(env)) ? readdirSync(codexPromptRoot(env)) : [] };
}

test("the prompt replaces Codex's with a file, is appended as developer instructions, or is not sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-codex-"));
  try {
    const replace = await runtimeFor(root, { backend: { kind: "codex" }, system_prompt: "Be RAW." });
    assert.deepEqual(codexConfig(replace, "/p/prompt.md"),
      { model_instructions_file: "/p/prompt.md", include_environment_context: false, include_permissions_instructions: false });
    const append = await runtimeFor(root, { backend: { kind: "codex", system_prompt_mode: "append" }, system_prompt: "Be RAW." });
    assert.deepEqual(codexConfig(append, "/p/prompt.md"), { developer_instructions: "Be RAW." });
    assert.equal(codexConfig(await runtimeFor(root, { backend: { kind: "codex" } }), "/p/prompt.md"), undefined);
    assert.equal(codexConfig(await runtimeFor(root, { backend: { kind: "codex" }, system_prompt: "" }), "/p/prompt.md"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real codex-acp hands Codex exactly the agent's prompt settings, from a file only this runtime owns", async (t) => {
  if (!await realAdapter()) return t.skip("codex-acp could not be installed (offline)");
  const root = mkdtempSync(join(tmpdir(), "raw-codex-"));
  try {
    const replace = await threadConfig(join(root, "r"), { backend: { kind: "codex" }, system_prompt: TRICKY });
    assert.deepEqual(replace.argv, ["app-server"]);
    assert.equal(replace.config.include_environment_context, false);
    assert.equal(replace.config.include_permissions_instructions, false);
    const file = replace.config.model_instructions_file as string;
    assert.ok(file.startsWith(join(root, "r", "state", "raw", "backends", "codex")), file);
    assert.equal(replace.duringRun.length, 1);
    assert.deepEqual(replace.afterClose, []);
    const append = await threadConfig(join(root, "a"), { backend: { kind: "codex", system_prompt_mode: "append" }, system_prompt: TRICKY });
    assert.equal(append.config.developer_instructions, TRICKY);
    assert.equal(append.config.model_instructions_file, undefined);
    assert.deepEqual(append.duringRun, []);
    const none = await threadConfig(join(root, "n"), { backend: { kind: "codex" } });
    assert.equal(none.config.model_instructions_file, undefined);
    assert.equal(none.config.developer_instructions, undefined);
    const empty = await threadConfig(join(root, "e"), { backend: { kind: "codex" }, system_prompt: "" });
    assert.equal(empty.config.model_instructions_file, undefined);
    assert.ok(empty.notices.includes(CODEX_EMPTY_PROMPT));
    // The user's own CODEX_CONFIG keeps its other settings; the prompt settings are the agent's.
    const inherited = await threadConfig(join(root, "u"), { backend: { kind: "codex", system_prompt_mode: "append" }, system_prompt: "Be RAW." },
      { CODEX_CONFIG: JSON.stringify({ model_reasoning_summary: "none", developer_instructions: "theirs" }) });
    assert.equal(inherited.config.model_reasoning_summary, "none");
    assert.equal(inherited.config.developer_instructions, "Be RAW.");
  // On Windows the fake Codex the stopped job held may still be closing its working directory.
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

test("the prompt file holds the prompt byte for byte while the runtime lives, and each runtime has its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-codex-"));
  try {
    const env = { PATH: fakeCodex(root), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") };
    const runtime = await runtimeFor(root, { backend: { kind: "codex" }, system_prompt: TRICKY });
    const npm = async (_args: string[], cwd: string) => {
      const entry = join(cwd, "node_modules", ...CODEX_ADAPTER.name.split("/"), CODEX_ADAPTER.entry);
      mkdirSync(join(entry, ".."), { recursive: true });
      writeFileSync(entry, "// adapter\n");
    };
    const [one, two] = await Promise.all([0, 1].map(() => codexLaunch(runtime, root, { env, npm })({ notify: () => {} })));
    const file = (launch: typeof one) => (JSON.parse(launch!.env.CODEX_CONFIG!) as { model_instructions_file: string }).model_instructions_file;
    assert.notEqual(file(one), file(two));
    assert.equal(readFileSync(file(one), "utf8"), TRICKY);
    assert.equal(one!.env.CODEX_PATH, join(env.PATH, process.platform === "win32" ? "codex.cmd" : "codex"));
    one!.cleanup!();
    assert.equal(existsSync(file(one)), false);
    assert.equal(readFileSync(file(two), "utf8"), TRICKY);
    two!.cleanup!();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a prompt directory a crashed Raw left behind is removed once older than the session retention", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-codex-"));
  try {
    for (const name of ["old", "new"]) { mkdirSync(join(root, name)); writeFileSync(join(root, name, "prompt.md"), "p"); }
    const longAgo = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(join(root, "old"), longAgo, longAgo);
    sweepCodexPrompts(root, 30);
    assert.deepEqual(readdirSync(root), ["new"]);
    sweepCodexPrompts(join(root, "missing"), 30);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("each adapter start marks the runtime's prompt directory in use, so the sweep keeps it, and restores a prompt a sweep removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-codex-"));
  try {
    const env = { PATH: fakeCodex(root), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") };
    const runtime = await runtimeFor(root, { backend: { kind: "codex" }, system_prompt: TRICKY });
    const npm = async (_args: string[], cwd: string) => {
      const entry = join(cwd, "node_modules", ...CODEX_ADAPTER.name.split("/"), CODEX_ADAPTER.entry);
      mkdirSync(join(entry, ".."), { recursive: true });
      writeFileSync(entry, "// adapter\n");
    };
    const built = (await codexLaunch(runtime, root, { env, npm })({ notify: () => {} }))!;
    const file = (JSON.parse(built.env.CODEX_CONFIG!) as { model_instructions_file: string }).model_instructions_file;
    const directory = join(file, "..");
    // The scripted ACP agent stands in for codex-acp, with this runtime's prompt preparation; it crashes on "crash".
    const launch = { command: process.execPath, args: [FAKE_ACP], env: { ...process.env, FAKE_ACP_STATE: join(root, "fake") }, prepare: built.prepare! };
    const agent = createAcpSessionAgent({ runtime, tools: undefined as never, cwd: root, host: {} }, launch);
    try {
      assert.equal((await agent.run("crash", () => {})).status, "error");
      // Between the adapter's crash and its restart a sweep finds the directory old, or has removed it.
      const longAgo = new Date(Date.now() - 31 * 86_400_000);
      utimesSync(directory, longAgo, longAgo);
      sweepCodexPrompts(codexPromptRoot(env), 30);
      assert.equal(existsSync(file), false);
      assert.equal((await agent.run("hello", () => {})).status, "completed");
      assert.equal(readFileSync(file, "utf8"), TRICKY);
      utimesSync(directory, longAgo, longAgo);
      assert.equal((await agent.run("crash", () => {})).status, "error");
      assert.equal((await agent.run("hello again", () => {})).status, "completed");
      sweepCodexPrompts(codexPromptRoot(env), 30);
      assert.equal(readFileSync(file, "utf8"), TRICKY);
    } finally { await agent.close(); built.cleanup!(); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
