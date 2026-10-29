import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import { makePng } from "./fixtures/images.js";
import { startDashboard } from "../src/dashboard/server.js";
import type { HistoryView, QueuedInputView } from "../src/sessions/view.js";
import { openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import { createAgent } from "../src/agent.js";
import { COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import { compactionInput, isCompactionRequest } from "./fixtures/compaction.js";
import { createAcpSessionAgent } from "../src/backends/factory.js";
import type { BackendOffered } from "../src/backends/options.js";
import { attachSessionRuntimeWith } from "../src/sessions/runtime.js";

test("HTTP duplicate submissions execute one real Bash effect and return the saved receipt", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "effect", type: "function", function: { name: "bash",
      arguments: JSON.stringify({ command: "printf x >> effect.txt" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    assert.equal(f.provider.requests.length, 0);
    const intent = { clientRequestId: "one", kind: "turn", agent: "raw", input: "do the effect" };
    const [a, b] = await Promise.all([1, 2].map(() => f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", intent)));
    assert.equal(a!.id, b!.id); assert.equal((await f.wait(a!.id)).state, "completed");
    const duplicate = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", intent); assert.equal(duplicate.id, a!.id);
    const lookup = await f.json<SessionOperation>(`/sessions/${session.id}/operations?clientRequestId=one`); assert.equal(lookup.id, a!.id);
    assert.equal((await f.api(`/sessions/${session.id}/operations`, "POST", { ...intent, input: "different" })).status, 409);
    assert.equal(f.provider.requests.length, 2); assert.equal(readFileSync(join(f.root, "effect.txt"), "utf8"), "x");
    const measured = await f.json<{ metrics: { capabilities: { tools: string[]; skills: string[]; vars: string[] } } }>(`/sessions/${session.id}/metrics`);
    assert.deepEqual(measured.metrics.capabilities, { tools: ["builtin/bash"], skills: [], vars: [] });
    const history = await f.json<{ items: Array<{ kind: string }> }>(`/sessions/${session.id}/history`);
    assert.equal(history.items.filter((item) => item.kind === "user").length, 1);
    const originalUpdated = f.server.context.store!.getSession(session.id)!.updatedAt;
    await f.json(`/sessions/${session.id}`, "PATCH", { title: "Named session" });
    assert.equal(f.server.context.store!.getSession(session.id)!.updatedAt, originalUpdated);
    const list = await f.json<{ items: SessionSummary[] }>("/sessions?title=Named"); assert.equal(list.items[0]?.id, session.id);
  } finally { await f.close(); }
});

test("web turns see current config then stabilize and the installed CLI resumes the same ID", async () => {
  const frames = [openAiFrame({ content: "continued" }, "stop"), openAiDone];
  const f = await dashboardFixture({ responses: [{ frames }, { frames }, { frames }, { frames }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    for (const [index, prompt] of ["one", "two"].entries()) {
      if (index) { f.config.agents.raw.system_prompt = "Changed prompt"; writeFileSync(f.configPath, JSON.stringify(f.config)); }
      const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: prompt, kind: "turn", agent: "raw", input: prompt });
      assert.equal((await f.wait(op.id)).state, "completed");
    }
    const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), "--resume", session.id, "three"], { cwd: f.root, env: f.env });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    assert.equal(code, 0, stderr);
    const back = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "back-to-web", kind: "turn", agent: "raw", input: "four" });
    assert.equal((await f.wait(back.id)).state, "completed");
    const requests = f.provider.requests.map((entry) => entry.body as { messages: Array<{ role: string; content: string }>; prompt_cache_key: string });
    assert.notEqual(requests[0]?.prompt_cache_key, requests[1]?.prompt_cache_key);
    assert.equal(requests[1]?.prompt_cache_key, requests[2]?.prompt_cache_key);
    assert.equal(requests[2]?.prompt_cache_key, requests[3]?.prompt_cache_key);
    assert.equal(requests[1]?.messages[0]?.content, "Changed prompt");
    assert.deepEqual(requests[2]?.messages.slice(0, requests[1]!.messages.length), requests[1]?.messages);
    assert.ok((await f.json<{ session: SessionSummary }>(`/sessions/${session.id}`)).session.id === session.id);
  } finally { await f.close(); }
});

test("foreign writer remains readable and cannot be deleted or run through this host", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const owner = f.server.context.store!.claimSession(session.id);
    try {
      assert.equal((await f.json<{ ownership: string }>(`/sessions/${session.id}`)).ownership, "elsewhere");
      assert.equal((await f.api(`/sessions/${session.id}`, "DELETE")).status, 409);
      assert.equal((await f.api(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "busy", kind: "turn", agent: "raw", input: "go" })).status, 409);
      assert.equal(f.provider.requests.length, 0);
    } finally { f.server.context.store!.releaseSession(session.id, owner); }
    assert.equal((await f.api(`/sessions/${session.id}`, "DELETE")).status, 200);
  } finally { await f.close(); }
});

