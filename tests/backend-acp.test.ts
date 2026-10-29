import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunEvent } from "../src/agent.js";
import { AcpBackendAgent, type AcpLaunch } from "../src/backends/acp-agent.js";
import { createAcpSessionAgent, sessionIdentity } from "../src/backends/factory.js";
import { loadConfig, type RuntimeConfig } from "../src/config.js";
import { openSessionStore, type SessionStore, type SessionSummary } from "../src/sessions/store.js";
import type { UserImageBlock } from "../src/llm/types.js";
import type { ToolApprovalRequest } from "../src/tools/primitives.js";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

interface Harness {
  root: string; state: string; store: SessionStore; session: SessionSummary; runtime: RuntimeConfig; diagnostics: string[];
  agent(options?: { approve?: (request: ToolApprovalRequest) => boolean | Promise<boolean>; env?: NodeJS.ProcessEnv; runtime?: RuntimeConfig }): AcpBackendAgent;
  reopen(): void;
  pids(prefix: "adapter" | "grandchild"): number[];
  calls(): Array<Record<string, unknown>>;
  cleanup(): void;
}

async function harness(backend: Record<string, unknown> = { kind: "claude" }, agent: Record<string, unknown> = {}, fakeEnv: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "raw-backend-acp-"));
  const state = join(root, "fake");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "ext", agents: { ext: { backend, system_prompt: "Be RAW.", tools: { use: [] }, ...agent } } }));
  const runtime = await loadConfig({ configPath, env: {} });
  const storeEnv = { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root };
  let store = openSessionStore({ env: storeEnv });
  const session = store.createSession({ cwd: root, title: "New session", ...sessionIdentity(runtime) });
  const diagnostics: string[] = [];
  const h: Harness = {
    root, state, store, session, runtime, diagnostics,
    agent: (options = {}) => {
      const launch: AcpLaunch = { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ACP_STATE: state, ...fakeEnv, ...options.env } };
      const created = createAcpSessionAgent({ runtime: options.runtime ?? runtime, tools: undefined as never, cwd: root,
        host: { persistence: { store: h.store, sessionId: session.id, surface: "web" }, ...(options.approve ? { approve: options.approve } : {}) } }, launch);
      (created.provider as unknown as { config: { diagnostic: (line: string) => void } }).config.diagnostic = (line) => diagnostics.push(line);
      return created;
    },
    reopen: () => { store.close(); store = openSessionStore({ env: storeEnv }); h.store = store; },
    pids: (prefix) => { try { return readdirSync(state).filter((name) => name.startsWith(`${prefix}-`)).map((name) => Number(readFileSync(join(state, name), "utf8"))); } catch { return []; } },
    calls: () => { try { return readdirSync(state).filter((name) => name.startsWith("calls-")).sort()
      .flatMap((name) => readFileSync(join(state, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)); } catch { return []; } },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
  return h;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pids: number[], ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!pids.some(alive)) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return !pids.some(alive);
}
function collect() {
  const events: RunEvent[] = [];
  return { events, on: (event: RunEvent) => { events.push(event); }, types: () => events.map((event) => event.type) };
}
async function until(check: () => boolean, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

test("a scripted turn becomes Raw's events and history, one result per CLI tool call", async () => {
  const h = await harness();
  const agent = h.agent();
  const seen = collect();
  try {
    const result = await agent.run("tools", seen.on);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.text, "I'll run it.DONE");
    const types = seen.types();
    assert.equal(types.filter((type) => type === "run_end").length, 1);
    assert.equal(types.at(-1), "run_end");
    const starts = seen.events.filter((event) => event.type === "tool_start") as Array<Extract<RunEvent, { type: "tool_start" }>>;
    const results = seen.events.filter((event) => event.type === "tool_result") as Array<Extract<RunEvent, { type: "tool_result" }>>;
    assert.deepEqual(starts.map((event) => event.id), ["toolu_1", "exec-2", "edit-3"]);
    assert.deepEqual(results.map((event) => event.id), ["toolu_1", "exec-2", "edit-3"]);
    // The command arrives only after the call was announced with empty input.
    assert.deepEqual(starts[0]!.arguments, { command: "echo TOOL_OK_123" });
    assert.equal(starts[0]!.display?.title, "echo TOOL_OK_123");
    assert.equal(starts[0]!.display?.identity, "cli:execute/Bash");
    // The in-progress description is not the result; the completed content is.
    assert.deepEqual(results[0]!.result.content, [{ type: "text", text: "TOOL_OK_123" }]);
    assert.deepEqual(results[1]!.result, { isError: false, exitCode: 0, content: [{ type: "text", text: "written\n" }] });
    assert.equal(results[2]!.result.isError, true);
    assert.deepEqual(results[2]!.result.content, [{ type: "text", text: "Edited a.txt" }]);
    const reasoning = seen.events.filter((event) => event.type === "reasoning_delta").map((event) => (event as { text: string }).text).join("");
    assert.match(reasoning, /\[x\] run\n\[ \] write/);
    assert.match(reasoning, /thinking/);
    assert.deepEqual(h.diagnostics, ["raw: claude sent unknown update mystery_update\n"]);
    assert.equal(agent.provider.unknownUpdates.get("mystery_update"), 2);
    assert.deepEqual(agent.contextUsage(), { tokens: 26114, source: "provider", window: 1000000 });
    assert.equal(agent.stats().inputTokensKnown, 130);
    assert.equal(agent.stats().outputTokensKnown, 5);

    const history = h.store.getSessionHistory({ sessionId: h.session.id }).items.map((item) => item.kind);
    // Text before the first tool call is recorded before it, the rest after the last one.
    assert.deepEqual(history, ["user", "assistant", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result",
      "reasoning", "assistant", "run_end"]);
    const messages = agent.transcript;
    assert.deepEqual(messages, [{ role: "user", content: "tools" }, { role: "assistant", text: "I'll run it.DONE", toolCalls: [] }]);
  } finally { await agent.close(); h.cleanup(); }
});

