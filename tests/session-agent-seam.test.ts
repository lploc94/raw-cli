import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunEvent } from "../src/agent.js";
import { summarizeUsage } from "../src/llm/cache.js";
import { SessionOperations, type AttachSessionRuntime } from "../src/sessions/operations.js";
import { openSessionStore } from "../src/sessions/store.js";
import { FakeSessionAgent } from "./fixtures/fake-session-agent.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-seam-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const session = store.createSession({ cwd: root, title: "New session", agentName: "external" });
  return { root, store, session, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the host runs turns, panel actions and cancel on a session agent that is not Raw's loop", async () => {
  const f = fixture();
  const agents: FakeSessionAgent[] = [];
  const attach: AttachSessionRuntime = async () => {
    const agent = new FakeSessionAgent(); agents.push(agent);
    return { agent, async close() {}, measure: (options) => ({ measuredAt: Date.now(), elapsedMs: 0, model: "cli-model", agentName: "external",
      startedTools: options.startedTools, failedTools: options.failedTools, session: summarizeUsage([]), turn: summarizeUsage([]),
      context: { estimatedTokens: 1200, source: "provider", contextWindow: 200000, outputReserve: 0 } }) };
  };
  const service = new SessionOperations({ store: f.store, attach });
  const events: string[] = [];
  service.subscribe((event) => { if (event.type === "event") events.push((event.event as RunEvent).type); });
  const intent = { sessionId: f.session.id, kind: "turn" as const, agentName: "external", configPath: join(f.root, "c.json") };
  try {
    const turn = service.submit({ ...intent, clientRequestId: "one", input: "hello" });
    const done = await service.wait(turn.id);
    assert.equal(done.state, "completed");
    assert.equal(done.metrics?.model, "cli-model");
    assert.equal(done.metrics?.startedTools, 1);
    assert.deepEqual(events, ["tool_start", "tool_result", "text_delta", "run_end"]);
    assert.deepEqual(agents[0]!.calls, ["run:hello", "close"]);

    const panel = service.submit({ ...intent, clientRequestId: "two", kind: "panel_action",
      action: { panel: "builtin/todo/main", action: "check", item: "a" } });
    assert.equal((await service.wait(panel.id)).state, "completed");
    assert.deepEqual(agents[1]!.calls, ["panel:builtin/todo/main:check", "close"]);

    const slow = service.submit({ ...intent, clientRequestId: "three", input: "please wait" });
    while (!agents[2]?.calls.includes("run:please wait")) await new Promise((resolve) => setTimeout(resolve, 5));
    service.cancel(slow.id);
    assert.equal((await service.wait(slow.id)).state, "cancelled");
    assert.ok(agents[2]!.calls.includes("abort"));
  } finally { await service.close(); f.cleanup(); }
});

async function runSeamCli(args: string[], input: string, root: string, interrupt = false) {
  const log = join(root, "log.json");
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "fixtures", "seam-cli.ts"), ...args], {
    cwd: root, env: { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, SEAM_LOG: log, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  if (interrupt) {
    child.stdin.write(input);
    const until = Date.now() + 60000;
    while (!stderr.includes("Terminal") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdin.write("please wait\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end("after\n");
  } else child.stdin.end(input);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr, log: JSON.parse(readFileSync(log, "utf8")) as { code: number; agents: string[][]; sessions: string[] } };
}

function backendConfig(root: string): string {
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ default_agent: "ext", agents: { ext: { backend: { kind: "claude", model: "haiku" }, tools: { use: [] } } } }));
  return path;
}

test("the terminal runs a headless turn on a session agent with no Raw model config", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-seam-cli-"));
  try {
    const result = await runSeamCli([backendConfig(root), "hello"], "", root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "fake1 answered hello");
    assert.match(result.stderr, /Terminal/);
    assert.doesNotMatch(result.stderr, /budget/i);
    assert.deepEqual(result.log.agents, [["start:create", "run:hello", "close"]]);
    assert.deepEqual(result.log.sessions, ["ext"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the REPL clears into a new session and Ctrl-C cancels a turn of a session agent with no Raw model config", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-seam-repl-"));
  try {
    const result = await runSeamCli([backendConfig(root)], "first\n/clear\nsecond\n", root, true);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /conversation cleared/);
    assert.deepEqual(result.log.agents[0], ["start:create", "run:first", "close"]);
    const second = result.log.agents[1]!;
    assert.deepEqual(second.slice(0, 3), ["start:create", "run:second", "run:please wait"]);
    assert.ok(second.includes("abort"), JSON.stringify(second));
    assert.ok(second.includes("run:after"), JSON.stringify(second));
    assert.equal(result.log.sessions.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
