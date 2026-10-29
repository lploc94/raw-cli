import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionAgent } from "../src/backends/factory.js";
import type { SessionOperation } from "../src/sessions/operation-types.js";
import { attachSessionRuntimeWith } from "../src/sessions/runtime.js";
import { openSessionStore, type SessionSummary } from "../src/sessions/store.js";
import { dashboardFixture } from "./fixtures/dashboard.js";

// Real CLIs, real accounts, network: run with RAW_LIVE_BACKENDS=claude,codex,agy on a machine where they are logged in.
const LIVE = new Set((process.env.RAW_LIVE_BACKENDS ?? "").split(",").map((kind) => kind.trim()).filter(Boolean));
const RAW = join(import.meta.dirname, "..", "bin", "raw.ts");

interface Live { root: string; work: string; env: NodeJS.ProcessEnv; config: string }

function live(kind: string, backend: Record<string, unknown>, tag: string, tools: string[] = []): Live {
  const root = mkdtempSync(join(tmpdir(), `raw-live-${kind}-`));
  const work = join(root, "work");
  mkdirSync(work);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ default_agent: `${kind}-live`, agents: { [`${kind}-live`]: { backend,
    system_prompt: `You are ${tag}. Begin every reply with the exact text ${tag}. Use your own tools for file work.`, tools: { use: tools } } } }));
  // Adapters are installed into the user's data directory once, as a real first use would; sessions stay in the temp root.
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return { root, work, config, env: { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: data } };
}

function raw(target: Live, args: string[]): { stdout: string; stderr: string; status: number | null; session?: string } {
  const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), RAW, "--config", target.config, ...args],
    { cwd: target.work, env: target.env, encoding: "utf8", timeout: 300_000 });
  const session = /raw --resume (\S+)/.exec(run.stderr)?.[1];
  return { stdout: run.stdout, stderr: run.stderr, status: run.status, ...(session ? { session } : {}) };
}

function usedModels(target: Live, session: string): string[] {
  const store = openSessionStore({ env: target.env });
  try {
    const owner = store.claimSession(session);
    const state = store.readAgentState(session, owner);
    store.releaseSession(session, owner);
    return JSON.stringify(state).match(/"models":\[[^\]]*\]/g)?.flatMap((list) => JSON.parse(list.slice(9)) as string[]) ?? [];
  } finally { store.close(); }
}

/** Each backend's live case: a cheap model it lists, and how that model shows in the usage the CLI reports (agy reports none). */
const CASES: Array<{ kind: string; model: string; reported?: RegExp }> = [
  { kind: "claude", model: "haiku", reported: /haiku/i },
  { kind: "codex", model: "gpt-6-luna", reported: /luna/i },
  { kind: "agy", model: "gemini-3.8-flash-low" },
];

