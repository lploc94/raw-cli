import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelHost } from "../src/panels/host.js";
import { buildPanelStack } from "../src/panels/stack.js";
import type { PanelDeclaration } from "../src/panels/contract.js";
import { createAgent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { openSessionStore } from "../src/sessions/store.js";
import type { ProviderAdapter } from "../src/llm/types.js";

const declaration: PanelDeclaration = { id: "view", title: "View", placement: "chat", icon: "panel", open: "never", context: "none", acp_plan: false, actions: [] };
const info = { owner: "agent/report", declarations: [declaration], implicit: false };
const update = (text: string) => ({ op: "replace" as const, document: { blocks: [{ id: "body", kind: "markdown", text }] } });

test("chat instances are call-scoped, provisional and outside the sidebar budget", async () => {
  const host = new PanelHost();
  const ids = new Set<string>();
  for (let index = 0; index < 20; index++) {
    const call = host.begin(`call-${index}`, info);
    assert.equal(call.context.get("view"), undefined);
    await call.context.update("view", update(`first-${index}`));
    assert.equal((await call.context.update("view", update(`final-${index}`))).revision, 2);
    const settled = call.settle(false);
    const receipt = settled.receipts[0]!;
    assert.equal(receipt.view?.toolCallId, `call-${index}`);
    assert.ok(receipt.view?.instanceId);
    ids.add(receipt.view!.instanceId);
    assert.equal((settled.writes?.views?.[0]?.document.blocks[0] as { text: string }).text, `final-${index}`);
    assert.equal(settled.writes?.upserts.length, 0);
    call.commit();
    assert.deepEqual(host.snapshot(), []);
  }
  assert.equal(ids.size, 20);
  const abandoned = host.begin("abandoned", info);
  await abandoned.context.update("view", update("temporary"));
  abandoned.rollback();
  assert.equal(host.begin("next", info).context.get("view"), undefined);
  assert.deepEqual(buildPanelStack({ declared: [{ owner: info.owner, declaration }], implicitOwners: [] }, []), []);
});

test("20 durable calls retain distinct snapshots through paging/reload and session deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-views-"));
  const options = { env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } };
  let store = openSessionStore(options);
  const sessionId = store.createSession({ cwd: root, title: "views" }).id;
  const registry = new ToolRegistry();
  registry.register({ name: "report", canonicalName: info.owner, description: "report", inputSchema: { type: "object", required: ["text"],
    properties: { text: { type: "string" } }, additionalProperties: false }, panels: [declaration],
    handler: async (args, context) => { await context.panels!.update("view", update(String(args.text))); return { isError: false, content: [] }; } });
  let index = 0;
  let call = true;
  const provider: ProviderAdapter = { modelConfig: { agentName: "a", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => { if (!call) { call = true; return { text: "done", toolCalls: [], finishReason: "stop" }; }
      call = false; return { text: "", toolCalls: [{ id: "repeated-provider-id", name: "report", arguments: { text: `snapshot-${index++}` } }], finishReason: "tool_calls" }; } };
  const agent = createAgent({ provider, registry, cwd: root, persistence: { store, sessionId, surface: "cli" } });
  try {
    for (let index = 0; index < 20; index++) assert.equal((await agent.run(`turn ${index}`)).status, "completed");
    assert.deepEqual(store.listSessionPanels(sessionId), []);
  } finally { await agent.close(); store.close(); }
  store = openSessionStore(options);
  try {
    const receipts: Array<{ view: { instanceId: string }; toolCallId: string }> = [];
    let before: string | undefined;
    do {
      const page = store.getSessionHistory({ sessionId, limit: 9, ...(before ? { before } : {}) });
      receipts.push(...page.items.filter(item => item.kind === "panel_receipt").map(item => item.payload as never));
      before = page.nextCursor;
    } while (before);
    assert.equal(receipts.length, 20);
    assert.equal(new Set(receipts.map(receipt => receipt.view.instanceId)).size, 20);
    const texts = receipts.map(receipt => (store.getToolView(sessionId, receipt.view.instanceId)!.document.blocks[0] as { text: string }).text).sort();
    assert.deepEqual(texts, Array.from({ length: 20 }, (_, index) => `snapshot-${index}`).sort());
    assert.equal(store.getToolView("another-session", receipts[0]!.view.instanceId), undefined);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM session_tool_views").get()?.n), 20);
    store.deleteSession(sessionId);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM session_tool_views").get()?.n), 0);
  } finally { store.close(); }
});

