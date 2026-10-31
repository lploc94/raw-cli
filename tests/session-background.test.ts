import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAcpSessionAgent, sessionIdentity } from "../src/backends/factory.js";
import { loadConfig } from "../src/config.js";
import { SessionOperations, type AttachSessionRuntime, type SessionOperation } from "../src/sessions/operations.js";
import { attachSessionRuntimeWith } from "../src/sessions/runtime.js";
import { openSessionStore, type SessionStore } from "../src/sessions/store.js";
import { cliConfig } from "./fixtures/cli-agent.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

// Phase 3 of cli-background-work: the dashboard's operations keep a backend CLI's adapter while its background work
// runs, and record the turns the CLI takes after it as operations of the session.
const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

async function fixture(kind: "claude" | "codex", fakeEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-session-bg-"));
  const state = join(root, "fake");
  const configPath = join(root, "config.json");
  const writeConfig = (prompt: string) => writeFileSync(configPath, JSON.stringify(cliConfig({ default_agent: "ext",
    agents: { ext: { cli: { kind }, system_prompt: prompt, tools: { use: [] } } } })));
  writeConfig("Be RAW.");
  const runtime = await loadConfig({ configPath, env: {} });
  const storeEnv = { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root };
  const store = openSessionStore({ env: storeEnv });
  const session = store.createSession({ cwd: root, title: "New session", ...sessionIdentity(runtime) });
  const env: NodeJS.ProcessEnv = { ...fakeEnv };
  let failCliAttach = false;
  const closeDelay: Partial<Record<"compact" | "turn", number>> = {};
  const real = attachSessionRuntimeWith((context) => createAcpSessionAgent(context,
    { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ACP_STATE: state, ...env }, asyncTasks: true }));
  const attach: AttachSessionRuntime = async (options) => {
    if (failCliAttach && options.operation.origin === "cli") throw new Error("simulated attach failure");
    const runtime = await real(options);
    const delay = options.operation.origin === "cli" ? undefined : closeDelay[options.operation.kind as "compact" | "turn"];
    if (delay) {
      const close = runtime.close.bind(runtime);
      runtime.close = async () => { await new Promise((resolve) => setTimeout(resolve, delay)); await close(); };
    }
    return runtime;
  };
  const service = new SessionOperations({ store, attach, env: { RAW_TEST_KEY: "key" } });
  let count = 0;
  const intent = (input: string) => ({ sessionId: session.id, clientRequestId: `r${++count}`, kind: "turn" as const, input, agentName: "ext", configPath });
  const f = {
    root, store, session, service, env, configPath, writeConfig, storeEnv,
    failCliAttach: (value: boolean) => { failCliAttach = value; },
    /** Delays the cleanup of the user's operations of that kind. */
    delayClose: (kind: "compact" | "turn", ms: number) => { closeDelay[kind] = ms; },
    submit: (input: string) => service.submit(intent(input)),
    enqueue: (input: string) => service.enqueue(intent(input), { mode: "queue" }),
    compactNow: (request: { clientRequestId?: string; agentName?: string; configPath?: string } = {}) => service.compactNow({ sessionId: session.id,
      clientRequestId: request.clientRequestId ?? `r${++count}`, kind: "compact", agentName: request.agentName ?? "ext", configPath: request.configPath ?? configPath }),
    run: async (input: string) => service.wait(f.submit(input).id),
    operations: () => store.listOperations(session.id).sort((a, b) => a.acceptedAt - b.acceptedAt),
    cliOperations: () => f.operations().filter((operation) => operation.origin === "cli"),
    pids: () => { try { return readdirSync(state).filter((name) => name.startsWith("adapter-")).map((name) => Number(readFileSync(join(state, name), "utf8"))); } catch { return []; } },
    calls: () => { try { return readdirSync(state).filter((name) => name.startsWith("calls-")).sort()
      .flatMap((name) => readFileSync(join(state, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)); } catch { return []; } },
    prompts: () => f.calls().filter((call) => call.method === "session/prompt").map((call) => call.input as string),
    stops: () => f.calls().filter((call) => call.method === "_session/async_task/stop").map((call) => call.asyncTaskId),
    history: () => store.getSessionHistory({ sessionId: session.id, limit: 100 }).items.flatMap((item) =>
      item.kind === "backend_notice" ? [`notice:${String(item.payload.text)}`] : item.kind === "assistant" ? [`assistant:${String(item.payload.text)}`]
        : item.kind === "user" ? [`user:${String(item.payload.input)}`] : []),
    async close() { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
  return f;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, what: string, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
const settled = (operation: SessionOperation | undefined) => operation !== undefined && ["completed", "cancelled", "error", "max_steps", "interrupted"].includes(operation.state);
const NOTE = 'Background command "Background job" completed (exit code 0)';
/** What a wake sends the CLI: the note, then the request to read the output (Decision 2026-10-30). */
const sent = (note: string) => `${note}\nRead its output before you answer.`;

test("resident: a background task outlives its operation, and the next turn reuses the same adapter", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    assert.equal(f.pids().length, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(alive(pid!), "the adapter runs on after the operation");
    assert.equal((await f.run("hello")).state, "completed");
    assert.deepEqual(f.pids(), [pid]);
    assert.deepEqual(f.prompts(), ["bg", "hello"]);
    assert.equal(f.calls().filter((call) => call.method === "session/load").length, 0, "the same conversation, not a reload");
  } finally { await f.close(); }
});

test("CLI turn: Claude Code's own turn becomes an operation of the session, and the adapter closes once no work remains", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "200", FAKE_ACP_BG_TURN: "claude" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    await until(() => settled(f.cliOperations()[0]), "the CLI turn's operation");
    const cli = f.cliOperations()[0]!;
    assert.equal(cli.state, "completed");
    assert.equal(cli.kind, "turn");
    assert.equal(cli.input, NOTE);
    assert.deepEqual(f.history(), ["user:bg", "assistant:started", `notice:Claude Code continues: ${NOTE}`, "assistant:Noted: Background job finished."]);
    await until(() => !alive(pid!), "the adapter to close");
    assert.deepEqual(f.prompts(), ["bg"]);
    assert.equal(f.cliOperations().length, 1);
  } finally { await f.close(); }
});