test("history keysets split tool pairs without losing identity and metrics reads never start a runtime", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    assert.deepEqual(await f.json(`/sessions/${session.id}/metrics`), { metrics: null, metricsStale: false });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "metrics", kind: "turn", agent: "raw", input: "hello" });
    await f.wait(op.id);
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.metricsStale, false); assert.equal(snapshot.metrics?.context.contextWindow, 8192);
    assert.ok(snapshot.metrics!.context.percentage! > 0); assert.equal(snapshot.metrics!.turn.cacheReadCoverage, 0);
    f.server.context.store!.appendHistory({ sessionId: session.id, kind: "tool_call", payload: { display: { id: "past", name: "old", started: true, arguments: {} } } });
    f.server.context.store!.appendHistory({ sessionId: session.id, kind: "tool_result", payload: { update: { toolCallId: "past", status: "failed", rawOutput: { code: "outcome_unknown", preview: "inspect" } } } });
    const newest = await f.json<{ items: Array<{ callId: string; toolState: string }>; nextCursor: string }>(`/sessions/${session.id}/history?limit=1`);
    const previous = await f.json<{ items: Array<{ callId: string }> }>(`/sessions/${session.id}/history?limit=1&before=${encodeURIComponent(newest.nextCursor)}`);
    assert.equal(newest.items[0]?.callId, previous.items[0]?.callId); assert.equal(newest.items[0]?.toolState, "outcome_unknown");
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).metricsStale, true);
    assert.equal((await f.api(`/sessions/${session.id}/history?limit=101`)).status, 400);
    assert.equal((await f.api(`/sessions/${session.id}/history?before=garbage`)).status, 400);
    assert.equal(f.provider.requests.length, 1);
  } finally { await f.close(); }
});

test("manual compaction preserves history, summary and failure rollback through HTTP", async () => {
  const long = "details ".repeat(300);
  const f = await dashboardFixture({ agent: { compact: { keep_recent_turns: 0, keep_recent_tokens: 1, max_output_tokens: 64 } }, responses: [
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "remember task" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { status: 500, body: { error: { message: "summary unavailable" } } },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const run = async (kind: "turn" | "compact", key: string) => f.wait((await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) })).id);
    await run("turn", "one"); await run("turn", "again"); const compact = await run("compact", "compact"); assert.equal(compact.result?.status, "compacted", JSON.stringify(compact));
    let snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.context.summary, "remember task"); assert.ok(snapshot.history.items.some((item) => item.text === long));
    const successes = snapshot.history.items.filter((item) => item.compaction?.status === "compacted"); assert.equal(successes.length, 1);
    await run("turn", "two"); const before = f.server.context.store!.getContextSummary(session.id);
    assert.equal((await run("compact", "failure")).state, "error");
    assert.deepEqual(f.server.context.store!.getContextSummary(session.id), before);
    snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.history.items.filter((item) => item.compaction?.status === "compacted").length, 1);
    assert.ok(snapshot.history.items.some((item) => item.compaction?.status === "error"));
  } finally { await f.close(); }
});

