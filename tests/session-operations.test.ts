import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createAgent, type RunEvent } from "../src/agent.js";
import { COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import { SessionOperations, type AttachSessionRuntime } from "../src/sessions/operations.js";
import { openSessionStore } from "../src/sessions/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-operations-"));
  const options = { env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } };
  const store = openSessionStore(options);
  const session = store.createSession({ cwd: root, title: "New session" });
  const intent = { sessionId: session.id, clientRequestId: "first", kind: "turn" as const,
    input: "do it", agentName: "test", configPath: join(root, "config.json") };
  return { root, options, store, session, intent, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const modelConfig = { agentName: "test", provider: "ollama" as const, method: "openai-chat-completions" as const,
  model: "fixture", contextWindow: 8192, maxOutputTokens: 512 };

test("durable duplicate submit runs one tool once across completion and service restart", async () => {
  const f = fixture();
  const sentinel = join(f.root, "effects");
  let requests = 0;
  const provider: ProviderAdapter = { modelConfig, async generate() {
    requests++;
    return requests === 1 ? { text: "checking", toolCalls: [{ id: "write", name: "effect", arguments: {} }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" };
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "effect", description: "Effect", inputSchema: { type: "object" }, async handler() {
    appendFileSync(sentinel, "1"); return { isError: false, content: [{ type: "text", text: "ok" }] };
  } });
  const attach: AttachSessionRuntime = async ({ owner, operation }) => ({
    agent: createAgent({ provider, registry, cwd: f.root, persistence: { store: f.store, sessionId: f.session.id,
      surface: "web", owner, ownership: "host", operationId: operation.id } }), modelConfig,
    compactOptions: { keepRecentTurns: 1, maxOutputTokens: 64 }, async close() {},
  });
  const service = new SessionOperations({ store: f.store, attach });
  try {
    const first = service.submit(f.intent);
    assert.equal(service.submit(f.intent).id, first.id);
    assert.throws(() => service.submit({ ...f.intent, input: "different" }), /conflict/i);
    assert.equal((await service.wait(first.id)).state, "completed");
    assert.equal(service.submit(f.intent).id, first.id);
    await service.close();
    const second = new SessionOperations({ store: f.store, attach });
    try { assert.equal(second.submit(f.intent).id, first.id); }
    finally { await second.close(); }
    assert.equal(requests, 2);
    assert.equal(readFileSync(sentinel, "utf8"), "1");
    assert.equal(f.store.getSessionHistory({ sessionId: f.session.id }).items.filter((item) => item.kind === "user").length, 1);
    assert.equal(f.store.getOperation(first.id)?.committedUserPosition, 0);
    const owner = f.store.claimSession(f.session.id); f.store.releaseSession(f.session.id, owner);
  } finally { await service.close(); f.cleanup(); }
});

test("startup retains ownership, can be cancelled, and never consumes accepted input", async () => {
  const f = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const service = new SessionOperations({ store: f.store, attach: async ({ signal }) => {
    entered();
    return await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error("startup aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } });
  try {
    const operation = service.submit(f.intent); await started;
    const peer = openSessionStore(f.options);
    try { assert.throws(() => peer.claimSession(f.session.id), /busy/); }
    finally { peer.close(); }
    assert.equal(service.cancel(operation.id), true);
    assert.equal((await service.wait(operation.id)).state, "cancelled");
    assert.equal(f.store.getOperation(operation.id)?.committedUserPosition, undefined);
    assert.deepEqual(f.store.getSessionHistory({ sessionId: f.session.id }).items, []);
    const owner = f.store.claimSession(f.session.id); f.store.releaseSession(f.session.id, owner);
  } finally { await service.close(); f.cleanup(); }
});

test("observer errors cannot abort host-owned work; metrics reads do not attach", async () => {
  const f = fixture(); let attachments = 0;
  const provider: ProviderAdapter = { modelConfig, async generate(request) {
    request.onTextDelta?.("answer"); return { text: "answer", toolCalls: [], finishReason: "stop",
      usage: { prompt_tokens: 7, completion_tokens: 2 } };
  } };
  const service = new SessionOperations({ store: f.store, attach: async ({ owner, operation }) => {
    attachments++;
    return { agent: createAgent({ provider, cwd: f.root, persistence: { store: f.store, sessionId: f.session.id,
      surface: "web", owner, ownership: "host", operationId: operation.id } }), modelConfig, compactOptions: {}, async close() {} };
  } });
  service.subscribe(() => { throw new Error("broken network"); });
  try {
    const end = await service.wait(service.submit(f.intent).id);
    assert.equal(end.state, "completed"); assert.equal(attachments, 1);
    const metrics = f.store.getLastSessionMetrics(f.session.id)!;
    assert.equal(metrics.turn.inputTokensKnown, 7);
    assert.equal(metrics.turn.cacheReadCoverage, 0);
    assert.equal(metrics.context.contextWindow, 8192);
    assert.ok(metrics.context.estimatedTokens > 0);
    assert.equal(attachments, 1);
  } finally { await service.close(); f.cleanup(); }
});

test("manual compact exposes stable outcomes and preserves old history atomically", async () => {
  const f = fixture();
  let failSummary = false;
  const provider: ProviderAdapter = { modelConfig, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) {
      if (failSummary) throw new Error("summary unavailable");
      return { text: "remember the task", toolCalls: [], finishReason: "stop" };
    }
    return { text: "details ".repeat(500), toolCalls: [], finishReason: "stop" };
  } };
  const agent = createAgent({ provider, cwd: f.root, persistence: { store: f.store, sessionId: f.session.id, surface: "web" } });
  try {
    await agent.run("first"); await agent.run("second");
    const before = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items;
    const events: RunEvent[] = [];
    const compact = await agent.compact({ keepRecentTurns: 0 }, (event) => events.push(event));
    assert.equal(compact.status, "compacted");
    assert.ok(events.some((event) => event.type === "compact_start"));
    const history = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items;
    assert.deepEqual(history.slice(0, before.length), before);
    const marker = history.findLast((item) => item.kind === "compaction")!;
    assert.equal(marker.payload.status, "compacted");
    assert.equal(marker.payload.summary, "remember the task");
    assert.ok(Number(marker.payload.afterTokens) < Number(marker.payload.beforeTokens));
    assert.match(JSON.stringify(agent.transcript), /Conversation summary/);
    await agent.run("third");
    failSummary = true;
    const prior = agent.transcript;
    await assert.rejects(agent.compact({ keepRecentTurns: 0 }), /summary unavailable/);
    assert.deepEqual(agent.transcript, prior);
    assert.equal(f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items.at(-1)?.payload.status, "error");
  } finally { await agent.close(); f.cleanup(); }
});

test("killed process leaves an interrupted receipt and unknown side effect without replay", async () => {
  const f = fixture(); const sentinel = join(f.root, "crashed-effect");
  const worker = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/operation-worker.ts", import.meta.url)),
    f.root, f.session.id, f.intent.configPath, sentinel], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const message = await Promise.race([once(worker, "message"),
      new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("worker timed out")), 10_000); timer.unref(); })]);
    const operationId = (message[0] as { operationId: string }).operationId;
    assert.throws(() => f.store.claimSession(f.session.id), /busy/);
    const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit;
    const recovery = openSessionStore({ ...f.options, now: () => Date.now() + 30_000 });
    let attaches = 0;
    const service = new SessionOperations({ store: recovery, attach: async () => { attaches++; throw new Error("must not attach"); } });
    try {
      assert.equal(service.submit(f.intent).id, operationId);
      assert.equal((await service.wait(operationId)).state, "interrupted");
      assert.equal(attaches, 0);
      const agent = createAgent({ cwd: f.root, provider: { modelConfig, async generate() {
        return { text: "inspect first", toolCalls: [], finishReason: "stop" };
      } }, persistence: { store: recovery, sessionId: f.session.id, surface: "web" } });
      try { assert.match(JSON.stringify(agent.transcript), /outcome_unknown/); }
      finally { await agent.close(); }
      assert.equal(readFileSync(sentinel, "utf8"), "1");
    } finally { await service.close(); recovery.close(); }
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); f.cleanup(); }
});

