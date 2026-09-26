import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import { createAgent } from "../src/agent.js";
import { COMPACT_SYSTEM_PROMPT } from "../src/compact.js";

test("HTTP duplicate submissions execute one real Bash effect and return the saved receipt", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "effect", type: "function", function: { name: "bash",
      arguments: JSON.stringify({ commands: [{ command: "printf x >> effect.txt" }] }) } }] }, "tool_calls"), openAiDone] },
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
  const f = await dashboardFixture({ agent: { compact: { keep_recent_turns: 0, max_output_tokens: 64 } }, responses: [
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "remember task" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { status: 500, body: { error: { message: "summary unavailable" } } },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const run = async (kind: "turn" | "compact", key: string) => f.wait((await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) })).id);
    await run("turn", "one"); const compact = await run("compact", "compact"); assert.equal(compact.result?.status, "compacted", JSON.stringify(compact));
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
  const f = await dashboardFixture({ agent: { compact: { trigger_tokens: 800, keep_recent_turns: 1, max_output_tokens: 64 } }, responses: [
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
    return { modelConfig, compactOptions: { keepRecentTurns: 0 }, async close() {},
      agent: createAgent({ cwd: session.cwd, provider: { modelConfig, async generate(request) {
        if (target === "provider" || request.system === COMPACT_SYSTEM_PROMPT) return stopped(request.signal);
        return { text: "details ".repeat(300), toolCalls: [], finishReason: "stop" };
      } }, persistence: { store, sessionId: session.id, owner, surface: "web", ownership: "host", operationId: operation.id } }),
    };
  } });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const submit = (key: string, kind: string) => f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) });
    if (target === "compact") await f.wait((await submit("seed", "turn")).id);
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
    { index: 0, id: "sleep", type: "function", function: { name: "bash", arguments: '{"commands":[{"command":"sleep 30"}]}' } },
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
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(marker)); const pid = Number(readFileSync(marker, "utf8"));
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