test("automatic compaction and manual no-op have distinct persisted outcomes", async () => {
  const f = await dashboardFixture({ agent: { compact: { trigger_tokens: 800, keep_recent_turns: 1, keep_recent_tokens: 1, max_output_tokens: 64 } }, responses: [
    { frames: [openAiFrame({ content: "body ".repeat(400) }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "summary" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "end" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const run = async (kind: "turn" | "compact", key: string) => f.wait((await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) })).id);
    assert.equal((await run("compact", "empty")).result?.status, "noop");
    await run("turn", "one"); await run("turn", "two");
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    const success = snapshot.history.items.filter((item) => item.compaction?.status === "compacted");
    assert.equal(success.length, 1); assert.equal(success[0]?.compaction?.cause, "automatic");
    assert.equal(snapshot.context.summary, "summary"); assert.equal(snapshot.history.items.filter((item) => item.kind === "user").length, 2);
  } finally { await f.close(); }
});

for (const target of ["startup", "provider", "compact"] as const) test(`HTTP Stop cancels ${target} and releases ownership`, async () => {
  let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
  const modelConfig = { agentName: "raw", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" };
  const stopped = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Error("stopped")); signal?.addEventListener("abort", stop, { once: true });
    entered(); if (signal?.aborted) stop();
  });
  const f = await dashboardFixture({ attach: async ({ store, session, owner, operation, signal }) => {
    if (target === "startup") return stopped(signal);
    return { modelConfig, compactOptions: { keepRecentTurns: 0, keepRecentTokens: 1 }, async close() {},
      agent: createAgent({ cwd: session.cwd, provider: { modelConfig, async generate(request) {
        if (target === "provider" || isCompactionRequest(request)) return stopped(request.signal);
        return { text: "details ".repeat(300), toolCalls: [], finishReason: "stop" };
      } }, persistence: { store, sessionId: session.id, owner, surface: "web", ownership: "host", operationId: operation.id } }),
    };
  } });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const submit = (key: string, kind: string) => f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) });
    if (target === "compact") { await f.wait((await submit("seed", "turn")).id); await f.wait((await submit("seed2", "turn")).id); }
    const before = f.server.context.store!.getContextSummary(session.id);
    const op = await submit("stop", target === "compact" ? "compact" : "turn"); await ready;
    await f.json(`/operations/${op.id}/cancel`, "POST"); assert.equal((await f.wait(op.id)).state, "cancelled");
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`); assert.equal(snapshot.ownership, "idle");
    if (target === "compact") assert.deepEqual(snapshot.context, before);
    if (target === "startup") assert.equal(snapshot.history.items.length, 0);
  } finally { await f.close(); }
});

test("HTTP Stop interrupts a real Bash child while another tab can still observe the terminal receipt", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [{ frames: [openAiFrame({ tool_calls: [
    { index: 0, id: "sleep", type: "function", function: { name: "bash", arguments: '{"command":"sleep 30"}' } },
  ] }, "tool_calls"), openAiDone] }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "tool-stop", kind: "turn", agent: "raw", input: "wait" });
    for (let i = 0; i < 200; i++) {
      if ((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).history.items.some((item) => item.toolCall?.started)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await f.json(`/operations/${op.id}/cancel`, "POST"); assert.equal((await f.wait(op.id)).state, "cancelled");
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).ownership, "idle");
  } finally { await f.close(); }
});

test("HTTP Stop during actual MCP initialization terminates its child before consuming input", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["mcp/slow/tool"] } } });
  const marker = join(f.root, "mcp.pid");
  Object.assign(f.config, { mcp: { servers: { slow: { transport: "stdio", command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.stdin.resume();setInterval(()=>{},1000)", marker] } } } });
  writeFileSync(f.configPath, JSON.stringify(f.config));
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "mcp-stop", kind: "turn", agent: "raw", input: "pending input" });
    // Up to 10 s for the server to start on a loaded machine; the file can exist before its pid is written.
    await until(() => existsSync(marker) && readFileSync(marker, "utf8").trim().length > 0, "the MCP server to start");
    const pid = Number(readFileSync(marker, "utf8"));
    await f.json(`/operations/${op.id}/cancel`, "POST"); const end = await f.wait(op.id);
    assert.equal(end.state, "cancelled"); assert.equal(end.committedUserPosition, undefined);
    assert.throws(() => process.kill(pid, 0)); assert.equal(f.provider.requests.length, 0);
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).ownership, "idle");
  } finally { await f.close(); }
});

test("an expired dead writer does not permanently block deleting an idle session", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    f.server.context.store!.database.prepare("UPDATE sessions SET owner_token = ?, lease_until = 0 WHERE id = ?")
      .run("99999999-abandoned", session.id);
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).ownership, "idle");
    assert.equal((await f.api(`/sessions/${session.id}`, "DELETE")).status, 200);
    assert.equal((await f.api(`/sessions/${session.id}`)).status, 404);
    assert.equal(f.provider.requests.length, 0);
  } finally { await f.close(); }
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
type InputReply = { operation?: SessionOperation; queued?: QueuedInputView; delivered?: { operationId: string; historySequence: number } };

test("POST /inputs starts a turn when idle, queues while it runs and resolves every replay", async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { gate: held, frames: [openAiFrame({ tool_calls: [{ index: 0, id: "effect", type: "function", function: { name: "bash",
      arguments: JSON.stringify({ command: "printf x" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const inputs = `/sessions/${session.id}/inputs`;
    const stream = await eventStream(f.server, session.id);
    try {
      assert.equal((await stream.next()).type, "snapshot");
      const started = await f.json<InputReply>(inputs, "POST", { clientRequestId: "first", agent: "raw", input: "start", mode: "queue" });
      assert.ok(started.operation && !started.queued);
      await until(() => f.provider.requests.length === 1, "the first request");
      const uploaded = await fetch(`${f.server.url}/api/sessions/${session.id}/attachments`, { method: "POST", body: new Uint8Array(makePng()),
        headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "image/png", "X-Raw-Filename": "shot.png" } });
      const { id: staged } = await uploaded.json() as { id: string };
      const body = { clientRequestId: "later", agent: "raw", input: "queued text", attachments: [staged], mode: "queue" };
      const queued = await f.json<InputReply>(inputs, "POST", body);
      assert.equal(queued.queued?.state, "queued"); assert.deepEqual(queued.queued?.attachments?.map((item) => item.name), ["shot.png"]);
      for (;;) {
        const event = await stream.next();
        if (event.type !== "inputs") continue;
        assert.deepEqual((event.data.items as QueuedInputView[]).map((item) => [item.clientRequestId, item.state]), [["later", "queued"]]);
        break;
      }
      // The staged image now belongs to the queued message; a replay never reads staging again.
      assert.equal((await f.json<InputReply>(inputs, "POST", body)).queued?.id, queued.queued!.id);
      assert.equal((await f.api(inputs, "POST", { ...body, input: "different" })).status, 409);
      release();
      assert.equal((await f.wait(started.operation!.id)).state, "completed");
      const messages = (f.provider.requests[1]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
      assert.deepEqual(messages.slice(-2).map((message) => message.role), ["tool", "user"]);
      assert.match(JSON.stringify(messages.at(-1)!.content), /queued text/);
      const delivered = await f.json<InputReply>(inputs, "POST", body);
      assert.equal(delivered.delivered?.operationId, started.operation!.id);
      const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
      const record = history.items.find((item) => item.kind === "user" && item.text === "queued text")!;
      assert.equal(delivered.delivered?.historySequence, record.sequence); assert.equal(record.queued, true);
      assert.deepEqual(await f.json(`${inputs}?clientRequestId=later`), delivered);
      assert.equal((await f.json<InputReply>(`${inputs}?clientRequestId=first`)).operation?.id, started.operation!.id);
      assert.equal((await f.api(`${inputs}?clientRequestId=unknown`)).status, 404);
      const refused = await f.api(`${inputs}/${queued.queued!.id}`, "DELETE");
      assert.equal(refused.status, 409); assert.equal((await refused.json() as { error: { code: string } }).error.code, "already_sent");
      assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs, []);
      assert.equal(f.provider.requests.length, 2);
    } finally { stream.close(); }
  } finally { await f.close(); }
});

test("leftover messages start the next turn; after Stop they wait, paused, and can be deleted", async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await dashboardFixture({ responses: [
    { gate: held, frames: [openAiFrame({ content: "first answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "second answer" }, "stop"), openAiDone] },
    { hold: true },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const inputs = `/sessions/${session.id}/inputs`;
    const send = (key: string, input: string) => f.json<InputReply>(inputs, "POST", { clientRequestId: key, agent: "raw", input, mode: "queue" });
    const first = await send("a", "first");
    await until(() => f.provider.requests.length === 1, "the first request");
    assert.ok((await send("b", "second")).queued);
    release();
    assert.equal((await f.wait(first.operation!.id)).state, "completed");
    let next: SessionOperation | undefined;
    await until(async () => { const response = await f.api(`/sessions/${session.id}/operations?clientRequestId=b`);
      if (response.ok) next = await response.json() as SessionOperation; return !!next; }, "the next turn");
    assert.equal((await f.wait(next!.id)).state, "completed");
    const messages = (f.provider.requests[1]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    assert.deepEqual([messages.at(-1)?.role, messages.at(-1)?.content], ["user", "second"]);
    assert.equal((await send("b", "second")).operation?.id, next!.id);
    const third = await send("c", "third");
    await until(() => f.provider.requests.length === 3, "the third request");
    const waiting = await send("d", "fourth");
    await f.json(`/operations/${third.operation!.id}/cancel`, "POST");
    assert.equal((await f.wait(third.operation!.id)).state, "cancelled");
    assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs.map((item) => [item.clientRequestId, item.state]), [["d", "paused"]]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(f.provider.requests.length, 3);
    assert.equal((await f.api(`/sessions/${session.id}/operations?clientRequestId=d`)).status, 404);
    assert.equal((await f.api(`${inputs}/${waiting.queued!.id}`, "DELETE")).status, 204);
    assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs, []);
    assert.equal((await f.api(`${inputs}/unknown`, "DELETE")).status, 404);
  } finally { await f.close(); }
});

test("a session queues at most 20 messages, and a session owned elsewhere queues none", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const send = (key: string) => f.api(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: key, agent: "raw", input: key, mode: "queue" });
    const running = await (await send("run")).json() as InputReply;
    await until(() => f.provider.requests.length === 1, "the request");
    for (let index = 0; index < 20; index++) assert.equal((await send(`q${index}`)).status, 202);
    const full = await send("q20");
    assert.equal(full.status, 409); assert.equal((await full.json() as { error: { code: string } }).error.code, "queue_full");
    await f.json(`/operations/${running.operation!.id}/cancel`, "POST"); await f.wait(running.operation!.id);
    const owner = f.server.context.store!.claimSession(session.id);
    try {
      const busy = await send("elsewhere");
      assert.equal(busy.status, 409); assert.equal((await busy.json() as { error: { code: string } }).error.code, "busy");
    } finally { f.server.context.store!.releaseSession(session.id, owner); }
  } finally { await f.close(); }
});

test("after a restart, 201 delivered messages still resolve their replays and waiting ones are listed paused", async () => {
  const f = await dashboardFixture();
  let restarted: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const store = f.server.context.store!; const owner = store.claimSession(session.id);
    const intent = (key: string) => ({ sessionId: session.id, clientRequestId: key, kind: "turn" as const, agentName: "raw",
      configPath: f.configPath, input: `message ${key}`, mode: "queue" as const });
    for (let index = 0; index < 201; index++) {
      store.enqueueInput(session.id, owner, intent(`m${index}`));
      const claimed = store.claimQueuedInput(session.id, owner)!;
      store.appendAgentMessage(session.id, owner, { role: "user", content: claimed.input }, {},
        [{ kind: "user", payload: { input: claimed.input, queued: true } }], undefined, undefined, undefined, { id: claimed.id, operationId: "op" });
    }
    store.enqueueInput(session.id, owner, intent("open"));
    store.releaseSession(session.id, owner);
    await f.server.close();
    restarted = await startDashboard({ port: 0, cwd: f.root, configPath: f.configPath, env: f.env });
    const api = (path: string, method = "GET", body?: unknown) => fetch(`${restarted!.url}/api${path}`, { method,
      headers: { Authorization: `Bearer ${restarted!.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const replay = await api(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "m0", agent: "raw", input: "message m0", attachments: ["consumed"], mode: "queue" });
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { delivered: { operationId: "op", historySequence: 1 } });
    const snapshot = await (await api(`/sessions/${session.id}`)).json() as SessionSnapshot;
    assert.deepEqual(snapshot.inputs.map((item) => [item.clientRequestId, item.state]), [["open", "paused"]]);
    const waiting = await api(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "open", agent: "raw", input: "message open", attachments: ["consumed"], mode: "queue" });
    assert.equal(((await waiting.json()) as InputReply).queued?.state, "paused");
    assert.equal(f.provider.requests.length, 0);
    assert.equal(restarted.context.store!.historyWatermark(session.id), 201);
  } finally { await restarted?.close(); await f.close(); }
});