test("CLI turn: a monitor that expires with nothing else running keeps the adapter for Claude Code's own turn", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_TYPE: "monitor", FAKE_ACP_BG_CANSTOP: "0", FAKE_ACP_BG_MS: "200",
    FAKE_ACP_BG_STATES: "stopped", FAKE_ACP_BG_TURN: "claude" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    await until(() => settled(f.cliOperations()[0]), "the CLI turn's operation");
    assert.equal(f.cliOperations()[0]!.state, "completed");
    assert.deepEqual(f.history().slice(-2), ['notice:Claude Code continues: Monitor "Background job" stopped', "assistant:Noted: Background job finished."]);
    await until(() => !alive(pid!), "the adapter to close");
  } finally { await f.close(); }
});

test("CLI turn: Codex is woken as an operation with the note, and the adapter closes after it", async () => {
  const f = await fixture("codex", { FAKE_ACP_BG_CALL: "open", FAKE_ACP_BG_MS: "200" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    await until(() => settled(f.cliOperations()[0]), "the CLI turn's operation");
    const note = 'Background command "Background job" completed (exit code 0).';
    assert.equal(f.cliOperations()[0]!.state, "completed");
    assert.deepEqual(f.prompts(), ["bg", sent(note)]);
    assert.deepEqual(f.history().slice(-2), [`notice:Codex continues: ${note}`, `assistant:woke:${sent(note)}`]);
    await until(() => !alive(pid!), "the adapter to close");
  } finally { await f.close(); }
});

// Compact now on Claude Code and Codex (spike cli-compact-now, 2026-10-31): the CLI's own `/compact`; a running turn is
// stopped for it, and a CLI turn then tells the CLI to go on, before the messages waiting behind.
const COMPACT_NOW = "/compact The user asked to compact now, in the middle of your work; your turn was stopped for it. Keep in the summary "
  + "what you were doing, what is done and what is left: after the compaction you will be asked to continue.";
const RESUME = "The user compacted the context in the middle of your work; your turn was stopped for it. "
  + "Continue the task you were working on, from where you stopped.";

test("compact now: an idle CLI session sends the CLI's /compact, and nothing follows it", async (t) => {
  for (const kind of ["claude", "codex"] as const) await t.test(kind, async () => {
    const f = await fixture(kind);
    try {
      assert.equal((await f.run("hello")).state, "completed");
      const started = f.compactNow();
      assert.ok("operation" in started, JSON.stringify(started));
      const done = await f.service.wait(started.operation.id);
      assert.equal(done.state, "completed", JSON.stringify(done));
      assert.equal(done.kind, "compact");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(f.prompts(), ["hello", "/compact"]);
      assert.equal(f.cliOperations().length, 0);
      const label = kind === "claude" ? "Claude Code" : "Codex";
      assert.ok(f.history().includes(`notice:${label} compacts its context`), JSON.stringify(f.history()));
    } finally { await f.close(); }
  });
});

test("compact now: a running turn is stopped, the CLI compacts keeping its task, goes on in a CLI turn, then the waiting message runs", async (t) => {
  for (const kind of ["claude", "codex"] as const) await t.test(kind, async () => {
    const f = await fixture(kind, { FAKE_ACP_COMPACT_MS: "200" });
    try {
      const first = f.submit("wait for it");
      await until(() => f.prompts().length === 1, "the first prompt");
      assert.ok("queued" in f.enqueue("later"));
      const started = f.compactNow();
      assert.deepEqual(started, { interrupting: first.id });
      await until(() => f.operations().length === 4 && settled(f.operations()[3]), "the waiting message's turn");
      assert.deepEqual(f.operations().map((operation) => [operation.kind, operation.origin ?? "user", operation.state]),
        [["turn", "user", "cancelled"], ["compact", "user", "completed"], ["turn", "cli", "completed"], ["turn", "user", "completed"]]);
      assert.deepEqual(f.prompts(), ["wait for it", COMPACT_NOW, RESUME, "later"]);
      const label = kind === "claude" ? "Claude Code" : "Codex";
      assert.deepEqual(f.history().filter((item) => item.startsWith("notice:")), [
        `notice:${label} compacts its context now, as you asked, and then goes on with its task`, `notice:${label} continues: ${RESUME}`]);
      assert.ok(f.history().includes("assistant:resumed the task"));
    } finally { await f.close(); }
  });
});

test("compact now: Stop on the compaction ends it, and no turn goes on after it", async () => {
  const f = await fixture("claude", { FAKE_ACP_COMPACT_MS: "30000" });
  try {
    const first = f.submit("wait for it");
    await until(() => f.prompts().length === 1, "the first prompt");
    assert.deepEqual(f.compactNow(), { interrupting: first.id });
    await until(() => f.operations()[1]?.state === "compacting" && f.prompts().length === 2, "the compaction to run");
    assert.equal(f.service.cancel(f.operations()[1]!.id), true);
    await until(() => settled(f.operations()[1]), "the compaction to end");
    assert.equal(f.operations()[1]!.state, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(f.operations().length, 2);
    assert.deepEqual(f.prompts(), ["wait for it", COMPACT_NOW]);
  } finally { await f.close(); }
});

test("compact now: a message the CLI never got waits for the prompt after /compact, which goes alone", async (t) => {
  for (const kind of ["claude", "codex"] as const) await t.test(kind, async () => {
    const f = await fixture(kind, { FAKE_ACP_INIT_DELAY: "800" });
    try {
      const first = f.submit("finish original task");
      await until(() => f.store.getOperation(first.id)?.committedUserPosition !== undefined, "the message to be committed");
      assert.equal(f.prompts().length, 0);
      assert.deepEqual(f.compactNow(), { interrupting: first.id });
      await until(() => f.operations().length === 3 && settled(f.operations()[2]), "the CLI turn after the compaction");
      assert.deepEqual(f.operations().map((operation) => [operation.kind, operation.state]), [["turn", "cancelled"], ["compact", "completed"], ["turn", "completed"]]);
      assert.deepEqual(f.prompts(), [COMPACT_NOW, `finish original task\n\n${RESUME}`]);
    } finally { await f.close(); }
  });
});

test("compact now: a message the CLI never got outlives the adapter that sent /compact, and a cancelled compaction", async (t) => {
  for (const kind of ["claude", "codex"] as const) await t.test(`idle compaction, ${kind}`, async () => {
    const f = await fixture(kind, { FAKE_ACP_INIT_DELAY: "350" });
    try {
      const first = f.submit("finish original task");
      await until(() => f.store.getOperation(first.id)?.committedUserPosition !== undefined, "the message to be committed");
      f.service.cancel(first.id);
      await f.service.wait(first.id);
      const compact = f.compactNow();
      assert.ok("operation" in compact);
      assert.equal((await f.service.wait(compact.operation.id)).state, "completed");
      assert.equal((await f.run("continue task")).state, "completed");
      assert.deepEqual(f.prompts(), ["/compact", "finish original task\n\ncontinue task"]);
      assert.equal(f.pids().length, 2, "the compaction's adapter closed and the next turn started another");
    } finally { await f.close(); }
  });
  await t.test("cancelled compaction", async () => {
    const f = await fixture("claude", { FAKE_ACP_INIT_DELAY: "350", FAKE_ACP_COMPACT_MS: "30000" });
    try {
      const first = f.submit("finish original task");
      await until(() => f.store.getOperation(first.id)?.committedUserPosition !== undefined, "the message to be committed");
      assert.deepEqual(f.compactNow(), { interrupting: first.id });
      await until(() => f.prompts().length === 1 && f.operations()[1]?.state === "compacting", "the compaction to run");
      f.service.cancel(f.operations()[1]!.id);
      await f.service.wait(f.operations()[1]!.id);
      assert.equal((await f.run("continue task")).state, "completed");
      assert.deepEqual(f.prompts(), [COMPACT_NOW, "finish original task\n\ncontinue task"]);
    } finally { await f.close(); }
  });
});

test("compact now: a compaction whose handoff fails starts before the CLI's waiting turn, which follows it", async () => {
  const f = await fixture("codex", { FAKE_ACP_BG_CALL: "open", FAKE_ACP_BG_MS: "30", FAKE_ACP_BG_ANSWER_MS: "100" });
  try {
    f.delayClose("turn", 350);
    const first = f.submit("bg");
    // The completion arrives while the turn runs: its CLI turn waits for the turn's end, as the compaction does.
    await until(() => (f.service as unknown as { cliPending: Set<string> }).cliPending.has(f.session.id), "the completion to wait for the turn");
    const handOffTo = f.store.handOffTo.bind(f.store);
    let failures = 2;
    f.store.handOffTo = ((...args: Parameters<typeof handOffTo>) => {
      if (failures-- > 0) throw new Error("simulated handoff failure");
      return handOffTo(...args);
    }) as typeof handOffTo;
    assert.deepEqual(f.compactNow({ clientRequestId: "compact" }), { interrupting: first.id });
    await until(() => f.operations().length === 3 && f.operations().every(settled), "the compaction and the CLI turn");
    // The turn may already be cleaning up when the compaction is asked for: it then ends completed.
    assert.deepEqual(f.operations().slice(1).map((operation) => [operation.kind, operation.origin ?? "user", operation.state]),
      [["compact", "user", "completed"], ["turn", "cli", "completed"]]);
    assert.equal(f.store.findOperation(f.session.id, "compact")?.kind, "compact");
    assert.equal(f.prompts()[1], COMPACT_NOW);
    assert.ok(f.prompts()[2]!.endsWith(RESUME), JSON.stringify(f.prompts()));
  } finally { await f.close(); }
});

test("compact now: Stop on the turn before the compaction starts drops it", async () => {
  const f = await fixture("claude");
  try {
    const first = f.submit("wait for it");
    await until(() => f.prompts().length === 1, "the first prompt");
    assert.deepEqual(f.compactNow(), { interrupting: first.id });
    assert.equal(f.service.cancel(first.id), true);
    await until(() => settled(f.operations()[0]), "the turn to end");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(f.operations().map((operation) => [operation.kind, operation.state]), [["turn", "cancelled"]]);
    assert.deepEqual(f.prompts(), ["wait for it"]);
  } finally { await f.close(); }
});

test("compact now: Stop while the compaction's operation cleans up keeps the CLI from going on", async () => {
  const f = await fixture("claude");
  try {
    f.delayClose("compact", 1500);
    const first = f.submit("wait for it");
    await until(() => f.prompts().length === 1, "the first prompt");
    assert.deepEqual(f.compactNow(), { interrupting: first.id });
    await until(() => f.prompts().length === 2, "the compaction to be sent");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(f.operations()[1]!.state, "compacting");
    assert.equal(f.service.cancel(f.operations()[1]!.id), true);
    await until(() => settled(f.operations()[1]), "the compaction to end");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(f.operations().length, 2);
    assert.deepEqual(f.prompts(), ["wait for it", COMPACT_NOW]);
  } finally { await f.close(); }
});

test("compact now: the running agent is compacted, and a pending compaction answers its own request only", async () => {
  const f = await fixture("claude", { FAKE_ACP_COMPACT_MS: "300" });
  try {
    const first = f.submit("wait for it");
    await until(() => f.prompts().length === 1, "the first prompt");
    assert.throws(() => f.compactNow({ agentName: "other" }), (error: { code?: string }) => error.code === "agent_mismatch");
    assert.equal(f.operations()[0]!.state, "running", "a mismatched compaction stops nothing");
    assert.deepEqual(f.compactNow({ clientRequestId: "c1" }), { interrupting: first.id });
    assert.deepEqual(f.compactNow({ clientRequestId: "c1" }), { interrupting: first.id });
    assert.throws(() => f.compactNow({ clientRequestId: "c1", configPath: `${f.configPath}.other` }), (error: { code?: string }) => error.code === "conflict");
    assert.throws(() => f.compactNow({ clientRequestId: "c2" }), (error: { code?: string }) => error.code === "busy");
    await until(() => f.operations().length === 3 && settled(f.operations()[2]), "the CLI turn after the compaction");
    assert.deepEqual(f.operations().map((operation) => [operation.kind, operation.clientRequestId.startsWith("cli-") ? "cli" : operation.clientRequestId]),
      [["turn", "r1"], ["compact", "c1"], ["turn", "cli"]]);
    assert.equal(f.store.findOperation(f.session.id, "c2"), undefined);
  } finally { await f.close(); }
});

test("CLI turn: queued messages wait for it, and it runs before them", async (t) => {
  await t.test("a message sent during the CLI turn waits and starts after it", async () => {
    const f = await fixture("claude", { FAKE_ACP_BG_MS: "100", FAKE_ACP_BG_TURN: "claude", FAKE_ACP_TURN_MS: "1000" });
    try {
      assert.equal((await f.run("bg")).state, "completed");
      await until(() => f.cliOperations()[0]?.state === "running", "the CLI turn to run");
      const sent = f.enqueue("later");
      assert.ok("queued" in sent, JSON.stringify(sent));
      await until(() => f.operations().length === 3 && settled(f.operations()[2]), "the queued turn");
      assert.deepEqual(f.operations().map((operation) => [operation.origin ?? "user", operation.state]), [["user", "completed"], ["cli", "completed"], ["user", "completed"]]);
      assert.deepEqual(f.history().slice(-4), [`notice:Claude Code continues: ${NOTE}`, "assistant:Noted: Background job finished.", "user:later", "assistant:echo:later"]);
    } finally { await f.close(); }
  });
  await t.test("a Codex completion during a user turn runs after that turn and before the message queued behind it", async () => {
    const f = await fixture("codex", { FAKE_ACP_BG_CALL: "open", FAKE_ACP_BG_MS: "20", FAKE_ACP_BG_ANSWER_MS: "800" });
    try {
      const first = f.submit("bg");
      await until(() => f.prompts().length === 1, "the first prompt");
      assert.ok("queued" in f.enqueue("queued message"));
      await f.service.wait(first.id);
      await until(() => f.operations().length === 3 && settled(f.operations()[2]), "the queued turn");
      const note = 'Background command "Background job" completed (exit code 0).';
      assert.deepEqual(f.operations().map((operation) => operation.origin ?? "user"), ["user", "cli", "user"]);
      assert.deepEqual(f.prompts(), ["bg", sent(note), "queued message"]);
    } finally { await f.close(); }
  });
});

test("CLI turn: Stop on its operation stops the turn task, and the adapter closes when nothing else runs", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "100", FAKE_ACP_BG_TURN: "claude", FAKE_ACP_TURN_MS: "30000" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    await until(() => f.cliOperations()[0]?.state === "running", "the CLI turn to run");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(f.service.cancel(f.cliOperations()[0]!.id), true);
    await until(() => settled(f.cliOperations()[0]), "the CLI turn to end");
    assert.equal(f.cliOperations()[0]!.state, "cancelled");
    assert.deepEqual(f.stops(), ["task-2"]);
    await until(() => !alive(pid!), "the adapter to close");
  } finally { await f.close(); }
});