const notices = (events: RunEvent[]) => events.filter((event) => event.type === "backend_notice").map((event) => (event as { message: string }).message);
const setCalls = (h: Harness) => h.calls().filter((call) => call.method === "session/set_config_option").map((call) => `${call.configId}=${call.value}`);
async function ask(agent: AcpBackendAgent, input: string) {
  const seen = collect();
  const result = await agent.run(input, seen.on);
  return { result, notices: notices(seen.events), text: result.text ?? "", events: seen.events };
}

test("configured options are applied in order against the list the CLI shows after each change", async () => {
  // `small` has no effort selector; `high` exists only once `big` is the model, so it is applied without a warning.
  let h = await harness({ kind: "claude", model: "big", effort: "high", mode: "auto" });
  let agent = h.agent();
  try {
    const turn = await ask(agent, "options");
    assert.deepEqual(turn.notices, []);
    assert.equal(turn.text, "model=big effort=high mode=auto");
    assert.deepEqual(setCalls(h), ["model=big", "effort=high", "mode=auto"]);
  } finally { await agent.close(); h.cleanup(); }
  // `medium` is offered by the starting model `mid` but not by `big`: it is reported and never sent.
  h = await harness({ kind: "claude", model: "big", effort: "medium" }, {}, { FAKE_ACP_MODEL: "mid" });
  agent = h.agent();
  try {
    const turn = await ask(agent, "options");
    assert.deepEqual(turn.notices, ['Claude Code does not offer effort "medium"; it keeps "low" (offered: low, high)']);
    assert.equal(turn.text, "model=big effort=low mode=ask");
    assert.deepEqual(setCalls(h), ["model=big"]);
    assert.equal(turn.result.status, "completed");
    const recorded = h.store.getSessionHistory({ sessionId: h.session.id }).items.filter((item) => item.kind === "backend_notice");
    assert.equal(recorded.length, 1);
  } finally { await agent.close(); h.cleanup(); }
  // A model the CLI does not list keeps the CLI's default and names the values it offers.
  h = await harness({ kind: "claude", model: "huge" });
  agent = h.agent();
  try {
    const turn = await ask(agent, "options");
    assert.deepEqual(turn.notices, ['Claude Code does not offer model "huge"; it keeps "small" (offered: small, big, mid)']);
    assert.equal(turn.text, "model=small effort=- mode=ask");
  } finally { await agent.close(); h.cleanup(); }
});