for (const { kind, model, reported } of CASES) {
  test(`${kind}: the agent's prompt replaces the CLI's, its own tools write the file, the chosen model runs, --continue resumes`,
    { skip: !LIVE.has(kind) && `set RAW_LIVE_BACKENDS=${kind}` }, () => {
    const tag = `RAW-TAG-${randomBytes(3).toString("hex").toUpperCase()}`;
    const target = live(kind, { kind, model }, tag);
    try {
      const first = raw(target, ["Create a file hello.txt in the current directory containing exactly: hello raw. Then reply done."]);
      assert.equal(first.status, 0, first.stderr);
      assert.ok(first.stdout.includes(tag), first.stdout);
      assert.equal(readFileSync(join(target.work, "hello.txt"), "utf8").trim(), "hello raw");
      assert.ok(first.session);
      if (reported) assert.ok(usedModels(target, first.session!).some((used) => reported.test(used)), `${model} reported by the CLI`);
      const nonce = `N-${randomBytes(4).toString("hex")}`;
      const second = raw(target, ["--continue", `Remember this code: ${nonce}. Reply only OK.`]);
      assert.equal(second.status, 0, second.stderr);
      const third = raw(target, ["--continue", "What code did I ask you to remember? Reply with the code only."]);
      assert.equal(third.status, 0, third.stderr);
      assert.ok(third.stdout.includes(nonce), third.stdout);
    } finally { rmSync(target.root, { recursive: true, force: true }); }
  });

  test(`${kind}: bridge todo: a Raw todo call from the CLI fills the session's todo panel`,
    { skip: (!LIVE.has(kind) && `set RAW_LIVE_BACKENDS=${kind}`) || (kind === "agy" && "agy gets no Raw tools (next test)") }, () => {
    const tag = `RAW-TAG-${randomBytes(3).toString("hex").toUpperCase()}`;
    const target = live(kind, { kind, model }, tag, ["builtin/todo"]);
    try {
      const started = Date.now();
      const run = raw(target, ["Use the todo tool from the raw MCP server to make a todo list with two items, alpha and beta, with alpha done. Then reply done."]);
      console.log(`${kind} bridge todo turn: ${Date.now() - started} ms`);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.session);
      const store = openSessionStore({ env: target.env });
      try {
        const panel = store.listSessionPanels(run.session!).find((item) => item.panelId === "builtin/todo#todo");
        const text = JSON.stringify(panel?.document ?? null);
        assert.match(text, /alpha/i, text);
        assert.match(text, /beta/i, text);
        const calls = store.getSessionHistory({ sessionId: run.session!, limit: 100 }).items.filter((item) => item.kind === "tool_call")
          .map((item) => (item.payload.display as { name?: string; title?: string; identity?: string } | undefined) ?? {});
        assert.deepEqual(calls.filter((call) => call.name === "todo").map((call) => call.identity), ["builtin/todo"], "shown once, as Raw's tool");
        assert.ok(!calls.some((call) => /^mcp(__|\.)raw/.test(call.name ?? "") || /^mcp\.raw\./.test(call.title ?? "")), JSON.stringify(calls));
      } finally { store.close(); }
    } finally { rmSync(target.root, { recursive: true, force: true }); }
  });
}