test("resident: deleting the session stops its tasks and the adapter", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    await f.service.forgetSession(f.session.id);
    assert.deepEqual(f.stops(), ["task-1"]);
    await until(() => !alive(pid!), "the adapter to close");
  } finally { await f.close(); }
});

test("resident: a changed agent profile stops the old adapter and its tasks, with a notice", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    f.writeConfig("Be someone else.");
    assert.equal((await f.run("hello")).state, "completed");
    await until(() => !alive(pid!), "the old adapter to close");
    assert.equal(f.pids().filter(alive).length, 0, "no task, no residency");
    assert.equal(f.pids().length, 2);
    assert.ok(f.history().includes("notice:Claude Code stopped 1 background task(s) because the agent changed: Background job"), JSON.stringify(f.history()));
  } finally { await f.close(); }
});

test("resident: switching the agent to Raw's own loop stops the old adapter and its tasks, with a notice", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  const model = await startMockProvider([{ frames: [openAiFrame({ content: "raw-answer" }, "stop"), openAiDone] }]);
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    writeFileSync(f.configPath, JSON.stringify({ default_agent: "ext",
      models: { fixture: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: model.url, api_key_env: "RAW_TEST_KEY" } },
      agents: { ext: { model: "fixture", tools: { use: [] } } } }));
    const operation = await f.run("hello");
    assert.equal(operation.state, "completed", JSON.stringify(operation.error));
    assert.equal(alive(pid!), false, "the old adapter stopped before the Raw turn ended");
    const history = f.history();
    assert.ok(history.includes("notice:Claude Code stopped 1 background task(s) because the agent changed: Background job"), JSON.stringify(history));
    assert.equal(history.at(-1), "assistant:raw-answer");
  } finally { await model.close(); await f.close(); }
});