test("first user commit consumes the receipt transactionally, including rollback and later provider error", async () => {
  for (const failCommit of [true, false]) {
    const f = fixture();
    if (failCommit) f.store.database.exec(`CREATE TRIGGER fail_user BEFORE INSERT ON history WHEN NEW.kind = 'user'
      BEGIN SELECT RAISE(ABORT, 'injected user failure'); END`);
    const service = new SessionOperations({ store: f.store, attach: async ({ owner, operation }) => ({
      agent: createAgent({ cwd: f.root, provider: { modelConfig, async generate() { throw new Error("provider failed after commit"); } },
        persistence: { store: f.store, sessionId: f.session.id, surface: "web", owner, ownership: "host", operationId: operation.id } }),
      modelConfig, compactOptions: {}, async close() {},
    }) });
    try {
      const op = await service.wait(service.submit(f.intent).id);
      assert.equal(op.state, "error");
      assert.equal(op.committedUserPosition, failCommit ? undefined : 0);
      assert.equal(f.store.getSessionHistory({ sessionId: f.session.id }).items.filter((item) => item.kind === "user").length, failCommit ? 0 : 1);
      assert.equal(service.submit(f.intent).id, op.id);
    } finally { await service.close(); f.cleanup(); }
  }
});

test("host heartbeat renews during slow startup and stale generations cannot publish", async () => {
  const f = fixture(); let finishStartup!: () => void;
  const service = new SessionOperations({ store: f.store, attach: async () => {
    await new Promise<void>((resolve) => { finishStartup = resolve; }); throw new Error("startup failed");
  } });
  try {
    const op = service.submit(f.intent);
    await new Promise((resolve) => setImmediate(resolve));
    const before = Number(f.store.database.prepare("SELECT lease_until FROM sessions WHERE id = ?").get(f.session.id)?.lease_until);
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const after = Number(f.store.database.prepare("SELECT lease_until FROM sessions WHERE id = ?").get(f.session.id)?.lease_until);
    assert.ok(after > before + 4_000);
    finishStartup(); await service.wait(op.id);
    const fresh = f.store.claimSession(f.session.id);
    assert.throws(() => f.store.updateOperation(op.id, { token: fresh.token, generation: fresh.generation - 1 }, "completed"), /ownership/);
    f.store.releaseSession(f.session.id, fresh);
  } finally { finishStartup?.(); await service.close(); f.cleanup(); }
});

