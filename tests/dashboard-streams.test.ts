import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("inline frames carry call identity and settle before the operation terminal frame", async () => {
  const modelConfig = { agentName: "raw", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" };
  const f = await dashboardFixture({ attach: async ({ store, session, owner, operation }) => {
    const registry = new ToolRegistry();
    registry.register({ name: "report", description: "Report", inputSchema: { type: "object" }, panels: [{ id: "report", title: "Report", placement: "chat",
      icon: "panel", open: "never", context: "none", acp_plan: false, actions: [] }], handler: async (_args, context) => {
      for (const text of ["first", "final"]) await context.panels!.update("report", { op: "replace", document: { blocks: [{ id: "body", kind: "markdown", text }] } });
      return { isError: false, content: [] };
    } });
    let requests = 0;
    return { modelConfig, compactOptions: {}, async close() {}, agent: createAgent({ cwd: session.cwd, registry,
      provider: { modelConfig, generate: async () => ++requests === 1
        ? { text: "", toolCalls: [{ id: "call", name: "report", arguments: {} }], finishReason: "tool_calls" }
        : { text: "done", toolCalls: [], finishReason: "stop" } },
      persistence: { store, sessionId: session.id, owner, surface: "web", ownership: "host", operationId: operation.id } }) };
  } });
  let stream: Awaited<ReturnType<typeof eventStream>> | undefined;
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    stream = await eventStream(f.server, session.id); await stream.next();
    await f.json(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "views", kind: "turn", agent: "raw", input: "go" });
    const frames: Array<{ data: Record<string, unknown> }> = [];
    for (let count = 0; count < 40; count++) {
      const event = await stream.next();
      if (event.type === "panel") frames.push(event);
      if (event.type === "operation" && event.data.state === "completed") break;
    }
    const final = frames.find(frame => frame.data.live === false)!;
    assert.ok(final, "a terminal event must not precede the committed view frame");
    assert.equal(final.data.revision, 2);
    const identity = final.data.view as { instanceId: string; toolCallId: string; sessionId: string };
    assert.equal(identity.toolCallId, "call");
    assert.equal(identity.sessionId, session.id);
    assert.match(JSON.stringify(await f.json(`/sessions/${session.id}/views/${identity.instanceId}`)), /final/);
    assert.deepEqual((await f.json<{ items: unknown[] }>(`/sessions/${session.id}/panels`)).items, []);
  } finally { stream?.close(); await f.close(); }
});

test("disconnect/replay keeps one running operation and stable live-to-history segment identities", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let requests = 0;
  const modelConfig = { agentName: "raw", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" };
  const f = await dashboardFixture({ attach: async ({ store, session, owner, operation }) => ({ modelConfig, compactOptions: {}, async close() {},
    agent: createAgent({ cwd: session.cwd, provider: { modelConfig, async generate(request) {
      requests++; request.onReasoningDelta?.("thinking"); request.onTextDelta?.("first "); await gate;
      request.onTextDelta?.("second"); return { text: "first second", toolCalls: [], finishReason: "stop" };
    } }, persistence: { store, sessionId: session.id, owner, surface: "web", ownership: "host", operationId: operation.id } }),
  }) });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const first = await eventStream(f.server, session.id); const initial = await first.next(); assert.equal(initial.type, "snapshot");
    const second = await eventStream(f.server, session.id); await second.next();
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "stream", kind: "turn", agent: "raw", input: "go" });
    let cursor = initial.id; let segmentId: string | undefined;
    for (;;) { const event = await first.next(); cursor = event.id; if (event.type === "text" && event.data.kind === "assistant") { segmentId = event.data.segmentId as string; break; } }
    first.close(); release(); assert.equal((await f.wait(op.id)).state, "completed");
    const resumed = await eventStream(f.server, session.id, cursor);
    let terminal = false;
    for (let index = 0; index < 30 && !terminal; index++) { const event = await resumed.next(); terminal = event.type === "operation" && event.data.state === "completed"; }
    assert.ok(terminal); resumed.close(); second.close(); assert.equal(requests, 1);
    const history = await f.json<{ items: Array<{ id: string; text?: string }> }>(`/sessions/${session.id}/history`);
    assert.equal(history.items.find((item) => item.id === segmentId)?.text, "first second");
    const reset = await eventStream(f.server, session.id, "expired:cursor:1"); assert.equal((await reset.next()).type, "reset"); reset.close();
  } finally { release(); await f.close(); }
});