test("resident: an operation cancelled while it stops the old adapter keeps the notice for the next turn", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  const model = await startMockProvider([{ frames: [openAiFrame({ content: "after-cancel" }, "stop"), openAiDone] }]);
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const old = (f.service as unknown as { residents: Map<string, { provider: { isClosed: boolean } }> }).residents.get(f.session.id)!.provider;
    writeFileSync(f.configPath, JSON.stringify({ default_agent: "ext",
      models: { fixture: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: model.url, api_key_env: "RAW_TEST_KEY" } },
      agents: { ext: { model: "fixture", tools: { use: [] } } } }));
    const switching = f.submit("switch");
    await until(() => old.isClosed, "the old adapter to start closing", 15000);
    assert.equal(f.service.cancel(switching.id), true);
    assert.equal((await f.service.wait(switching.id)).state, "cancelled");
    assert.equal((await f.run("next")).state, "completed");
    assert.ok(f.history().includes("notice:Claude Code stopped 1 background task(s) because the agent changed: Background job"), JSON.stringify(f.history()));
  } finally { await model.close(); await f.close(); }
});

test("resident: Raw's stop of the last background task succeeds and the CLI's answer to it reaches the next turn", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    assert.equal(await f.service.stopCliTask(f.session.id, "task-1"), true);
    await until(() => !alive(pid!), "the adapter to close");
    assert.equal((await f.run("next")).state, "completed");
    assert.ok(f.history().includes("notice:**Task stopped by user:** Background job"), JSON.stringify(f.history()));
  } finally { await f.close(); }
});