const operationFor = async (f: Awaited<ReturnType<typeof dashboardFixture>>, sessionId: string, key: string) => {
  let found: SessionOperation | undefined;
  await until(async () => { const response = await f.api(`/sessions/${sessionId}/operations?clientRequestId=${key}`);
    if (response.ok) found = await response.json() as SessionOperation; return !!found; }, `the turn of ${key}`);
  return found!;
};

test("an interrupt during a Bash sleep ends its process at once and starts the message as the next turn", async () => {
  // In Git Bash `$$` is an MSYS process id; /proc/$$/winpid holds the Windows one that process.kill checks.
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "sleep", type: "function", function: { name: "bash",
      arguments: JSON.stringify({ command: "(cat /proc/$$/winpid 2>/dev/null || echo $$) > sleep.pid; sleep 30" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "changed course" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const first = await f.json<InputReply>(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "first", agent: "raw", input: "wait", mode: "queue" });
    const marker = join(f.root, "sleep.pid");
    await until(() => existsSync(marker) && readFileSync(marker, "utf8").trim().length > 0, "the sleep to start");
    const pid = Number(readFileSync(marker, "utf8"));
    const startedAt = Date.now();
    const sent = await f.json<InputReply>(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "now", agent: "raw", input: "do this instead", mode: "interrupt" });
    assert.equal(sent.queued?.mode, "interrupt");
    assert.equal((await f.wait(first.operation!.id)).state, "cancelled");
    assert.ok(Date.now() - startedAt < 10000, `interrupt took ${Date.now() - startedAt} ms`);
    assert.throws(() => process.kill(pid, 0));
    const next = await operationFor(f, session.id, "now");
    assert.equal((await f.wait(next.id)).state, "completed");
    const messages = (f.provider.requests[1]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    assert.deepEqual(messages.slice(-3).map((message) => message.role), ["assistant", "tool", "user"]);
    assert.equal(messages.at(-1)?.content, "do this instead");
  } finally { await f.close(); }
});

test("an interrupt while the answer streams leaves the partial answer out of the next request", async () => {
  const pieces = Array.from({ length: 40 }, (_, index) => openAiFrame({ content: `partial${index} ` }));
  const f = await dashboardFixture({ responses: [
    { frames: [...pieces, openAiFrame({ content: "end" }, "stop"), openAiDone], frameDelayMs: 50 },
    { frames: [openAiFrame({ content: "fresh" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const first = await f.json<InputReply>(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "first", agent: "raw", input: "write", mode: "queue" });
    await until(async () => (await f.json<SessionSnapshot>(`/sessions/${session.id}`)).live.some((item) => item.text.includes("partial2")), "the answer to stream");
    await f.json(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "now", agent: "raw", input: "stop and listen", mode: "interrupt" });
    assert.equal((await f.wait(first.operation!.id)).state, "cancelled");
    assert.equal((await f.wait((await operationFor(f, session.id, "now")).id)).state, "completed");
    const body = JSON.stringify(f.provider.requests[1]!.body);
    assert.doesNotMatch(body, /partial/);
    assert.match(body, /stop and listen/);
  } finally { await f.close(); }
});

test("an interrupt with an approval pending cancels the approval and starts the new turn", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"], rules: [{ match: "builtin/bash", effect: "ask" }] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "pending", type: "function", function: { name: "bash", arguments: '{"command":"printf never"}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "new turn" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const first = await f.json<InputReply>(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "first", agent: "raw", input: "go", mode: "queue" });
    let pending: { id: string; callId: string } | undefined;
    await until(async () => { pending = (await f.json<{ approvals: Array<{ id: string; callId: string }> }>("/activity")).approvals[0]; return !!pending; }, "the approval");
    await f.json(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "now", agent: "raw", input: "never mind", mode: "interrupt" });
    assert.equal((await f.wait(first.operation!.id)).state, "cancelled");
    assert.equal((await f.api(`/permissions/${pending!.id}`, "POST", { operationId: first.operation!.id, callId: pending!.callId, allow: true })).status, 409);
    assert.equal((await f.wait((await operationFor(f, session.id, "now")).id)).state, "completed");
    const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
    assert.ok(history.items.some((item) => item.toolResult?.code === "aborted"));
    assert.ok(!existsSync(join(f.root, "never")));
  } finally { await f.close(); }
});

test("POST send-now starts a paused message and answers already_sent for a message already sent", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }, { frames: [openAiFrame({ content: "sent now" }, "stop"), openAiDone] }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const inputs = `/sessions/${session.id}/inputs`;
    const first = await f.json<InputReply>(inputs, "POST", { clientRequestId: "first", agent: "raw", input: "go", mode: "queue" });
    await until(() => f.provider.requests.length === 1, "the request");
    const waiting = await f.json<InputReply>(inputs, "POST", { clientRequestId: "later", agent: "raw", input: "later", mode: "queue" });
    await f.json(`/operations/${first.operation!.id}/cancel`, "POST"); await f.wait(first.operation!.id);
    const started = await f.api(`${inputs}/${waiting.queued!.id}/send-now`, "POST", {});
    assert.equal(started.status, 202);
    const operation = (await started.json() as InputReply).operation!;
    assert.equal(operation.clientRequestId, "later");
    assert.equal((await f.wait(operation.id)).state, "completed");
    const again = await f.api(`${inputs}/${waiting.queued!.id}/send-now`, "POST", {});
    assert.equal(again.status, 409); assert.equal((await again.json() as { error: { code: string } }).error.code, "already_sent");
  } finally { await f.close(); }
});