test("abort before result commit discards ordinary inline updates and their receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-view-abort-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const sessionId = store.createSession({ cwd: root, title: "abort" }).id;
  const registry = new ToolRegistry();
  registry.register({ name: "report", canonicalName: info.owner, description: "report", inputSchema: { type: "object" }, panels: [declaration],
    handler: async (_args, context) => { await context.panels!.update("view", update("abandoned"));
      return { isError: true, code: "aborted", content: [{ type: "text", text: "aborted" }] }; } });
  const provider: ProviderAdapter = { modelConfig: { agentName: "a", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ({ text: "", toolCalls: [{ id: "call", name: "report", arguments: {} }], finishReason: "tool_calls" }) };
  const agent = createAgent({ provider, registry, cwd: root, persistence: { store, sessionId, surface: "cli" } });
  try {
    const result = await agent.run("start", event => { if (event.type === "panel_update" && event.live) agent.abort(); });
    assert.equal(result.status, "cancelled");
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM session_tool_views").get()?.n), 0);
    assert.equal(store.getSessionHistory({ sessionId }).items.filter(item => item.kind === "panel_receipt").length, 0);
  } finally { await agent.close(); store.close(); }
});

test("failed result transaction rolls back the inline snapshot, receipt and linked tool result together", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-view-fail-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const sessionId = store.createSession({ cwd: root, title: "fail" }).id;
  store.database.exec(`CREATE TRIGGER fail_after_views BEFORE UPDATE ON sessions
    WHEN (SELECT count(*) FROM session_tool_views) > 0 BEGIN SELECT RAISE(ABORT, 'view commit failure'); END`);
  const registry = new ToolRegistry();
  registry.register({ name: "report", canonicalName: info.owner, description: "report", inputSchema: { type: "object" }, panels: [declaration],
    handler: async (_args, context) => { await context.panels!.update("view", update("uncommitted")); return { isError: false, content: [] }; } });
  const provider: ProviderAdapter = { modelConfig: { agentName: "a", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ({ text: "", toolCalls: [{ id: "call", name: "report", arguments: {} }], finishReason: "tool_calls" }) };
  const agent = createAgent({ provider, registry, cwd: root, persistence: { store, sessionId, surface: "cli" } });
  try {
    const result = await agent.run("start");
    assert.equal(result.code, "persistence_error");
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM session_tool_views").get()?.n), 0);
    assert.equal(store.getSessionHistory({ sessionId }).items.filter(item => item.kind === "panel_receipt").length, 0);
    assert.equal(agent.transcript.filter(message => message.role === "tool").length, 0);
  } finally { await agent.close(); store.close(); }
});

test("an aborted user action rolls back chat/sidebar updates, receipts and pending notes", async () => {
  for (const placement of ["chat", "sidebar"] as const) {
    const root = mkdtempSync(join(tmpdir(), "raw-view-action-abort-"));
    const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
    const sessionId = store.createSession({ cwd: root, title: "action abort" }).id;
    const registry = new ToolRegistry();
    let handlers = 0;
    registry.register({ name: "report", canonicalName: info.owner, description: "report", inputSchema: { type: "object" },
      panels: [{ ...declaration, placement, actions: [{ id: "run", label: "Run", scope: "panel", kind: "tool", arguments: {} }] }],
      handler: async (_args, context) => { await context.panels!.update("view", update(`state-${++handlers}`));
        if (handlers > 1) await new Promise(resolve => setTimeout(resolve, 300));
        return context.signal?.aborted ? { isError: true, code: "aborted", content: [{ type: "text", text: "aborted" }] } : { isError: false, content: [] }; } });
    let generated = 0;
    const provider: ProviderAdapter = { modelConfig: { agentName: "a", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ++generated === 1
        ? { text: "", toolCalls: [{ id: "seed", name: "report", arguments: {} }], finishReason: "tool_calls" }
        : { text: "done", toolCalls: [], finishReason: "stop" } };
    const agent = createAgent({ provider, registry, cwd: root, persistence: { store, sessionId, surface: "cli" } });
    try {
      assert.equal((await agent.run("seed")).status, "completed");
      const beforeViews = store.database.prepare("SELECT * FROM session_tool_views").all();
      const beforePanels = store.listSessionPanels(sessionId);
      const receipt = store.getSessionHistory({ sessionId }).items.find(item => item.kind === "panel_receipt")!.payload as { view?: { instanceId: string } };
      const finalFrames: unknown[] = [];
      const result = await agent.runPanelAction({ panel: "agent/report#view", action: "run",
        ...(receipt.view ? { viewInstanceId: receipt.view.instanceId } : {}) }, event => {
        if (event.type === "panel_update") { if (event.live) agent.abort(); else finalFrames.push(event); }
      });
      assert.equal(result.status, "cancelled");
      assert.deepEqual(finalFrames, [], placement);
      assert.deepEqual(store.database.prepare("SELECT * FROM session_tool_views").all(), beforeViews, placement);
      assert.deepEqual(store.listSessionPanels(sessionId), beforePanels, placement);
      assert.equal(store.getSessionHistory({ sessionId }).items.filter(item => item.kind === "panel_receipt").length, 1, placement);
      assert.equal(store.pendingNotes(sessionId).length, 0, placement);
    } finally { await agent.close(); store.close(); }
  }
});