test("a per-turn override applies to that turn only, also after a cancelled turn and after close and reopen", async () => {
  for (const backend of [{ kind: "claude", model: "big" }, { kind: "claude" }]) {
    const baseline = backend.model ? "model=big effort=low mode=ask" : "model=small effort=- mode=ask";
    const h = await harness(backend);
    let agent = h.agent();
    try {
      agent.setTurnOverride({ model: "mid" });
      assert.equal((await ask(agent, "options")).text, "model=mid effort=low mode=ask");
      assert.equal((await ask(agent, "options")).text, baseline);
      // Cancelled while overridden: the next turn is back on the baseline.
      agent.setTurnOverride({ model: "mid", mode: "auto" });
      const waiting = agent.run("wait");
      await until(() => h.calls().some((call) => call.method === "session/prompt" && call.input === "wait"));
      agent.abort();
      assert.equal((await waiting).status, "cancelled");
      assert.equal((await ask(agent, "options")).text, baseline);
      // The fake, like the real adapters, restores the last used model on `session/load`; the baseline still wins.
      agent.setTurnOverride({ model: "mid" });
      await ask(agent, "options");
      await agent.close();
      h.reopen();
      agent = h.agent();
      assert.equal((await ask(agent, "options")).text, baseline);
      assert.ok(h.calls().some((call) => call.method === "session/load"));
    } finally { await agent.close(); h.cleanup(); }
  }
});

test("an effort override on a model whose selector the starting model lacks resets to that model's default", async () => {
  const h = await harness({ kind: "claude", model: "big" });
  let agent = h.agent();
  try {
    agent.setTurnOverride({ effort: "high" });
    assert.equal((await ask(agent, "options")).text, "model=big effort=high mode=ask");
    assert.equal((await ask(agent, "options")).text, "model=big effort=low mode=ask");
    agent.setTurnOverride({ effort: "high" });
    const waiting = agent.run("wait");
    await until(() => h.calls().filter((call) => call.method === "session/prompt" && call.input === "wait").length === 1);
    agent.abort();
    await waiting;
    assert.equal((await ask(agent, "options")).text, "model=big effort=low mode=ask");
    agent.setTurnOverride({ effort: "high" });
    await ask(agent, "options");
    await agent.close();
    h.reopen();
    agent = h.agent();
    assert.equal((await ask(agent, "options")).text, "model=big effort=low mode=ask");
    await agent.close();
    const owner = h.store.claimSession(h.session.id);
    assert.deepEqual(h.store.readExternal(h.session.id, owner)?.baseline, { model: "big", effort: "low", mode: "ask" });
    h.store.releaseSession(h.session.id, owner);
  } finally { await agent.close(); h.cleanup(); }
});

test("a reopened session continues the CLI conversation with session/load and does not record its replay", async () => {
  const h = await harness();
  let agent = h.agent();
  try {
    assert.equal((await ask(agent, "remember N-41")).text, "OK");
    await agent.close();
    h.reopen();
    agent = h.agent();
    const turn = await ask(agent, "recall");
    assert.equal(turn.text, "nonce:N-41");
    assert.deepEqual(turn.notices, []);
    assert.ok(!turn.events.some((event) => event.type === "text_delta" && event.text.includes("REPLAYED")));
    const history = h.store.getSessionHistory({ sessionId: h.session.id }).items;
    assert.ok(!JSON.stringify(history).includes("REPLAYED"));
    assert.deepEqual(h.calls().filter((call) => call.method === "session/new" || call.method === "session/load").map((call) => call.method),
      ["session/new", "session/load"]);
  } finally { await agent.close(); h.cleanup(); }
});

test("a changed profile, a lost CLI conversation or a CLI without load starts fresh with a notice", async () => {
  const h = await harness();
  let agent = h.agent();
  const fresh = "This Claude Code conversation starts here; it does not see earlier turns";
  try {
    await ask(agent, "remember N-1");
    await agent.close();
    // Another system prompt is another profile.
    agent = h.agent({ runtime: { ...h.runtime, systemPrompt: "Be someone else." } });
    let turn = await ask(agent, "recall");
    assert.equal(turn.text, "nonce:none");
    assert.deepEqual(turn.notices, [fresh]);
    await agent.close();
    // The CLI no longer has the conversation.
    agent = h.agent({ runtime: { ...h.runtime, systemPrompt: "Be someone else." } });
    for (const name of readdirSync(h.state).filter((item) => item.startsWith("session-"))) rmSync(join(h.state, name));
    turn = await ask(agent, "recall");
    assert.deepEqual(turn.notices, [fresh]);
    await agent.close();
    // A CLI that cannot load.
    agent = h.agent({ runtime: { ...h.runtime, systemPrompt: "Be someone else." }, env: { FAKE_ACP_LOAD: "0" } });
    turn = await ask(agent, "recall");
    assert.deepEqual(turn.notices, [fresh]);
  } finally { await agent.close(); h.cleanup(); }
});