test("POST edit takes a waiting message back with its workspace files and its images staged again", async () => {
  const f = await dashboardFixture({ model: { vision: true }, responses: [{ hold: true }] });
  try {
    writeFileSync(join(f.root, "notes.md"), "# Notes");
    const png = makePng();
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const inputs = `/sessions/${session.id}/inputs`;
    await f.json<InputReply>(inputs, "POST", { clientRequestId: "first", agent: "raw", input: "go", mode: "queue" });
    await until(() => f.provider.requests.length === 1, "the request");
    const stage = async () => {
      const response = await fetch(`${f.server.url}/api/sessions/${session.id}/attachments`, { method: "POST", body: new Uint8Array(png),
        headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "image/png", "X-Raw-Filename": "shot.png" } });
      return (await response.json() as { id: string }).id;
    };
    const waiting = await f.json<InputReply>(inputs, "POST", { clientRequestId: "later", agent: "raw", input: "Review for typos",
      files: ["notes.md"], attachments: [await stage()], mode: "queue" });
    assert.equal(f.server.context.attachments!.size(), 0);
    const back = await f.json<{ input: string; files: string[]; attachments: Array<{ id: string; name: string; mimeType: string; byteSize: number }> }>(
      `${inputs}/${waiting.queued!.id}/edit`, "POST", {});
    assert.equal(back.input, "Review for typos");
    assert.deepEqual(back.files, ["notes.md"]);
    assert.deepEqual(back.attachments.map((item) => [item.name, item.mimeType, item.byteSize]), [["shot.png", "image/png", png.length]]);
    // The image is staged again under a new id, so sending the message again attaches the same bytes.
    assert.equal(f.server.context.attachments!.size(), 1);
    // The composer keeps its own copy of the bytes, read back from staging.
    const read = await fetch(`${f.server.url}/api/sessions/${session.id}/attachments/${back.attachments[0]!.id}`, { headers: { Authorization: `Bearer ${f.server.token}` } });
    assert.equal(read.status, 200); assert.equal(read.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), png);
    assert.equal(f.server.context.attachments!.size(), 1);
    const other = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    assert.equal((await f.api(`/sessions/${other.id}/attachments/${back.attachments[0]!.id}`)).status, 404);
    assert.equal((await f.api(`/sessions/${session.id}/attachments/unknown`)).status, 404);
    assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs, []);
    const again = await f.api(`${inputs}/${waiting.queued!.id}/edit`, "POST", {});
    assert.equal(again.status, 409); assert.equal((await again.json() as { error: { code: string } }).error.code, "deleted");
    const resent = await f.json<InputReply>(inputs, "POST", { clientRequestId: "resent", agent: "raw", input: back.input, files: back.files,
      attachments: back.attachments.map((item) => item.id), mode: "queue" });
    assert.deepEqual(resent.queued?.attachments?.map((item) => [item.kind, item.name]), [["file", "notes.md"], ["image", "shot.png"]]);
    // A message the agent took is not edited; nothing is staged for it.
    const row = f.server.context.store!.findQueuedInput(session.id, "resent")!;
    f.server.context.store!["database"].prepare("UPDATE session_queued_inputs SET state = 'delivering' WHERE id = ?").run(row.id);
    const taken = await f.api(`${inputs}/${row.id}/edit`, "POST", {});
    assert.equal(taken.status, 409); assert.equal((await taken.json() as { error: { code: string } }).error.code, "already_sent");
    assert.equal(f.server.context.attachments!.size(), 0);
    assert.equal((await f.api(`${inputs}/unknown/edit`, "POST", {})).status, 404);
  } finally { await f.close(); }
});

