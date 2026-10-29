import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAUDE_ADAPTER, adapterDirectory, findExecutable, installedAdapter } from "../src/backends/adapters.js";
import { CLAUDE_EMPTY_PROMPT, CLAUDE_MISSING, claudeLaunch, claudeSessionMeta } from "../src/backends/claude.js";
import { createAcpSessionAgent, sessionIdentity } from "../src/backends/factory.js";
import { loadConfig, type RuntimeConfig } from "../src/config.js";
import { openSessionStore } from "../src/sessions/store.js";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

async function runtimeFor(root: string, agent: Record<string, unknown>): Promise<RuntimeConfig> {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "c", agents: { c: { tools: { use: [] }, ...agent } } }));
  return loadConfig({ configPath, env: {} });
}

/** An npm stand-in that "installs" the adapter by writing its entry file, and records each call. */
function fakeNpm(calls: Array<{ args: string[]; cwd: string }>, delayMs = 0) {
  return async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const entry = join(cwd, "node_modules", ...CLAUDE_ADAPTER.name.split("/"), CLAUDE_ADAPTER.entry);
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "// adapter\n");
  };
}

function fakeClaude(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return bin;
}

test("the system prompt replaces Claude Code's, is appended to it, or is not sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    assert.deepEqual(claudeSessionMeta(await runtimeFor(root, { backend: { kind: "claude" }, system_prompt: "Be RAW." })), { systemPrompt: "Be RAW." });
    assert.deepEqual(claudeSessionMeta(await runtimeFor(root, { backend: { kind: "claude", system_prompt_mode: "append" }, system_prompt: "Be RAW." })),
      { systemPrompt: { append: "Be RAW." } });
    assert.equal(claudeSessionMeta(await runtimeFor(root, { backend: { kind: "claude" } })), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the launch installs the pinned adapter once, without optional binaries, and points it at the user's claude", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const env = { PATH: fakeClaude(root), XDG_DATA_HOME: join(root, "data") };
    const runtime = await runtimeFor(root, { backend: { kind: "claude" }, system_prompt: "Be RAW." });
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const notices: string[] = [];
    const resolve = claudeLaunch(runtime, root, { env, npm: fakeNpm(calls) });
    const launch = await resolve({ notify: (message) => notices.push(message) });
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.args[0], join(adapterDirectory(CLAUDE_ADAPTER, env), "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
    assert.ok(existsSync(launch.args[0]!));
    assert.equal(launch.env.CLAUDE_CODE_EXECUTABLE, findExecutable("claude", env, root));
    assert.ok(!Object.keys(launch.env).some((key) => /RAW_BRIDGE|TOKEN/i.test(key)));
    assert.deepEqual(launch.sessionMeta, { systemPrompt: "Be RAW." });
    assert.deepEqual(calls.map((call) => call.args), [["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact",
      "@agentclientprotocol/claude-agent-acp@0.98.0"]]);
    assert.deepEqual(notices, ["Installing @agentclientprotocol/claude-agent-acp@0.98.0 from npm (first use; once per version)"]);
    await resolve({ notify: (message) => notices.push(message) });
    assert.equal(calls.length, 1);
    assert.equal(notices.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an explicit empty prompt Claude Code cannot take warns; no prompt or an appended one does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const env = { PATH: fakeClaude(root), XDG_DATA_HOME: join(root, "data") };
    const warned = async (agent: Record<string, unknown>) => {
      const notices: string[] = [];
      await claudeLaunch(await runtimeFor(root, agent), root, { env, npm: fakeNpm([]) })({ notify: (message) => notices.push(message) });
      return notices.includes(CLAUDE_EMPTY_PROMPT);
    };
    assert.equal(await warned({ backend: { kind: "claude" }, system_prompt: "" }), true);
    assert.equal(await warned({ backend: { kind: "claude" } }), false);
    assert.equal(await warned({ backend: { kind: "claude" }, system_prompt: "Be RAW." }), false);
    assert.equal(await warned({ backend: { kind: "claude", system_prompt_mode: "append" }, system_prompt: "" }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PATH lookup resolves relative entries against the working directory, and an empty POSIX entry is it", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const bin = fakeClaude(root);
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    assert.equal(findExecutable("claude", { PATH: "bin" }, root), join(bin, name));
    assert.equal(findExecutable("claude", { PATH: "elsewhere" }, root), undefined);
    if (process.platform !== "win32") assert.equal(findExecutable("claude", { PATH: ":" }, bin), join(bin, name));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A stand-in `npm` on PATH: a shell script, so the real runner (process group, stderr tail) is what runs. */
function npmScript(root: string, body: string): string {
  const bin = join(root, "npm-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

test("a failed npm keeps only the last 64 KiB of its stderr, marked as truncated", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const PATH = npmScript(root, `/usr/bin/head -c 200000 /dev/zero | /usr/bin/tr '\\0' x >&2; echo LAST-LINE >&2; exit 3`);
    const error = await installedAdapter(CLAUDE_ADAPTER, { env: { PATH, XDG_DATA_HOME: join(root, "data") }, notify: () => {} })
      .then(() => undefined, (failure: Error) => failure);
    assert.ok(/failed \(code 3\): \[stderr truncated\]\nx+LAST-LINE$/.test(error!.message), error!.message.slice(0, 200));
    assert.ok(error!.message.length < 70 * 1024);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancelling the install stops npm and what it started", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const pidFile = join(root, "worker.pid");
    const PATH = npmScript(root, `/bin/sleep 60 & echo $! > "${pidFile}"; wait`);
    const controller = new AbortController();
    const install = installedAdapter(CLAUDE_ADAPTER, { env: { PATH, XDG_DATA_HOME: join(root, "data") }, notify: () => {}, signal: controller.signal });
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) await new Promise((resolve) => setTimeout(resolve, 20));
    const worker = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    await assert.rejects(install, /install cancelled/);
    const alive = () => { try { process.kill(worker, 0); return true; } catch { return false; } };
    assert.equal(alive(), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a cancel that comes with the install notice starts no npm, and the turn ends cancelled", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const marker = join(root, "npm-started");
    const env = { PATH: `${fakeClaude(root)}:${npmScript(root, `touch "${marker}"; /bin/sleep 60`)}`, XDG_DATA_HOME: join(root, "data") };
    const runtime = await runtimeFor(root, { backend: { kind: "claude" } });
    const agent = createAcpSessionAgent({ runtime, tools: undefined as never, cwd: root, host: {} }, claudeLaunch(runtime, root, { env }));
    try {
      const result = await agent.run("hello", (event) => {
        if (event.type === "backend_notice" && event.message.startsWith("Installing")) agent.abort();
      });
      assert.equal(result.status, "cancelled");
    } finally { await agent.close(); }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(marker), false);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(installedAdapter(CLAUDE_ADAPTER, { env, notify: () => {}, signal: controller.signal }), /install cancelled/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two Raw processes installing the adapter at once both get it, and no staging directory is left", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const env = { XDG_DATA_HOME: join(root, "data") };
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const [one, two] = await Promise.all([0, 1].map(() => installedAdapter(CLAUDE_ADAPTER, { env, notify: () => {}, npm: fakeNpm(calls, 50) })));
    assert.equal(one, two);
    assert.ok(existsSync(one!));
    assert.equal(calls.length, 2);
    const parent = join(adapterDirectory(CLAUDE_ADAPTER, env), "..");
    assert.deepEqual((await import("node:fs")).readdirSync(parent), ["@agentclientprotocol__claude-agent-acp@0.98.0"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed install leaves nothing behind and the next launch tries again", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const env = { XDG_DATA_HOME: join(root, "data") };
    let attempts = 0;
    const failing = async () => { attempts++; throw new Error("npm install failed (code 1): network down"); };
    await assert.rejects(installedAdapter(CLAUDE_ADAPTER, { env, notify: () => {}, npm: failing }), /network down/);
    assert.ok(!existsSync(join(adapterDirectory(CLAUDE_ADAPTER, env), "..")) || (await import("node:fs")).readdirSync(join(adapterDirectory(CLAUDE_ADAPTER, env), "..")).length === 0);
    await installedAdapter(CLAUDE_ADAPTER, { env, notify: () => {}, npm: fakeNpm([]) });
    assert.equal(attempts, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function turn(root: string, agent: Record<string, unknown>, launchEnv: NodeJS.ProcessEnv, useResolver = true) {
  const runtime = await runtimeFor(root, agent);
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const session = store.createSession({ cwd: root, title: "t", ...sessionIdentity(runtime) });
  const launch = useResolver ? claudeLaunch(runtime, root, { env: launchEnv, npm: fakeNpm([]) }) : undefined;
  // The installed "adapter" is the fake ACP agent: the launch is real up to the file it runs.
  const resolver = launch && (async (context: Parameters<NonNullable<typeof launch>>[0]) => {
    const real = await launch(context);
    return { ...real, args: [FAKE], env: { ...real.env, FAKE_ACP_STATE: join(root, "fake"), ...launchEnv } };
  });
  const created = createAcpSessionAgent({ runtime, tools: undefined as never, cwd: root,
    host: { persistence: { store, sessionId: session.id, surface: "web" } } }, resolver!);
  try { return { result: await created.run("hello"), agent: created, store, session }; }
  finally { await created.close(); }
}

test("no claude ends the turn backend_unavailable with how to fix it; a CLI without a login ends it backend_auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const missing = await turn(root, { backend: { kind: "claude", executable: join(root, "nowhere", "claude") } }, { XDG_DATA_HOME: join(root, "data") });
    assert.equal(missing.result.code, "backend_unavailable");
    assert.equal(missing.result.message, `Claude Code is not available: ${CLAUDE_MISSING}`);
    missing.store.close();
    const env = { PATH: fakeClaude(root), XDG_DATA_HOME: join(root, "data"), FAKE_ACP_AUTH: "1" };
    const auth = await turn(root, { backend: { kind: "claude" } }, env);
    assert.equal(auth.result.code, "backend_auth");
    assert.equal(auth.result.message, "Claude Code needs a login: run `claude` once and log in");
    auth.store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the model the CLI reports for a prompt is kept with the usage record and shown as the session's model", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const { result, agent, store, session } = await turn(root, { backend: { kind: "claude", model: "big" } },
      { PATH: fakeClaude(root), XDG_DATA_HOME: join(root, "data") });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(agent.provider.usedModel, "fake-big-1");
    const owner = store.claimSession(session.id);
    const raw = JSON.stringify(store.readAgentState(session.id, owner));
    store.releaseSession(session.id, owner);
    assert.match(raw, /"models":\["fake-big-1"\]/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an installed adapter is found again by a new process from the same data directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const env = { XDG_DATA_HOME: join(root, "data") };
    const entry = join(adapterDirectory(CLAUDE_ADAPTER, env), "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "x");
    const found = await installedAdapter(CLAUDE_ADAPTER, { env, notify: () => assert.fail("no install expected"),
      npm: async () => assert.fail("no npm expected") });
    assert.equal(readFileSync(found, "utf8"), "x");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the terminal prints what to do when the backend is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-claude-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ default_agent: "c", agents: { c: { backend: { kind: "claude", executable: join(root, "none", "claude") }, tools: { use: [] } } } }));
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "..", "bin", "raw.ts"), "--config", config, "hi"],
      { cwd: root, env: { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") }, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /raw: Claude Code is not available: Install Claude Code and log in \(`claude`\), or set backend\.executable/);
    assert.match(run.stderr, /Failed · backend_unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