test("expired replay resets to a paged UTF-8 live segment and cleans the spool after commit", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let streamed!: () => void; const ready = new Promise<void>((resolve) => { streamed = resolve; });
  const body = "🙂abc".repeat(700000); // More than the 4 MiB replay bound, with multibyte page boundaries.
  const modelConfig = { agentName: "raw", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" };
  const f = await dashboardFixture({ attach: async ({ store, session, owner, operation }) => ({ modelConfig, compactOptions: {}, async close() {},
    agent: createAgent({ cwd: session.cwd, provider: { modelConfig, async generate(request) {
      request.onTextDelta?.(body); streamed(); await gate; return { text: body, toolCalls: [], finishReason: "stop" };
    } }, persistence: { store, sessionId: session.id, owner, surface: "web", ownership: "host", operationId: operation.id } }),
  }) });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const stream = await eventStream(f.server, session.id); const initial = await stream.next(); stream.close();
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "large", kind: "turn", agent: "raw", input: "go" });
    await ready;
    const replay = await eventStream(f.server, session.id, initial.id); assert.equal((await replay.next()).type, "reset"); replay.close();
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`); const segment = snapshot.live[0]!;
    assert.equal(segment.paged, true); assert.ok(segment.text.length <= 8192);
    let content = ""; let offset = 0;
    for (;;) {
      const page = await f.json<{ text: string; nextOffset: number; done: boolean }>(`/sessions/${session.id}/output?operationId=${op.id}&segmentId=${segment.segmentId}&offset=${offset}`);
      assert.ok(!page.text.includes("�")); content += page.text; offset = page.nextOffset; if (page.done) break;
    }
    assert.equal(content, body);
    assert.equal((await f.api(`/sessions/${session.id}/output?operationId=${op.id}&segmentId=${segment.segmentId}&offset=1`)).status, 400);
    release(); assert.equal((await f.wait(op.id)).state, "completed");
    assert.equal((await f.api(`/sessions/${session.id}/output?operationId=${op.id}&segmentId=${segment.segmentId}&offset=0`)).status, 404);
  } finally { release(); await f.close(); }
});

test("two tabs converge after disconnecting during a real tool with one sentinel effect", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "once", type: "function", function: { name: "bash",
      arguments: '{"commands":[{"command":"printf x >> sentinel; sleep 0.1"}]}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const a = await eventStream(f.server, session.id); await a.next();
    const b = await eventStream(f.server, session.id); await b.next();
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "once", kind: "turn", agent: "raw", input: "effect" });
    let cursor = "";
    for (;;) { const item = await a.next(); if (item.type === "tool" && item.data.state === "running") { cursor = item.id; break; } }
    a.close();
    for (;;) { const item = await b.next(); if (item.type === "operation" && item.data.state === "completed") break; }
    b.close(); await f.wait(op.id);
    const replay = await eventStream(f.server, session.id, cursor); const replayed: string[] = [];
    for (;;) { const item = await replay.next(); replayed.push(item.id); if (item.type === "operation" && item.data.state === "completed") break; }
    replay.close(); assert.equal(new Set(replayed).size, replayed.length);
    assert.equal(readFileSync(join(f.root, "sentinel"), "utf8"), "x"); assert.equal(f.provider.requests.length, 2);
    const [left, right] = await Promise.all([1, 2].map(() => f.json<SessionSnapshot>(`/sessions/${session.id}`)));
    assert.deepEqual(left!.history, right!.history); assert.equal(left!.history.items.filter((item) => item.kind === "user").length, 1);
  } finally { await f.close(); }
});