test("POST edit leaves the message waiting when its images cannot be staged again", async () => {
  const f = await dashboardFixture({ model: { vision: true }, responses: [{ hold: true }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const inputs = `/sessions/${session.id}/inputs`;
    await f.json<InputReply>(inputs, "POST", { clientRequestId: "first", agent: "raw", input: "go", mode: "queue" });
    await until(() => f.provider.requests.length === 1, "the request");
    const stage = async () => {
      const response = await fetch(`${f.server.url}/api/sessions/${session.id}/attachments`, { method: "POST", body: new Uint8Array(makePng()),
        headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "image/png", "X-Raw-Filename": "shot.png" } });
      return (await response.json() as { id: string }).id;
    };
    const waiting = await f.json<InputReply>(inputs, "POST", { clientRequestId: "later", agent: "raw", input: "look", attachments: [await stage()], mode: "queue" });
    // The composer already holds as many staged items as a chat may.
    for (let index = 0; index < 8; index++) await stage();
    const refused = await f.api(`${inputs}/${waiting.queued!.id}/edit`, "POST", {});
    assert.equal(refused.status, 413);
    assert.equal(f.server.context.attachments!.size(), 8);
    assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs.map((item) => [item.clientRequestId, item.state]), [["later", "queued"]]);
  } finally { await f.close(); }
});