test("backend, then Raw's loop, then backend: the third turn starts a fresh CLI conversation", async () => {
  const { createAgent } = await import("../src/agent.js");
  const h = await harness();
  let agent = h.agent();
  try {
    await ask(agent, "remember N-2");
    await agent.close();
    const raw = createAgent({ provider: { modelConfig: { agentName: "ext", provider: "mock", method: "openai-chat-completions", model: "m" },
      generate: async () => ({ text: "raw answer", toolCalls: [], finishReason: "stop" }) }, cwd: h.root,
      persistence: { store: h.store, sessionId: h.session.id, surface: "web" } });
    assert.equal((await raw.run("hi from raw")).text, "raw answer");
    await raw.close();
    agent = h.agent();
    const turn = await ask(agent, "recall");
    assert.equal(turn.text, "nonce:none");
    assert.deepEqual(turn.notices, ["This Claude Code conversation starts here; it does not see earlier turns"]);
  } finally { await agent.close(); h.cleanup(); }
});

test("permission requests go to Raw's approval channel, auto-allow without one, or are refused with a notice", async () => {
  const cases: Array<[string, Parameters<Harness["agent"]>[0], boolean, string, string[]]> = [
    ["approved", { approve: () => true }, true, "permission:yes", []],
    ["denied", { approve: () => false }, true, "permission:no", []],
    ["auto", {}, true, "permission:yes", []],
    ["no channel", {}, false, "permission:no", ["Claude Code asked to run rm -rf build; no approval channel"]],
  ];
  for (const [label, options, autoApprove, expected, expectedNotices] of cases) {
    const h = await harness();
    const asked: ToolApprovalRequest[] = [];
    const approve = options?.approve;
    const agent = h.agent({ ...options, ...(approve ? { approve: (request) => { asked.push(request); return approve(request); } } : {}),
      runtime: { ...h.runtime, autoApprove } });
    try {
      const turn = await ask(agent, "permission");
      assert.equal(turn.text, expected, label);
      assert.deepEqual(turn.notices, expectedNotices, label);
      if (approve) assert.deepEqual({ title: asked[0]?.title, args: asked[0]?.arguments }, { title: "rm -rf build", args: { command: "rm -rf build" } });
    } finally { await agent.close(); h.cleanup(); }
  }
});

test("cancel stops the adapter and its descendants, also when the CLI ignores the cancel", async () => {
  for (const input of ["grandchild wait", "grandchild stubborn"]) {
    const h = await harness();
    const agent = h.agent();
    try {
      const running = agent.run(input);
      await until(() => h.pids("grandchild").length === 1);
      const started = Date.now();
      assert.equal(agent.abort(), true);
      const result = await running;
      assert.equal(result.status, "cancelled", input);
      const tree = [...h.pids("adapter"), ...h.pids("grandchild")];
      assert.ok(await gone(tree), `${input}: ${tree.filter(alive).join(",")} still alive`);
      assert.ok(Date.now() - started < 8000);
      assert.equal(h.store.getSessionHistory({ sessionId: h.session.id }).items.at(-1)?.kind, "run_end");
    } finally { await agent.close(); h.cleanup(); }
  }
});

test("a crashed adapter ends the turn backend_exited with its stderr, its descendants stop, and the next turn resumes", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await ask(agent, "remember N-3");
    const turn = await ask(agent, "grandchild crash");
    assert.equal(turn.result.status, "error");
    assert.equal(turn.result.code, "backend_exited");
    assert.match(turn.result.message ?? "", /code 3.*boom/s);
    assert.ok(await gone(h.pids("grandchild")));
    assert.equal(turn.events.filter((event) => event.type === "run_end").length, 1);
    const next = await ask(agent, "recall");
    assert.equal(next.text, "nonce:N-3");
    assert.equal(h.pids("adapter").filter(alive).length, 1);
  } finally { await agent.close(); h.cleanup(); }
});

