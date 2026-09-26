import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, parseCliArgs } from "../src/config.js";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { testConfig } from "./fixtures/config.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

function answer(text: string) { return { frames: [openAiFrame({ content: text }, "stop"), openAiDone] }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-session-cli-"));
  const a = join(root, "a"); const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  const env = { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, OPENAI_API_KEY: "key" };
  return { root, a, b, env };
}
async function raw(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = "") {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(input);
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}
async function waitUntil(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("session syntax rejects conflicting modes and parses list/show/resume", () => {
  assert.equal(parseCliArgs(["sessions"]).command, "sessions-list");
  assert.equal(parseCliArgs(["sessions", "show", "abc", "--before", "cursor"]).sessionId, "abc");
  assert.equal(parseCliArgs(["--continue", "next"]).flags.continue, true);
  assert.equal(parseCliArgs(["--resume", "abc"]).flags.resumeId, "abc");
  assert.throws(() => parseCliArgs(["--continue", "--resume", "abc"]), /exclusive|combine|conflict/i);
  assert.throws(() => parseCliArgs(["sessions", "show"]), /ID|session/i);
});

test("one-shot session lists, resumes in another process, pages history, and deletes", async () => {
  const { root, a, b, env } = fixture();
  const provider = await startMockProvider([answer("first-answer"), answer("second-answer"), answer("third-answer")]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const first = await raw(["--config", config, "first task"], a, env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, "first-answer\n");
    const listed = await raw(["sessions"], a, env);
    assert.equal(listed.code, 0, listed.stderr);
    const id = listed.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    assert.ok(id);
    assert.match(first.stderr, new RegExp(`raw --resume ${id} "query"`));
    assert.doesNotMatch(first.stderr, /Session\s+\d+ input/);
    const firstContext = Number(first.stderr.match(/Context\s+~([\d.]+)/)?.[1]);
    assert.ok(firstContext > 0);
    assert.match(listed.stdout, /first task/);
    const noTask = await raw(["--resume", id], a, env, "/exit\n");
    assert.equal(noTask.code, 0, noTask.stderr);
    assert.match(noTask.stdout, /first-answer/);
    assert.equal(provider.requests.length, 1);
    const continued = await raw(["--continue", "second task"], a, env);
    assert.equal(continued.code, 0, continued.stderr);
    assert.equal(continued.stdout, "second-answer\n");
    assert.match(continued.stderr, new RegExp(`raw --resume ${id} "query"`));
    const continuedContext = Number(continued.stderr.match(/Context\s+~([\d.]+)/)?.[1]);
    assert.ok(continuedContext >= firstContext);
    assert.match(JSON.stringify(provider.requests[1]?.body), /first-answer/);
    const shown = await raw(["sessions", "show", id], a, env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /first task|first-answer/);
    const explicit = await raw(["--resume", id, "third task"], b, env);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(explicit.stdout, "third-answer\n");
    assert.match(explicit.stderr, new RegExp(`raw --resume ${id} "query"`));
    assert.match(explicit.stderr, /resuming in/);
    assert.ok(explicit.stderr.includes(a));
    assert.match(JSON.stringify(provider.requests[2]?.body), /second-answer/);
    const deleted = await raw(["sessions", "delete", id], a, env);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.doesNotMatch((await raw(["sessions"], a, env)).stdout, new RegExp(id));
    assert.equal((await raw(["sessions", "stats"], a, env)).code, 0);
    assert.equal((await raw(["sessions"], b, env)).stdout.includes(id), false);
    const store = openSessionStore({ env });
    try { assert.equal(store.getSession(id), undefined); }
    finally { store.close(); }
  } finally { await provider.close(); }
});

test("each old session format leaves a new CLI task and its later resume usable", async () => {
  const versions = [2, 4, 999, "unversioned"] as const;
  const provider = await startMockProvider(versions.flatMap((version) => [answer(`fresh-${version}`), answer(`resumed-${version}`)]));
  try {
    for (const version of versions) {
      const { root, a, env } = fixture();
      const previous = openSessionStore({ env });
      const oldId = previous.createSession({ cwd: a, title: "old-format task" }).id;
      previous.close();
      const legacy = join(root, "raw", "sessions.sqlite");
      const seed = new DatabaseSync(legacy);
      seed.exec(`PRAGMA user_version = ${version === "unversioned" ? 0 : version}`);
      seed.close();
      const before = readFileSync(legacy);
      const config = testConfig("openai", "fixture", provider.url);
      const fresh = await raw(["--config", config, "fresh task"], a, env);
      assert.equal(fresh.code, 0, fresh.stderr);
      assert.equal(fresh.stdout, `fresh-${version}\n`);
      const freshId = fresh.stderr.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1];
      assert.ok(freshId);
      assert.notEqual(freshId, oldId);
      const resumed = await raw(["--resume", freshId, "continue"], a, env);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(resumed.stdout, `resumed-${version}\n`);
      const old = await raw(["--resume", oldId, "continue old"], a, env);
      assert.equal(old.code, 2);
      assert.match(old.stderr, /older|legacy|unsupported/i);
      assert.match(old.stderr, /sessions\.sqlite/);
      assert.deepEqual(readFileSync(legacy), before);
    }
  } finally { await provider.close(); }
});