const FAKE_ACP = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");
/** The dashboard's real host runtime, with the scripted ACP agent standing in for the backend CLI. */
const scriptedBackend = attachSessionRuntimeWith((context) => createAcpSessionAgent(context,
  { command: process.execPath, args: [FAKE_ACP], env: { ...process.env, FAKE_ACP_STATE: join(context.cwd, "fake-acp") } }));
/** Model names as long as the CLIs list them (`gpt-6.1-terra`, Claude's dated ids). */
const LISTED: BackendOffered = {
  model: { current: "claude-sonnet-4-6-20260915", options: [{ value: "claude-sonnet-4-6-20260915", label: "Claude Sonnet 4.6 (September 2026)" },
    { value: "gpt-6.1-terra", label: "gpt-6.1-terra", hint: "Frontier agentic coding model." }] },
  effort: { options: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
  mode: { current: "default", options: [{ value: "default", label: "Default" }, { value: "plan", label: "Plan" }] },
};

test("a backend agent's composer offers what the CLI offers as selects, and says so when the CLI cannot be asked", async () => {
  let failing = false;
  const f = await dashboardFixture({ extraAgents: { ext: { backend: { kind: "claude" }, system_prompt: "Be RAW.", tools: { use: [] } } },
    discoverBackend: async () => failing ? { offered: {}, warning: "Claude Code could not start: not logged in" } : { offered: structuredClone(LISTED) } });
  try {
    const meta = await f.json<{ backend?: { kind: string; label: string }; controls: unknown[] }>("/agents/ext/composer");
    assert.deepEqual(meta.backend, { kind: "claude", label: "Claude Code" });
    assert.deepEqual(meta.controls, []);
    const offered = await f.json<{ controls: Array<{ id: string; kind: string; current?: string; options: Array<{ value: string }> }>; warning?: string }>("/agents/ext/backend-options");
    assert.deepEqual(offered.controls.map((control) => [control.id, control.kind, control.current, control.options.map((option) => option.value)]), [
      ["backend_model", "select", "claude-sonnet-4-6-20260915", ["claude-sonnet-4-6-20260915", "gpt-6.1-terra"]],
      ["backend_effort", "select", undefined, ["low", "high"]], ["backend_mode", "select", "default", ["default", "plan"]]]);
    assert.equal(offered.warning, undefined);
    failing = true;
    assert.deepEqual(await f.json("/agents/ext/backend-options"), { controls: [], warning: "Claude Code could not start: not logged in" });
    // A Raw agent has no backend controls, and its composer is unchanged.
    assert.deepEqual(await f.json("/agents/raw/backend-options"), { controls: [] });
    assert.equal((await f.json<{ backend?: unknown }>("/agents/raw/composer")).backend, undefined);
  } finally { await f.close(); }
});

test("a backend turn takes request.backend for itself only; the route checks its shape, the runner the CLI's lists", async () => {
  const f = await dashboardFixture({ extraAgents: { ext: { backend: { kind: "claude", model: "small" }, system_prompt: "Be RAW.", tools: { use: [] } } },
    attach: scriptedBackend });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "ext" });
    const send = (clientRequestId: string, input: string, request?: unknown) => f.api(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId, kind: "turn", agent: "ext", input, ...(request === undefined ? {} : { request }) });
    for (const [index, request] of [{ effort: "high" }, { backend: { model: "" } }, { backend: { color: "red" } }, { backend: "big" }, { backend: { model: "x".repeat(201) } }].entries()) {
      const refused = await send(`bad-${index}`, "options", request);
      assert.equal(refused.status, 422, JSON.stringify(request));
      assert.equal((await refused.json() as { error: { code: string } }).error.code, "invalid_request_option");
    }
    // A Raw agent refuses request.backend.
    const raw = await f.api(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "raw", kind: "turn", agent: "raw", input: "x", request: { backend: { model: "big" } } });
    assert.equal(raw.status, 422);
    // An effort the CLI does not list for that model passes the route; the runner warns and the turn runs without it.
    const chosen = await send("one", "options", { backend: { model: "big", effort: "turbo" } });
    assert.equal(chosen.status, 202);
    assert.equal((await f.wait((await chosen.json() as SessionOperation).id)).state, "completed");
    const texts = async () => (await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`)).items
      .filter((item) => item.kind === "assistant" || item.kind === "backend_notice").map((item) => `${item.kind}: ${item.text}`);
    assert.deepEqual(await texts(), [
      'backend_notice: Claude Code does not offer effort "turbo"; it keeps "low" (offered: low, high)',
      "assistant: model=big effort=low mode=ask"]);
    // The snapshot lists the session's own options: efforts of the model last used, values of the conversation.
    const after = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.deepEqual(after.backendOptions?.map((control) => [control.id, control.current, control.options.map((option) => option.value)]), [
      ["backend_model", "small", ["small", "big", "mid"]], ["backend_effort", undefined, ["low", "high"]], ["backend_mode", "ask", ["ask", "auto"]]]);
    // The next turn returns to the conversation's own values.
    const plain = await send("two", "options");
    assert.equal((await f.wait((await plain.json() as SessionOperation).id)).state, "completed");
    assert.equal((await texts()).at(-1), "assistant: model=small effort=- mode=ask");
    const settled = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.deepEqual(settled.backendOptions?.map((control) => control.id), ["backend_model", "backend_mode"]);
  } finally { await f.close(); }
});