test("cancelling one session leaves another session's adapter running and its turn completes", async () => {
  const one = await harness();
  const store = one.store;
  const other = store.createSession({ cwd: one.root, title: "Other", ...sessionIdentity(one.runtime) });
  const first = one.agent();
  const launch: AcpLaunch = { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ACP_STATE: join(one.root, "fake-other") } };
  const second = createAcpSessionAgent({ runtime: one.runtime, tools: undefined as never, cwd: one.root,
    host: { persistence: { store, sessionId: other.id, surface: "web" } } }, launch);
  try {
    const cancelled = first.run("grandchild wait");
    const completing = second.run("pause 1500");
    await until(() => one.pids("grandchild").length === 1 && second.provider.pid !== undefined);
    first.abort();
    assert.equal((await cancelled).status, "cancelled");
    assert.ok(await gone([...one.pids("adapter"), ...one.pids("grandchild")]));
    assert.ok(alive(second.provider.pid!));
    const result = await completing;
    assert.equal(result.status, "completed");
    assert.equal(result.text, "paused");
  } finally { await first.close(); await second.close(); one.cleanup(); }
});

test("the inactivity watchdog ends a silent turn but never one that waits on a person", async () => {
  const h = await harness({ kind: "claude" }, { request_timeout_ms: 1000 });
  let agent = h.agent();
  try {
    const silent = await ask(agent, "silent");
    assert.equal(silent.result.status, "error");
    assert.equal(silent.result.code, "backend_unresponsive");
    assert.ok(await gone(h.pids("adapter")));
    await agent.close();
    agent = h.agent({ approve: () => new Promise((resolve) => setTimeout(() => resolve(true), 1500)) });
    const approved = await ask(agent, "permission");
    assert.equal(approved.result.status, "completed");
    assert.equal(approved.text, "permission:yes");
  } finally { await agent.close(); h.cleanup(); }
});

test("an adapter that never answers initialize ends the turn backend_start_timeout and is stopped", async () => {
  const h = await harness({ kind: "claude" }, { request_timeout_ms: 300 }, { FAKE_ACP_INIT_DELAY: "5000" });
  const agent = h.agent();
  try {
    const turn = await ask(agent, "hello");
    assert.equal(turn.result.code, "backend_start_timeout");
    assert.ok(await gone(h.pids("adapter")));
  } finally { await agent.close(); h.cleanup(); }
});

test("a message over the frame limit ends the turn backend_frame_too_large", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    const turn = await ask(agent, "huge");
    assert.equal(turn.result.code, "backend_frame_too_large");
    assert.ok(await gone(h.pids("adapter")));
  } finally { await agent.close(); h.cleanup(); }
});

test("runtime metadata keeps external through other writers and removes it on request", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await ask(agent, "hello");
    await agent.close();
    const owner = h.store.claimSession(h.session.id);
    const internals = h.store as unknown as { writeRuntimeMetadata(id: string, value: object): void; runtimeMetadata(id: string): Record<string, unknown> };
    internals.writeRuntimeMetadata(h.session.id, { replayBefore: 0, replaySignature: "s", baseSelection: ["a"] });
    internals.writeRuntimeMetadata(h.session.id, { replayBefore: 0, replaySignature: "s" });
    const kept = internals.runtimeMetadata(h.session.id);
    assert.equal(kept.baseSelection, undefined);
    assert.equal((kept.external as { kind: string }).kind, "claude");
    h.store.writeExternal(h.session.id, owner, null);
    assert.equal(h.store.readExternal(h.session.id, owner), undefined);
    assert.equal(internals.runtimeMetadata(h.session.id).replaySignature, "s");
    h.store.releaseSession(h.session.id, owner);
  } finally { await agent.close(); h.cleanup(); }
});

test("compaction and panel actions are reported as unsupported for a backend", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await assert.rejects(agent.compact(), /not supported by this backend/);
    assert.equal((await agent.runPanelAction({ panel: "builtin/todo#main", action: "check" })).code, "unsupported_backend");
  } finally { await agent.close(); h.cleanup(); }
});