test("resident: closing the service waits for an adapter its running operation leaves behind", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    f.submit("wait");
    await until(() => f.operations()[1]?.state === "running" && f.prompts().length === 2, "the second turn to run");
    await f.service.close();
    assert.equal(alive(pid!), false);
  } finally { await f.close(); }
});

test("CLI turn: a session held by another process stops Claude Code's turn, with a notice on the next turn", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "500", FAKE_ACP_BG_TURN: "claude" });
  const other = openSessionStore({ env: f.storeEnv });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const owner = other.claimSession(f.session.id);
    await until(() => f.stops().length === 1, "the turn task stop");
    assert.deepEqual(f.stops(), ["task-2"]);
    assert.equal(f.cliOperations().length, 0);
    other.releaseSession(f.session.id, owner);
    assert.equal((await f.run("next")).state, "completed");
    assert.ok(f.history().some((item) => item.startsWith("notice:Claude Code started a turn after a background task, but the session was in use elsewhere; it was stopped")),
      JSON.stringify(f.history()));
  } finally { other.close(); await f.close(); }
});

test("CLI turn: Claude Code's turn after a gap is recorded once, through the fallback wake when it comes late", async (t) => {
  for (const gap of [60, 1500]) await t.test(`a turn ${gap} ms after the completion`, async () => {
    const f = await fixture("claude", { FAKE_ACP_BG_MS: "100", FAKE_ACP_BG_TURN: "claude", FAKE_ACP_TURN_GAP_MS: String(gap) });
    try {
      assert.equal((await f.run("bg")).state, "completed");
      const [pid] = f.pids();
      await until(() => settled(f.cliOperations()[0]), "the CLI turn");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal(f.cliOperations().length, 1);
      assert.equal(f.history().filter((item) => item === "assistant:Noted: Background job finished.").length, 1);
      assert.deepEqual(f.prompts(), ["bg"]);
      assert.deepEqual(f.pids(), [pid]);
      await until(() => !alive(pid!), "the adapter to close");
    } finally { await f.close(); }
  });
  for (const panel of [false, true]) await t.test(`a turn 5000 ms after it, past Raw's fallback wake${panel ? ", with a panel action between" : ""}`, async () => {
    const f = await fixture("claude", { FAKE_ACP_BG_MS: "100", FAKE_ACP_BG_TURN: "claude", FAKE_ACP_TURN_GAP_MS: "5000" });
    try {
      assert.equal((await f.run("bg")).state, "completed");
      const [pid] = f.pids();
      await until(() => settled(f.cliOperations()[0]), "the fallback wake");
      const note = 'Background command "Background job" completed.';
      assert.deepEqual(f.prompts(), ["bg", sent(note)]);
      if (panel) {
        const action = f.service.submit({ sessionId: f.session.id, clientRequestId: "panel", kind: "panel_action", agentName: "ext", configPath: f.configPath,
          action: { panel: "builtin/todo", action: "clear" } });
        await f.service.wait(action.id);
      }
      assert.ok(alive(pid!), "kept for the turn Claude Code may still take");
      await until(() => settled(f.cliOperations()[1]), "the late turn", 10000);
      assert.equal(f.history().filter((item) => item === "assistant:Noted: Background job finished.").length, 1);
      assert.deepEqual(f.pids(), [pid], "the late turn ran on the kept adapter");
      // Its turn seen, Claude Code owes nothing more: the adapter closes (Invariant 2).
      await until(() => !alive(pid!), "the adapter to close");
    } finally { await f.close(); }
  });
});

