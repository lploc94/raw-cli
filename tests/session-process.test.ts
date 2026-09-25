import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import { renderStoredHistory } from "../src/sessions/display.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const worker = fileURLToPath(new URL("./fixtures/session-worker.ts", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-session-process-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "process" }).id;
  return { root, store, id };
}
function child(mode: string, root: string, id: string, marker: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", worker, mode, root, id, marker], {
    cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, stdio: ["pipe", "pipe", "pipe"],
  });
}
async function waitFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`worker did not create ${path}`);
}
async function ready(process: ChildProcess, text: string): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker readiness timeout")), 10_000);
    process.stdout?.on("data", (part: Buffer) => { output += part.toString(); if (output.includes(text)) { clearTimeout(timer); resolve(); } });
    process.once("error", reject);
    process.once("exit", (code) => reject(new Error(`worker exited before ready: ${code}`)));
  });
}
async function stopped(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => process.once("exit", () => resolve()));
}

test("one session has one writer across processes; another session may proceed", async () => {
  const { root, store, id } = fixture();
  const second = store.createSession({ cwd: root, title: "other" }).id;
  const workerProcess = child("hold", root, id, join(root, "unused"));
  try {
    await ready(workerProcess, "READY");
    assert.throws(() => store.claimSession(id), /busy/i);
    const otherOwner = store.claimSession(second);
    store.releaseSession(second, otherOwner);
    workerProcess.kill("SIGKILL");
    await stopped(workerProcess);
    let now = Date.now() + 20_000;
    const recovery = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
    try {
      const owner = recovery.claimSession(id);
      recovery.releaseSession(id, owner);
      now++;
    } finally { recovery.close(); }
  } finally { workerProcess.kill("SIGKILL"); await stopped(workerProcess); store.close(); }
});

test("orphan sweep preserves a live writer payload staged before DB commit", async () => {
  const { root, store, id } = fixture();
  const marker = join(root, "stage.ready");
  const workerProcess = child("stage", root, id, marker);
  try {
    await waitFile(marker);
    assert.equal(store.sweepOrphans(), 0);
    writeFileSync(marker + ".go", "go");
    await stopped(workerProcess);
    assert.equal(workerProcess.exitCode, 0);
    const owner = store.claimSession(id);
    try {
      const state = store.initializeAgent(id, owner, { cwd: root, system: "system",
        modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
        toolDefinitions: [], selectedTools: [], cacheKey: "stable" });
      assert.equal(state.messages[0]?.role, "user");
      assert.equal((state.messages[0] as { content: string }).content.length, 70_000);
    } finally { store.releaseSession(id, owner); }
  } finally { workerProcess.kill("SIGKILL"); await stopped(workerProcess); store.close(); }
});

test("orphan sweep removes only an unpublished payload after its writer dies", async () => {
  const { root, store, id } = fixture();
  const marker = join(root, "stage-dead.ready");
  const workerProcess = child("stage", root, id, marker);
  try {
    await waitFile(marker);
    assert.equal(store.sweepOrphans(), 0);
    workerProcess.kill("SIGKILL");
    await stopped(workerProcess);
    assert.equal(store.sweepOrphans(), 1);
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM payloads").get()?.n, 0);
  } finally { workerProcess.kill("SIGKILL"); await stopped(workerProcess); store.close(); }
});