test("a cancelled turn's input is not sent again, in the same runtime or a reopened one", async () => {
  const h = await harness();
  let agent = h.agent();
  const prompts = () => h.calls().filter((call) => call.method === "session/prompt").map((call) => call.input);
  try {
    for (const reopen of [false, true]) {
      const waiting = agent.run("wait");
      await until(() => prompts().filter((input) => input === "wait").length === (reopen ? 2 : 1));
      agent.abort();
      assert.equal((await waiting).status, "cancelled");
      if (reopen) { await agent.close(); h.reopen(); agent = h.agent(); }
      assert.equal((await ask(agent, "recall")).text, "nonce:none");
      assert.equal(prompts().at(-1), "recall");
    }
  } finally { await agent.close(); h.cleanup(); }
});

test("a cancelled turn's open CLI calls end before run_end, and what the CLI sends while it stops is dropped", async () => {
  const h = await harness();
  const agent = h.agent();
  const seen = collect();
  try {
    const running = agent.run("late-tool", seen.on);
    await until(() => seen.events.some((event) => event.type === "tool_start"));
    agent.abort();
    assert.equal((await running).status, "cancelled");
    const end = seen.types().indexOf("run_end");
    const results = seen.events.filter((event) => event.type === "tool_result");
    assert.equal(results.length, 1);
    assert.ok(seen.events.indexOf(results[0]!) < end);
    assert.equal((results[0] as { result: { code?: string } }).result.code, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(seen.events.length, end + 1);
    const history = h.store.getSessionHistory({ sessionId: h.session.id }).items;
    assert.equal(history.at(-1)?.kind, "run_end");
    assert.ok(!JSON.stringify(history).includes("late result"));
  } finally { await agent.close(); h.cleanup(); }
});

test("an adapter that dies between turns, or is stopped, takes its descendants with it, also those that ignore SIGTERM", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await ask(agent, "grandchild hello");
    process.kill(agent.provider.pid!, "SIGKILL");
    assert.ok(await gone(h.pids("grandchild")));
    assert.equal((await ask(agent, "hello")).result.status, "completed");
    await ask(agent, "grandchild deaf hello");
    await agent.close();
    assert.ok(await gone([...h.pids("adapter"), ...h.pids("grandchild")]));
  } finally { await agent.close(); h.cleanup(); }
  const again = await harness();
  const cancelled = again.agent();
  try {
    const running = cancelled.run("grandchild deaf wait");
    await until(() => again.pids("grandchild").length === 1);
    cancelled.abort();
    await running;
    assert.ok(await gone([...again.pids("adapter"), ...again.pids("grandchild")]));
  } finally { await cancelled.close(); again.cleanup(); }
});

test("an option the CLI changes between turns is set back to the baseline from the CLI's latest list", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await ask(agent, "change-later");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await ask(agent, "options")).text, "model=small effort=- mode=ask");
    assert.deepEqual(setCalls(h), ["mode=ask"]);
  } finally { await agent.close(); h.cleanup(); }
});

test("a CLI call's result is the content it set last, also when that came before the completed status", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    const turn = await ask(agent, "early-content");
    const result = turn.events.find((event) => event.type === "tool_result") as { result: { content: Array<{ text?: string }> } } | undefined;
    assert.equal(result?.result.content[0]?.text, "file text");
  } finally { await agent.close(); h.cleanup(); }
});

test("an image reaches a CLI that accepts images, and becomes a description with a notice for one that does not", async () => {
  const image: UserImageBlock = { type: "image", mimeType: "image/jpeg", data: readFileSync(join(import.meta.dirname, "fixtures", "vision.jpg")).toString("base64") };
  for (const accepts of [true, false]) {
    const h = await harness({ kind: "claude" }, {}, accepts ? {} : { FAKE_ACP_IMAGES: "0" });
    const agent = h.agent();
    try {
      const seen = collect();
      const result = await agent.run([{ type: "text", text: "look" }, image], seen.on);
      assert.equal(result.status, "completed", JSON.stringify(result));
      const prompt = h.calls().find((call) => call.method === "session/prompt")!;
      assert.equal(prompt.images, accepts ? 1 : 0);
      assert.deepEqual(notices(seen.events), accepts ? [] : ["Claude Code does not accept images; each is sent as a short description"]);
    } finally { await agent.close(); h.cleanup(); }
  }
});