test("resident: an adapter that exits while parked loses its tasks, with a notice on the next turn and a fresh adapter", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "20000", FAKE_ACP_EXIT_AFTER_BG: "1", FAKE_ACP_EXIT_AFTER_BG_MS: "800" });
  try {
    assert.equal((await f.run("bg")).state, "completed");
    const [pid] = f.pids();
    await until(() => !alive(pid!), "the adapter exit");
    await new Promise((resolve) => setTimeout(resolve, 200));
    delete f.env.FAKE_ACP_EXIT_AFTER_BG;
    assert.equal((await f.run("hello")).state, "completed");
    assert.equal(f.pids().length, 2);
    assert.ok(f.history().includes("notice:Claude Code exited; 1 background task(s) were lost: Background job"), JSON.stringify(f.history()));
    assert.equal(f.cliOperations().length, 0);
  } finally { await f.close(); }
});

test("CLI turn: an operation whose attach fails ends in error, stops Claude Code's turn and keeps a notice", async () => {
  const f = await fixture("claude", { FAKE_ACP_BG_MS: "100", FAKE_ACP_BG_TURN: "claude", FAKE_ACP_TURN_MS: "30000" });
  try {
    f.failCliAttach(true);
    assert.equal((await f.run("bg")).state, "completed");
    await until(() => settled(f.cliOperations()[0]), "the CLI turn's operation");
    assert.equal(f.cliOperations()[0]!.state, "error");
    await until(() => f.stops().length === 1, "the turn task stop");
    assert.deepEqual(f.stops(), ["task-2"]);
    f.failCliAttach(false);
    assert.equal((await f.run("next")).state, "completed");
    assert.ok(f.history().some((item) => item.startsWith("notice:Claude Code started a turn after a background task, but Raw could not record it; it was stopped")),
      JSON.stringify(f.history()));
  } finally { await f.close(); }
});