test("killing a side-effecting tool never dispatches it again on resume", async () => {
  const { root, store, id } = fixture();
  const marker = join(root, "side-effect.txt");
  const workerProcess = child("tool", root, id, marker);
  try {
    await waitFile(marker);
    workerProcess.kill("SIGKILL");
    await stopped(workerProcess);
    const recovery = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => Date.now() + 20_000 });
    const registry = createTestToolRegistry();
    registry.register({ name: "side_effect", description: "Side effect", inputSchema: { type: "object" },
      handler: async () => { throw new Error("historical tool dispatched"); } });
    const provider: ProviderAdapter = { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ({ text: "inspect", toolCalls: [], finishReason: "stop" }) };
    const agent = createAgent({ cwd: root, provider, registry, system: "system", persistence: { store: recovery, sessionId: id, surface: "cli" } });
    try {
      assert.equal(agent.transcript.at(-1)?.role, "tool");
      assert.equal((agent.transcript.at(-1) as { result: { code: string } }).result.code, "outcome_unknown");
      const history = recovery.getSessionHistory({ sessionId: id }).items;
      const warning = renderStoredHistory(history.find((item) => item.kind === "tool_result")!);
      assert.match(warning, /✗.*outcome_unknown/);
      assert.match(warning, /inspect the workspace before retrying/);
      assert.equal((await agent.run("what happened?")).status, "completed");
      assert.equal(readFileSync(marker, "utf8"), "x");
    } finally { await agent.close(); recovery.close(); }
  } finally { workerProcess.kill("SIGKILL"); await stopped(workerProcess); store.close(); }
});

test("a committed tool result survives a crash before the next model response", async () => {
  const { root, store, id } = fixture();
  const marker = join(root, "committed-side-effect.txt");
  const workerProcess = child("tool_done", root, id, marker);
  try {
    await waitFile(marker);
    let committed = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      committed = store.database.prepare("SELECT 1 FROM model_context WHERE session_id = ? AND payload_json LIKE '%\"role\":\"tool\"%' LIMIT 1").get(id) !== undefined;
      if (committed) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(committed, true);
    workerProcess.kill("SIGKILL");
    await stopped(workerProcess);
    const recovery = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => Date.now() + 20_000 });
    const registry = createTestToolRegistry();
    registry.register({ name: "side_effect", description: "Side effect", inputSchema: { type: "object" },
      handler: async () => { throw new Error("historical tool dispatched"); } });
    const provider: ProviderAdapter = { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ({ text: "continued", toolCalls: [], finishReason: "stop" }) };
    const agent = createAgent({ cwd: root, provider, registry, system: "system", persistence: { store: recovery, sessionId: id, surface: "cli" } });
    try {
      assert.equal(agent.transcript.at(-1)?.role, "tool");
      assert.equal((agent.transcript.at(-1) as { result: { isError: boolean } }).result.isError, false);
      assert.equal((await agent.run("next")).status, "completed");
      assert.equal(readFileSync(marker, "utf8"), "x");
    } finally { await agent.close(); recovery.close(); }
  } finally { workerProcess.kill("SIGKILL"); await stopped(workerProcess); store.close(); }
});

test("reclaim cannot unlink a same-content payload republished after its delete commits", () => {
  const { root, store: first, id } = fixture();
  const second = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const otherId = second.createSession({ cwd: root, title: "cleanup trigger" }).id;
  const owner = first.claimSession(id);
  const large = { role: "user" as const, content: "same".repeat(20_000) };
  first.initializeAgent(id, owner, { cwd: root, system: "system",
    modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    toolDefinitions: [], selectedTools: [], cacheKey: "stable" });
  try {
    first.appendAgentMessage(id, owner, large);
    (first as unknown as { reclaimUnreferencedPayloads: () => void }).reclaimUnreferencedPayloads = () => {};
    first.clearAgentContext(id, owner);
    const originalExec = second.database.exec.bind(second.database);
    let republished = false;
    second.database.exec = (sql: string) => {
      const result = originalExec(sql);
      if (sql === "COMMIT" && !republished && !second.database.prepare("SELECT 1 FROM payloads LIMIT 1").get()) {
        republished = true;
        first.appendAgentMessage(id, owner, large);
      }
      return result;
    };
    second.deleteSession(otherId);
    assert.equal(republished, true);
    assert.deepEqual(first.readAgentState(id, owner).messages, [large]);
  } finally { first.releaseSession(id, owner); first.close(); second.close(); }
});