test("one-shot footer shows reported session token usage without inventing cache misses", async () => {
  const { a, env } = fixture();
  const usage = { prompt_tokens: 120, completion_tokens: 24, prompt_tokens_details: { cached_tokens: 80 } };
  const usageFrame = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
    model: "fixture", choices: [], usage })}\n\n`;
  const provider = await startMockProvider([{ frames: [openAiFrame({ content: "measured-answer" }, "stop"), usageFrame, openAiDone] }]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const document = JSON.parse(readFileSync(config, "utf8"));
    document.models.fixture.context_window_tokens = 20000;
    writeFileSync(config, JSON.stringify(document));
    const result = await raw(["--config", config, "measure"], a, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "measured-answer\n");
    assert.match(result.stderr, /Session\s+120 input · 24 output · 80 cache read/);
    assert.doesNotMatch(result.stderr, /cache miss/i);
    const context = result.stderr.match(/Context\s+[#-]+\s+~([\d.]+)k \/ 20k · (\d+\.\d)% used/);
    assert.ok(context, result.stderr);
    assert.ok(Math.abs(Number(context[2]) - Number(context[1]) * 1000 / 20000 * 100) < 0.3);
    assert.notEqual(Number(context[1]) * 1000, 144, "current context is not cumulative provider usage");
    assert.match(result.stderr, /Continue this session\n  raw --resume [0-9a-f-]+ "query"\n$/);
  } finally { await provider.close(); }
});

test("--continue is workspace-scoped and explicit agent/config overrides become saved defaults", async () => {
  const { a, b, env } = fixture();
  const provider = await startMockProvider([answer("a-first"), answer("b-first"), answer("a-next"),
    answer("agent-changed"), answer("config-changed"), answer("saved-default")]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const document = JSON.parse(readFileSync(config, "utf8"));
    document.agents.other = { model: "fixture", system_prompt: "other agent", tools: { use: [] } };
    writeFileSync(config, JSON.stringify(document));
    assert.equal((await raw(["--config", config, "A"], a, env)).code, 0);
    assert.equal((await raw(["--config", config, "B"], b, env)).code, 0);
    const next = await raw(["--continue", "A again"], a, env);
    assert.equal(next.stdout, "a-next\n");
    assert.match(JSON.stringify(provider.requests[2]?.body), /a-first/);
    assert.doesNotMatch(JSON.stringify(provider.requests[2]?.body), /b-first/);
    const listed = await raw(["sessions"], a, env);
    const id = listed.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    assert.ok(id);
    const changedAgent = await raw(["--resume", id, "--agent", "other", "switch agent"], a, env);
    assert.equal(changedAgent.code, 0, changedAgent.stderr);
    assert.equal(changedAgent.stdout, "agent-changed\n");
    assert.match(JSON.stringify(provider.requests[3]?.body), /switch agent/);
    const alternate = testConfig("openai", "fixture", provider.url);
    const changedConfig = await raw(["--resume", id, "--config", alternate, "switch config"], a, env);
    assert.equal(changedConfig.code, 0, changedConfig.stderr);
    assert.equal(changedConfig.stdout, "config-changed\n");
    const saved = await raw(["--resume", id, "resume defaults"], a, env);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout, "saved-default\n");
    const store = openSessionStore({ env });
    try { assert.equal(store.getSession(id)?.configPath, alternate); assert.equal(store.getSession(id)?.agentName, "fixture"); }
    finally { store.close(); }
  } finally { await provider.close(); }
});

test("an explicit replacement config resumes after the saved config file disappears", async () => {
  const { a, env } = fixture();
  const provider = await startMockProvider([answer("first"), answer("replaced"), answer("again")]);
  try {
    const original = testConfig("openai", "fixture", provider.url);
    const replacement = testConfig("openai", "fixture", provider.url);
    const first = await raw(["--config", original, "first"], a, env);
    assert.equal(first.code, 0, first.stderr);
    const id = first.stderr.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1];
    assert.ok(id);
    renameSync(original, `${original}.removed`);
    const missing = await raw(["--resume", id, "retry"], a, env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /config|ENOENT|no such file/i);
    assert.equal(provider.requests.length, 1);
    const second = await raw(["--resume", id, "--config", replacement, "retry"], a, env);
    assert.equal(second.code, 0, second.stderr);
    const third = await raw(["--resume", id, "again"], a, env);
    assert.equal(third.code, 0, third.stderr);
    assert.equal(third.stdout, "again\n");
  } finally { await provider.close(); }
});

test("REPL /clear preserves old session and creates a second ID", async () => {
  const { a, env } = fixture();
  const provider = await startMockProvider([answer("before-clear"), answer("after-clear")]);
  const config = testConfig("openai", "fixture", provider.url);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--config", config, "--interactive"], { cwd: a, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  try {
    await waitUntil(() => stdout.includes("> "), "REPL prompt");
    child.stdin.write("old task\n");
    await waitUntil(() => stdout.includes("before-clear"), "first answer");
    child.stdin.write("/clear\n");
    await waitUntil(() => stderr.includes("conversation cleared"), "clear acknowledgement");
    child.stdin.write("new task\n");
    await waitUntil(() => stdout.includes("after-clear"), "second answer");
    child.stdin.write("/exit\n");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    const store = openSessionStore({ env });
    try {
      const sessions = store.listSessions({ cwd: a, limit: 10 }).items;
      assert.equal(sessions.length, 2);
      const old = sessions.find((item) => item.title === "old task");
      const recent = sessions.find((item) => item.title === "new task");
      assert.ok(old && recent && old.id !== recent.id);
      assert.match(JSON.stringify(store.getSessionHistory({ sessionId: old.id }).items), /before-clear/);
      assert.match(stderr, new RegExp(`raw --resume ${recent.id} "query"`));
      assert.doesNotMatch(stderr, new RegExp(`raw --resume ${old.id} "query"`));
    } finally { store.close(); }
  } finally { child.kill("SIGKILL"); await provider.close(); }
});

test("provider failure offers the saved session and a later request resumes it", async () => {
  const { a, env } = fixture();
  const provider = await startMockProvider([{ status: 400, body: { error: { message: "fixture failure" } } }, answer("recovered")]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const failed = await raw(["--config", config, "first fails"], a, env);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, /Failed.*provider_error/);
    const id = failed.stderr.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1];
    assert.ok(id, failed.stderr);
    const resumed = await raw(["--resume", id, "retry"], a, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, "recovered\n");
    assert.match(resumed.stderr, new RegExp(`raw --resume ${id} "query"`));
  } finally { await provider.close(); }
});

test("SIGINT keeps REPL ownership; SIGTERM releases it after a later prompt", async () => {
  const { a, env } = fixture();
  const provider = await startMockProvider([{ hold: true }, answer("after-cancel"), answer("after-term")]);
  const config = testConfig("openai", "fixture", provider.url);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
    "--config", config, "--interactive"], { cwd: a, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  try {
    await waitUntil(() => stdout.includes("> "), "REPL prompt");
    child.stdin.write("blocked task\n");
    await waitUntil(() => provider.requests.length === 1, "held provider request");
    const store = openSessionStore({ env });
    const id = store.listSessions({ cwd: a }).items[0]?.id;
    store.close();
    assert.ok(id);
    child.kill("SIGINT");
    await waitUntil(() => stderr.includes("Cancelled"), "SIGINT cancellation");
    const competing = await raw(["--resume", id, "competing"], a, env);
    assert.notEqual(competing.code, 0);
    assert.match(competing.stderr, /busy/i);
    assert.equal(provider.requests.length, 1);
    child.stdin.write("second task\n");
    await waitUntil(() => stdout.includes("after-cancel"), "second answer");
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const resumed = await raw(["--resume", id, "after term"], a, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, "after-term\n");
    assert.match(JSON.stringify(provider.requests[2]?.body), /after-cancel/);
  } finally { child.kill("SIGKILL"); await provider.close(); }
});

test("sessions show reproduces a complete rejected Bash argument after restart and compact", async () => {
  const { a, env } = fixture();
  const command = "printf " + "z".repeat(70_000);
  const args = { commands: [{ command, extra: true }] };
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "bad-bash", type: "function",
      function: { name: "bash", arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] },
    answer("done"), answer("short summary"),
  ]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const document = JSON.parse(readFileSync(config, "utf8")) as { agents: { fixture: Record<string, unknown> } };
    document.agents.fixture.compact = { keep_recent_turns: 0, max_output_tokens: 512 };
    writeFileSync(config, JSON.stringify(document));
    const first = await raw(["--config", config, "run invalid Bash"], a, env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stderr, /bad-bash|bash/);
    const listed = await raw(["sessions"], a, env);
    const id = listed.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    assert.ok(id);
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
      "--resume", id], { cwd: a, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    try {
      await waitUntil(() => stdout.includes("> "), "resumed prompt");
      child.stdin.write("/compact\n");
      await waitUntil(() => stderr.includes("Compact compacted"), "compact result");
      child.stdin.write("/exit\n");
      assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 0, stderr);
    } finally { child.kill("SIGKILL"); }
    const shown = await raw(["sessions", "show", id], a, env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(shown.stdout.replace(/\r?\n/g, "").includes(JSON.stringify(args)));
    assert.ok(shown.stdout.replace(/\r?\n/g, "").includes(command));
  } finally { await provider.close(); }
});

test("list and history cursors expose older IDs/items, and an older ID resumes", async () => {
  const { a, env } = fixture();
  const provider = await startMockProvider([answer("older-resumed")]);
  const config = testConfig("openai", "fixture", provider.url);
  const runtime = await loadConfig({ cwd: a, env, flags: { configPath: config }, requireModel: true });
  const store = openSessionStore({ env });
  try {
    for (let i = 0; i < 25; i++) {
      const row = store.createSession({ cwd: a, title: `seed ${i}`, agentName: runtime.modelConfig!.agentName,
        configPath: runtime.configPath, modelId: runtime.modelConfig!.model, provider: runtime.modelConfig!.provider,
        method: runtime.modelConfig!.method, ...(runtime.modelConfig!.baseUrl ? { endpoint: runtime.modelConfig!.baseUrl } : {}),
        systemPrompt: runtime.systemPrompt });
      const agent = createAgent({ cwd: a, provider: createProvider(runtime.modelConfig!),
        registry: createTestToolRegistry(runtime.toolRules, runtime.modelConfig!.vision === true), system: runtime.systemPrompt,
        whitelist: ["read_file", "write_file", "bash"],
        persistence: { store, sessionId: row.id, surface: "cli" } });
      await agent.close();
    }
    const first = await raw(["sessions", "--all"], a, env);
    assert.equal(first.code, 0, first.stderr);
    const cursor = first.stdout.match(/^next: (.+)$/m)?.[1];
    assert.ok(cursor);
    assert.equal((first.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []).length, 20);
    const older = await raw(["sessions", "--all", "--before", cursor], a, env);
    assert.equal(older.code, 0, older.stderr);
    const olderId = older.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    assert.ok(olderId);
    assert.doesNotMatch(first.stdout, new RegExp(olderId));
    const resumed = await raw(["--resume", olderId, "continue older"], a, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stdout, "older-resumed\n");
    for (let i = 1; i <= 41; i++) store.appendHistory({ sessionId: olderId, kind: "assistant", payload: { text: `history-${i}` } });
    const recent = await raw(["sessions", "show", olderId], a, env);
    assert.equal(recent.code, 0, recent.stderr);
    assert.match(recent.stdout, /history-41/);
    assert.doesNotMatch(recent.stdout, /history-1\n/);
    const historyCursor = recent.stdout.match(/^next: (.+)$/m)?.[1];
    assert.ok(historyCursor);
    const middle = await raw(["sessions", "show", olderId, "--before", historyCursor], a, env);
    assert.equal(middle.code, 0, middle.stderr);
    assert.match(middle.stdout, /history-2[0-1]/);
    const oldestCursor = middle.stdout.match(/^next: (.+)$/m)?.[1];
    assert.ok(oldestCursor);
    const oldest = await raw(["sessions", "show", olderId, "--before", oldestCursor], a, env);
    assert.equal(oldest.code, 0, oldest.stderr);
    assert.match(oldest.stdout, /history-1\n/);
  } finally { store.close(); await provider.close(); }
});