test("compact replacement rollback cannot leave a success marker and rename does not extend retention", async () => {
  const f = fixture();
  const provider: ProviderAdapter = { modelConfig, async generate(request) { return {
    text: request.system === COMPACT_SYSTEM_PROMPT ? "summary" : "long ".repeat(500), toolCalls: [], finishReason: "stop",
  }; } };
  const agent = createAgent({ provider, cwd: f.root, persistence: { store: f.store, sessionId: f.session.id, surface: "web" } });
  try {
    await agent.run("one"); await agent.run("two");
    const before = agent.transcript;
    f.store.database.exec(`CREATE TRIGGER fail_context BEFORE INSERT ON model_context
      BEGIN SELECT RAISE(ABORT, 'injected context failure'); END`);
    await assert.rejects(agent.compact({ keepRecentTurns: 0 }), /injected context failure/);
    assert.deepEqual(agent.transcript, before);
    const records = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items;
    assert.equal(records.some((item) => item.kind === "compaction" && item.payload.status === "compacted"), false);
    const updatedAt = f.store.getSession(f.session.id)!.updatedAt;
    assert.equal(f.store.renameSession(f.session.id, "renamed").updatedAt, updatedAt);
    assert.equal(f.store.listSessions({ title: "nam" }).items[0]?.id, f.session.id);
  } finally { await agent.close(); f.cleanup(); }
});

test("compact no-op, non-smaller and cancellation leave context intact with distinct persisted outcomes", async () => {
  for (const expected of ["noop", "not_smaller", "cancelled"] as const) {
    const f = fixture();
    const provider: ProviderAdapter = { modelConfig, async generate(request) {
      return { text: request.system === COMPACT_SYSTEM_PROMPT ? "oversized ".repeat(2000) : "content ".repeat(300),
        toolCalls: [], finishReason: "stop" };
    } };
    const agent = createAgent({ provider, cwd: f.root, persistence: { store: f.store, sessionId: f.session.id, surface: "web" } });
    try {
      await agent.run("one"); await agent.run("two"); const before = agent.transcript;
      const result = await agent.compact({ keepRecentTurns: expected === "noop" ? 10 : 0 }, (event) => {
        if (expected === "cancelled" && event.type === "compact_start") agent.abort();
      });
      assert.equal(result.status, expected); assert.deepEqual(agent.transcript, before);
      const marker = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items.at(-1)!;
      assert.equal(marker.payload.status, expected);
      assert.equal(marker.payload.beforeTokens, marker.payload.afterTokens);
      assert.equal(marker.payload.beforeBytes, marker.payload.afterBytes);
    } finally { await agent.close(); f.cleanup(); }
  }
});

test("automatic compaction emits and persists one matching successful attempt without another user message", async () => {
  const f = fixture();
  const provider: ProviderAdapter = { modelConfig, async generate(request) {
    return { text: request.system === COMPACT_SYSTEM_PROMPT ? "summary" : "body ".repeat(400), toolCalls: [], finishReason: "stop" };
  } };
  const agent = createAgent({ provider, cwd: f.root, system: "small", compact: { triggerTokens: 800, keepRecentTurns: 1, maxOutputTokens: 64 },
    persistence: { store: f.store, sessionId: f.session.id, surface: "web" } });
  try {
    await agent.run("one"); const events: RunEvent[] = []; await agent.run("two", (event) => events.push(event));
    const end = events.find((event) => event.type === "compact_end"); assert.equal(end?.result.status, "compacted");
    const history = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items;
    const successes = history.filter((item) => item.kind === "compaction" && item.payload.status === "compacted");
    assert.equal(successes.length, 1); assert.equal(successes[0]?.payload.id, end?.details?.id);
    assert.equal(successes[0]?.payload.cause, "automatic");
    assert.equal(history.filter((item) => item.kind === "user").length, 2);
    assert.equal(f.store.getContextSummary(f.session.id).summary, "summary");
  } finally { await agent.close(); f.cleanup(); }
});