test("agy: bridge todo: Raw tools are unavailable with agy, the warning is shown and the turn completes",
  { skip: !LIVE.has("agy") && "set RAW_LIVE_BACKENDS=agy" }, () => {
  const tag = `RAW-TAG-${randomBytes(3).toString("hex").toUpperCase()}`;
  const target = live("agy", { kind: "agy", model: "gemini-3.8-flash-low" }, tag, ["builtin/todo"]);
  try {
    const run = raw(target, ["Reply with the single word done."]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stderr.includes('agy agent "agy-live" skips builtin/todo: Raw tools are unavailable with agy'), run.stderr);
    assert.ok(run.stdout.includes(tag), run.stdout);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

/** The plan's end-to-end check: agents `e2e-<kind>` with Raw's todo and bash selected. */
const LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", agy: "agy" };
const E2E_PROMPT = "Begin every answer with [RAW_E2E].";

function e2e(kind: string, model: string): Live {
  const target = live(kind, { kind, model }, "[RAW_E2E]");
  writeFileSync(target.config, JSON.stringify({ default_agent: `e2e-${kind}`, agents: { [`e2e-${kind}`]: { backend: { kind, model },
    system_prompt: E2E_PROMPT, tools: { use: ["builtin/todo", "builtin/bash"] } } } }));
  return target;
}

for (const { kind, model } of CASES) {
  test(`${kind}: end to end in the terminal: the bash warning once, the file edited by the CLI, the tagged answer, --continue`,
    { skip: !LIVE.has(kind) && `set RAW_LIVE_BACKENDS=${kind}` }, () => {
    const target = e2e(kind, model);
    try {
      const run = raw(target, ["--agent", `e2e-${kind}`, "Create e2e.txt containing hello world, replace world with raw, then print the file."]);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.stdout.trimStart().startsWith("[RAW_E2E]"), run.stdout);
      const warning = `${kind} agent "e2e-${kind}" skips builtin/bash: ${LABELS[kind]} uses its own shell tool`;
      assert.equal(run.stderr.split(/\r?\n/).filter((line) => line.includes(warning)).length, 1, run.stderr);
      assert.equal(readFileSync(join(target.work, "e2e.txt"), "utf8").trim(), "hello raw");
      const nonce = `N-${randomBytes(4).toString("hex")}`;
      const remember = raw(target, ["--agent", `e2e-${kind}`, `Remember the code word ${nonce}. Reply OK.`]);
      assert.equal(remember.status, 0, remember.stderr);
      const recall = raw(target, ["--agent", `e2e-${kind}`, "--continue", "What was the code word?"]);
      assert.equal(recall.status, 0, recall.stderr);
      assert.ok(recall.stdout.includes(nonce), recall.stdout);
    } finally { rmSync(target.root, { recursive: true, force: true }); }
  });
}

/** Whether a process, or (POSIX) any member of the process group it leads, is still running. */
function running(pid: number): boolean {
  for (const target of process.platform === "win32" ? [pid] : [pid, -pid]) {
    try { process.kill(target, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return true; }
  }
  return false;
}

test("claude: end to end in the dashboard: todo panel, tool calls, a cancel that stops only its own runtime",
  { skip: !LIVE.has("claude") && "set RAW_LIVE_BACKENDS=claude" }, async () => {
  const agents: Array<{ pid: number | undefined; session: string }> = [];
  const attach = attachSessionRuntimeWith((context) => {
    const agent = createSessionAgent(context);
    const entry = { get pid() { return (agent as unknown as { provider?: { pid?: number } }).provider?.pid; }, session: context.host.persistence?.sessionId ?? "" };
    agents.push(entry);
    return agent;
  });
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const f = await dashboardFixture({ env: { XDG_DATA_HOME: data }, attach, config: { default_agent: "e2e-claude" },
    extraAgents: { "e2e-claude": { backend: { kind: "claude", model: "haiku" }, system_prompt: E2E_PROMPT, tools: { use: ["builtin/todo", "builtin/bash"] } } } });
  const settle = async (id: string, ms = 300_000): Promise<SessionOperation> => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const op = await f.json<SessionOperation>(`/operations/${id}`);
      if (["completed", "max_steps", "cancelled", "error", "interrupted"].includes(op.state)) return op;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`operation ${id} did not finish`);
  };
  const turn = async (session: string, input: string) => (await f.json<SessionOperation>(`/sessions/${session}/operations`, "POST",
    { clientRequestId: randomBytes(8).toString("hex"), kind: "turn", agent: "e2e-claude", input })).id;
  const pidOf = async (session: string) => {
    for (let i = 0; i < 600; i++) { const pid = agents.filter((agent) => agent.session === session).at(-1)?.pid; if (pid) return pid; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error("the adapter did not start");
  };
  try {
    const one = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "e2e-claude" });
    const todo = await settle(await turn(one.id, "Make a todo list with two items, then mark the first done."));
    assert.equal(todo.state, "completed", JSON.stringify(todo));
    const store = openSessionStore({ env: f.env });
    try {
      const panel = store.listSessionPanels(one.id).find((item) => item.panelId === "builtin/todo#todo");
      const items = (JSON.stringify(panel?.document ?? null).match(/"status":"(done|completed|pending|in_progress)"/g) ?? []);
      assert.equal(items.length, 2, JSON.stringify(panel?.document));
      assert.match(items[0]!, /done|completed/, JSON.stringify(panel?.document));
      const calls = store.getSessionHistory({ sessionId: one.id, limit: 100 }).items.filter((item) => item.kind === "tool_call");
      assert.ok(calls.length > 0, "the chat shows Claude's tool calls");
    } finally { store.close(); }
    // A second session's turn runs while the first one's long turn is cancelled.
    const two = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "e2e-claude" });
    const other = await turn(two.id, "Run `sleep 20` with the shell, then reply done.");
    const long = await turn(one.id, "count to 100000 slowly with the shell");
    const [cancelledPid, otherPid] = await Promise.all([pidOf(one.id), pidOf(two.id)]);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const asked = Date.now();
    await f.json(`/operations/${long}/cancel`, "POST", {});
    const cancelled = await settle(long, 30_000);
    assert.equal(cancelled.state, "cancelled", JSON.stringify(cancelled));
    assert.ok(Date.now() - asked < 10_000, `cancel took ${Date.now() - asked} ms`);
    for (let i = 0; i < 50 && running(cancelledPid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(running(cancelledPid), false, "every process of the cancelled runtime is gone");
    assert.equal(running(otherPid), true, "the other session's adapter keeps running");
    assert.equal((await settle(other)).state, "completed");
    for (let i = 0; i < 50 && running(otherPid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(running(otherPid), false, "a closed runtime leaves no process");
  } finally { await f.close(); }
});
