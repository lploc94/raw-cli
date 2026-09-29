import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { PANEL_LIMITS, PanelError, type PanelDeclaration } from "../src/panels/contract.js";
import { PanelHost, type PanelLiveEvent } from "../src/panels/host.js";
import { capResult } from "../src/tools/results.js";
import { openSessionStore } from "../src/sessions/store.js";
import { projectHistoryItem } from "../src/sessions/view.js";
import { renderTerminalHistory } from "../src/terminal/history.js";
import type { HookEventName } from "../src/hooks/contract.js";
import type { ToolHandlerResult } from "../src/tools/types.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const decl = (id: string, extra: Partial<PanelDeclaration> = {}): PanelDeclaration =>
  ({ id, title: id.toUpperCase(), icon: "list-checks", open: "never", context: "none", acp_plan: false, actions: [], ...extra });
const todo = (...labels: string[]) => ({ op: "replace" as const, document: { blocks: [{ id: "c", kind: "checklist", items: labels.map((label, index) => ({ id: `i${index}`, label })) }] } });
const info = (owner = "builtin/todo", ids = ["todo"], implicit = false) => ({ owner, declarations: ids.map((id) => decl(id)), implicit });
const code = (fn: () => unknown, expected: string) => assert.throws(fn, (error) => error instanceof PanelError && error.code === expected);
async function codeAsync(fn: () => Promise<unknown>, expected: string) {
  await assert.rejects(fn, (error) => error instanceof PanelError && error.code === expected);
}

test("revisions are host-assigned, commit only on markCommitted and roll back to the last committed state", async () => {
  const host = new PanelHost();
  const call = host.begin("c1", info());
  assert.deepEqual(await call.context.update("todo", todo("a")), { revision: 1 });
  assert.deepEqual(await call.context.update("todo", todo("a", "b")), { revision: 2 });
  assert.equal(host.snapshot().length, 0, "nothing is committed before the store transaction succeeds");
  const settled = call.settle(true);
  assert.equal(settled.writes?.upserts[0]?.revision, 2);
  assert.equal(settled.receipts.length, 1, "one receipt per touched panel per call");
  assert.match(settled.lines[0]!, /^panel todo updated \(revision 2\): /);
  call.commit();
  assert.equal(host.snapshot()[0]?.revision, 2);

  const second = host.begin("c2", info());
  await second.context.update("todo", todo("z"));
  second.settle(true);
  second.rollback();
  assert.equal(host.snapshot()[0]?.revision, 2);
  const third = host.begin("c3", info());
  assert.equal(third.context.get("todo")?.revision, 2, "working state reverted to the last committed revision");
  assert.equal((await third.context.update("todo", todo("y"))).revision, 3);
});

test("ownership uses canonical identity: aliases and foreign panels cannot be written", async () => {
  const host = new PanelHost();
  const call = host.begin("c1", info("builtin/todo"));
  await codeAsync(() => call.context.update("mcp/other#todo", todo("a")), "panel_not_owned");
  await codeAsync(() => call.context.update("todo-alias#todo", todo("a")), "panel_not_owned");
  assert.deepEqual(await call.context.update("builtin/todo#todo", todo("a")), { revision: 1 });
  call.settle(true); call.commit();
  const other = host.begin("c2", info("agent/other"));
  assert.equal(other.context.get("todo"), undefined, "the same local id under another owner is a different panel");
  await other.context.update("todo", todo("mine"));
  other.settle(true); other.commit();
  assert.deepEqual(host.snapshot().map((panel) => panel.panelId).sort(), ["agent/other#todo", "builtin/todo#todo"]);
});

test("undeclared panels are rejected for manifest tools but implicit for MCP and ACP owners", async () => {
  const host = new PanelHost();
  await codeAsync(() => host.begin("c1", info("agent/x", ["known"])).context.update("secret", todo("a")), "panel_undeclared");
  host.rollback();
  const call = host.begin("c2", info("mcp/server/tool", [], true));
  await call.context.update("anything", todo("a"));
  call.settle(true); call.commit();
  assert.equal(host.snapshot()[0]?.declaration.id, "anything");
});

test("more than 200 updates to one panel in a call are rate limited, exactly at the boundary", async () => {
  const host = new PanelHost();
  const call = host.begin("c1", info());
  for (let n = 0; n < PANEL_LIMITS.updatesPerCall; n++) await call.context.update("todo", todo(`v${n}`));
  await codeAsync(() => call.context.update("todo", todo("over")), "panel_rate_limited");
  const other = host.begin("c2", info());
  for (let n = 0; n < PANEL_LIMITS.updatesPerCall; n++) await other.context.update("todo", todo(`w${n}`));
});

test("update after the handler settled is panel_closed_context", async () => {
  const host = new PanelHost();
  const call = host.begin("c1", info());
  call.settle(true);
  await codeAsync(() => call.context.update("todo", todo("late")), "panel_closed_context");
});

test("base_revision conflicts, unknown patch targets and invalid documents keep state unchanged", async () => {
  const host = new PanelHost();
  const call = host.begin("c1", info());
  await call.context.update("todo", todo("a"));
  await codeAsync(() => call.context.update("todo", { ...todo("b"), base_revision: 5 }), "panel_revision_conflict");
  assert.equal((await call.context.update("todo", { ...todo("b"), base_revision: 1 })).revision, 2);
  await codeAsync(() => call.context.update("nope", { op: "close" }), "panel_undeclared");
  await codeAsync(() => call.context.update("todo", { op: "replace", document: { blocks: [{ id: "x", kind: "checklist" }] } } as never), "panel_invalid");
  assert.equal(call.context.get("todo")?.revision, 2);
  const fresh = new PanelHost();
  await codeAsync(() => fresh.begin("c", info()).context.update("todo", { op: "patch", patches: [{ op: "remove_block", id: "x" }] } as never), "panel_unknown");
});

test("16 panels per session: a closed panel is evicted and persisted as a delete, otherwise panel_limit", async () => {
  const ids = Array.from({ length: 17 }, (_, index) => `p${index}`);
  const host = new PanelHost({ now: (() => { let t = 0; return () => ++t; })() });
  const owner = info("agent/many", ids);
  for (const id of ids.slice(0, 16)) {
    const call = host.begin(`c-${id}`, owner);
    await call.context.update(id, todo("a"));
    call.settle(true); call.commit();
  }
  const blocked = host.begin("c-over", owner);
  await codeAsync(() => blocked.context.update("p16", todo("a")), "panel_limit");
  host.rollback();
  const closer = host.begin("c-close", owner);
  await closer.context.update("p3", { op: "close" });
  closer.settle(true); closer.commit();
  const call = host.begin("c-new", owner);
  await call.context.update("p16", todo("a"));
  const settled = call.settle(true);
  assert.deepEqual(settled.writes?.deletes, ["agent/many#p3"]);
  call.commit();
  assert.equal(host.snapshot().length, 16);
  assert.ok(!host.snapshot().some((panel) => panel.panelId === "agent/many#p3"));
});

test("result-block updates are applied in order at settle, and a rejected one adds a line and an error receipt", () => {
  const host = new PanelHost();
  const call = host.begin("c1", info());
  call.collect([{ type: "panel", panel: "todo", ...todo("a") }, { type: "panel", panel: "todo", op: "patch", patches: [{ op: "remove_items", block: "c", ids: ["i0"] }] } as never,
    { type: "panel", panel: "ghost", ...todo("x") }]);
  const settled = call.settle(true);
  assert.equal(settled.writes?.upserts.length, 1);
  assert.equal(settled.writes?.upserts[0]?.revision, 2, "both updates applied in order");
  const rejected = settled.receipts.find((receipt) => receipt.error);
  assert.equal(rejected?.panel, "ghost");
  assert.equal(rejected?.error?.code, "panel_undeclared");
  assert.equal(rejected?.revision, 0);
  assert.ok(settled.lines.some((line) => /^panel ghost update rejected: panel_undeclared /.test(line)));
  assert.ok(settled.lines.some((line) => /^panel todo updated \(revision 2\)/.test(line)));
  assert.equal(settled.receipts.filter((receipt) => !receipt.error).length, 1);
});

test("a tool that returned text keeps its result untouched except for rejection lines", () => {
  const host = new PanelHost();
  const call = host.begin("c1", info());
  call.collect([{ type: "panel", panel: "todo", ...todo("a") }]);
  assert.deepEqual(call.settle(false).lines, [], "confirmation lines are only for panel-only results");
});

test("live frames are coalesced to 250 ms, the latest state wins, and the commit emits a final frame", async () => {
  const host = new PanelHost();
  const events: PanelLiveEvent[] = [];
  host.setListener((event) => events.push(event));
  const call = host.begin("c1", info());
  for (let n = 0; n < 50; n++) await call.context.update("todo", todo(`v${n}`));
  assert.ok(events.length <= 1, `expected at most one immediate frame, got ${events.length}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const live = events.filter((event) => event.live);
  assert.ok(live.length >= 1 && live.length <= 2);
  assert.equal(JSON.stringify(live.at(-1)?.document).includes("v49"), true);
  call.settle(true); call.commit();
  const last = events.at(-1)!;
  assert.equal(last.live, false);
  assert.equal(last.revision, 50);
  host.close();
});

test("a throwing observer never changes state", async () => {
  const host = new PanelHost();
  host.setListener(() => { throw new Error("observer"); });
  const call = host.begin("c1", info());
  await call.context.update("todo", todo("a"));
  call.settle(true); call.commit();
  assert.equal(host.snapshot()[0]?.revision, 1);
});

test("registry extraction happens before hooks and caps: spies never see a panel block", async () => {
  const registry = createTestToolRegistry();
  registry.register({ name: "note", description: "Note", inputSchema: { type: "object", properties: {} }, panels: [decl("todo")],
    async handler(): Promise<ToolHandlerResult> {
      return { isError: false, content: [{ type: "text", text: "hi" }, { type: "panel", panel: "todo", ...todo("a") }] };
    } });
  const hookResults: unknown[] = [];
  const collected: unknown[] = [];
  const result = await registry.dispatch("note", {}, { cwd: ".", maxOutputBytes: 4096, autoApprove: true,
    onPanelUpdates: (updates: unknown[]) => collected.push(...updates),
    onHook: async (_event: HookEventName, _identity: string, _name: string, _args: Record<string, unknown>, res: unknown) => { hookResults.push(res); return {}; } } as never);
  assert.equal(collected.length, 1);
  assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
  for (const seen of hookResults) assert.ok(!JSON.stringify(seen ?? null).includes('"panel"'), "hook payload has no panel block");
  assert.deepEqual(registry.definitions().find((d) => d.name === "note") && Object.keys(registry.definitions().find((d) => d.name === "note")!).sort(),
    ["description", "inputSchema", "name"].filter((key) => key in registry.definitions().find((d) => d.name === "note")!).sort());
});

test("capResult passes panel blocks through without counting them against the output budget", () => {
  const big = { type: "panel" as const, panel: "todo", ...todo("x".repeat(60_000)) };
  const capped = capResult({ isError: false, content: [{ type: "text", text: "ok" }, big] }, 64);
  assert.equal(capped.content.some((block) => (block as { type: string }).type === "panel"), true);
  assert.equal(capped.content.find((block) => block.type === "text")?.type, "text");
  assert.equal((capped.content[0] as { text: string }).text, "ok", "a panel does not consume the text budget");
});

// ---- agent + store integration ----

function setup() {
  const root = mkdtempSync(join(tmpdir(), "raw-panels-host-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "session" }).id;
  return { root, store, id };
}
const provider = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter =>
  ({ modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture", vision: false }, generate });

function panelRegistry(handler: NonNullable<Parameters<ReturnType<typeof createTestToolRegistry>["register"]>[0]>["handler"]) {
  const registry = createTestToolRegistry();
  registry.register({ name: "todo", description: "Todo", inputSchema: { type: "object", properties: {} }, panels: [decl("todo")], handler });
  return registry;
}
const scripted = (...calls: Array<Array<{ id: string; name: string; arguments: Record<string, unknown> }>>) => {
  const requests: ProviderRequest[] = [];
  let n = 0;
  return { requests, provider: provider(async (request) => {
    requests.push({ messages: structuredClone(request.messages), tools: structuredClone(request.tools), system: request.system, cacheKey: request.cacheKey } as ProviderRequest);
    const next = calls[n++];
    return next ? { text: "", toolCalls: next, finishReason: "tool_calls" } : { text: "done", toolCalls: [], finishReason: "stop" };
  }) };
};

test("agent: a panel-only result gives the model a confirmation line, persists the panel, receipt and result atomically", async () => {
  const { root, store, id } = setup();
  let revision = 0;
  const registry = panelRegistry(async () => ({ isError: false, content: [{ type: "panel", panel: "todo", ...todo(`step ${++revision}`) }] }));
  const script = scripted([{ id: "t1", name: "todo", arguments: {} }], [{ id: "t2", name: "todo", arguments: {} }]);
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try {
    { const r = await agent.run("go"); assert.equal(r.status, "completed", JSON.stringify(r)); }
    const tool = script.requests[1]!.messages.filter((message) => message.role === "tool");
    assert.match(JSON.stringify(tool), /panel todo updated \(revision 1\): /);
    assert.ok(!JSON.stringify(script.requests).includes('"type":"panel"'), "no provider request contains a panel block");
    const stored = store.listSessionPanels(id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.revision, 2);
    const receipts = store.database.prepare("SELECT payload_json FROM history WHERE kind = 'panel_receipt'").all() as Array<{ payload_json: string }>;
    assert.equal(receipts.length, 2);
    assert.equal(JSON.parse(receipts[1]!.payload_json).revision, 2);
  } finally { await agent.close(); store.close(); }
});

test("agent: a rejected update tells the model, keeps isError false and stores an error receipt without a document write", async () => {
  const { root, store, id } = setup();
  const registry = panelRegistry(async () => ({ isError: false, content: [{ type: "text", text: "did it" },
    { type: "panel", panel: "ghost", ...todo("x") }] }));
  const script = scripted([{ id: "t1", name: "todo", arguments: {} }]);
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try {
    { const r = await agent.run("go"); assert.equal(r.status, "completed", JSON.stringify(r)); }
    const sent = JSON.stringify(script.requests[1]!.messages);
    assert.match(sent, /panel ghost update rejected: panel_undeclared/);
    assert.match(sent, /did it/);
    assert.equal(store.listSessionPanels(id).length, 0);
    const row = store.database.prepare("SELECT payload_json FROM history WHERE kind = 'panel_receipt'").get() as { payload_json: string };
    assert.equal(JSON.parse(row.payload_json).error.code, "panel_undeclared");
  } finally { await agent.close(); store.close(); }
});

test("agent: streaming updates commit with an error result too, and a fresh session on the same store sees the last revision", async () => {
  const { root, store, id } = setup();
  const registry = panelRegistry(async (_args, ctx) => {
    await ctx.panels!.update("todo", todo("a"));
    await ctx.panels!.update("todo", todo("a", "b"));
    return { isError: true, code: "tool_error", content: [{ type: "text", text: "boom" }] };
  });
  const first = scripted([{ id: "t1", name: "todo", arguments: {} }]);
  const agent = createAgent({ cwd: root, provider: first.provider, registry, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try { await agent.run("go"); } finally { await agent.close(); }
  assert.equal(store.listSessionPanels(id)[0]?.revision, 2);
  const seen: number[] = [];
  const registry2 = panelRegistry(async (_args, ctx) => {
    seen.push(ctx.panels!.get("todo")?.revision ?? -1);
    return { isError: false, content: [{ type: "panel", panel: "todo", op: "patch", patches: [{ op: "upsert_items", block: "c", items: [{ id: "n", label: "new" }] }] } as never] };
  });
  const second = scripted([{ id: "t2", name: "todo", arguments: {} }]);
  const resumed = createAgent({ cwd: root, provider: second.provider, registry: registry2, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try { await resumed.run("again"); } finally { await resumed.close(); store.close(); }
  assert.deepEqual(seen, [2], "restart reloads the committed revision");
});

test("agent: a store failure inside the transaction leaves no panel row, no receipt, and rolls the host back", async () => {
  const { root, store, id } = setup();
  const registry = panelRegistry(async () => ({ isError: false, content: [{ type: "panel", panel: "todo", ...todo("a") }] }));
  const script = scripted([{ id: "t1", name: "todo", arguments: {} }]);
  // Fires on the last statement of the transaction, after the panel upsert and the receipt, so panels written in
  // a separate transaction (or before this one) would survive the failure.
  store.database.exec(`CREATE TRIGGER fail_after_panels BEFORE UPDATE ON sessions
    WHEN (SELECT count(*) FROM session_panels) > 0 BEGIN SELECT RAISE(ABORT, 'simulated tool commit failure'); END`);
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try { await agent.run("go").catch(() => undefined); } finally { await agent.close(); }
  assert.equal(store.listSessionPanels(id).length, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM history WHERE kind = 'panel_receipt'").get()?.n, 0);
  store.close();
});

test("agent: a panel-free agent sends exactly the request bytes captured before panels existed", async () => {
  const { root, store, id } = setup();
  const registry = createTestToolRegistry();
  registry.register({ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { v: { type: "string" } } }, handler: async () => ({ isError: false, content: [{ type: "text", text: "e" }] }) });
  const script = scripted([{ id: "e1", name: "echo", arguments: { v: "x" } }]);
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["echo"], persistence: { store, sessionId: id, surface: "cli" } });
  try { await agent.run("go"); } finally { await agent.close(); store.close(); }
  const baseline = JSON.parse(readFileSync(new URL("./fixtures/panel-free-requests.json", import.meta.url), "utf8")) as Array<{ messages: unknown; tools: unknown; system: string; cacheKeyIsString: boolean }>;
  const actual = script.requests.map((request) => ({ messages: request.messages, tools: request.tools, system: request.system, cacheKeyIsString: typeof request.cacheKey === "string" }));
  assert.equal(JSON.stringify(actual), JSON.stringify(baseline), "provider requests are byte-identical to the pre-panel capture");
});

test("malformed panel ids in result blocks become bounded rejections, never a failed run", async () => {
  const { root, store, id } = setup();
  const registry = panelRegistry(async () => ({ isError: false, content: [{ type: "text", text: "ok" },
    { type: "panel", op: "close" } as never, { type: "panel", panel: null, op: "close" } as never, { type: "panel", panel: 7, op: "close" } as never,
    { type: "panel", panel: "x".repeat(10_000), op: "close" } as never] }));
  const script = scripted([{ id: "t1", name: "todo", arguments: {} }]);
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const run = await agent.run("go");
    assert.equal(run.status, "completed", JSON.stringify(run));
    const rows = store.database.prepare("SELECT payload_json FROM history WHERE kind = 'panel_receipt'").all() as Array<{ payload_json: string }>;
    assert.ok(rows.length >= 1);
    for (const row of rows) assert.ok(Buffer.byteLength(row.payload_json) <= PANEL_LIMITS.receiptBytes, "receipt is bounded");
    assert.ok(JSON.stringify(script.requests[1]!.messages).length < 4000, "the model-visible rejection lines are bounded too");
  } finally { await agent.close(); store.close(); }
});

test("receipts stay bounded and settle terminates even when identifiers alone are large", async () => {
  const host = new PanelHost();
  const call = host.begin("k".repeat(1100), info());
  await call.context.update("todo", todo("a"));
  const settled = call.settle(true);
  const receipt = settled.receipts[0]!;
  assert.equal(receipt.summary, "", "the summary is sacrificed first and the loop terminates");
  assert.equal(receipt.toolCallId, "k".repeat(1100), "identifiers are never altered, even past the budget");
  assert.equal(receipt.panel, "todo");
  const normal = new PanelHost().begin("c", info());
  await normal.context.update("todo", todo(...Array.from({ length: 40 }, (_, n) => `${"a".repeat(150)}${n}`)));
  assert.ok(Buffer.byteLength(JSON.stringify(normal.settle(true).receipts[0])) <= PANEL_LIMITS.receiptBytes);
});

test("the streaming window closes when the handler returns, before post-tool hooks", async () => {
  const registry = createTestToolRegistry();
  registry.register({ name: "late", description: "Late", inputSchema: { type: "object", properties: {} }, panels: [decl("todo")],
    handler: async () => ({ isError: false, content: [{ type: "text", text: "ok" }] }) });
  const host = new PanelHost();
  const call = host.begin("c1", info("late", ["todo"]));
  let late: unknown;
  await registry.dispatch("late", {}, { cwd: ".", maxOutputBytes: 4096, autoApprove: true, panels: call.context,
    onHandlerSettled: () => call.endWindow(),
    onHook: async (event: HookEventName) => { if (event === "PostToolUse") late = await call.context.update("todo", todo("late")).catch((error) => error); return {}; } } as never);
  assert.ok(late instanceof PanelError && late.code === "panel_closed_context");
});

test("result blocks accept the owner's full id, and the rate limit counts accepted updates per canonical panel", async () => {
  const host = new PanelHost();
  const call = host.begin("c1", info("agent/todo"));
  call.collect([{ type: "panel", panel: "agent/todo#todo", ...todo("a") }]);
  assert.equal(call.settle(true).writes?.upserts[0]?.revision, 1);
  const rated = new PanelHost().begin("c2", info());
  for (let n = 0; n < 200; n++) await codeAsync(() => rated.context.update("todo", { op: "close" }), "panel_unknown");
  await rated.context.update("todo", todo("first valid after 200 rejected"));
  for (let n = 1; n < PANEL_LIMITS.updatesPerCall; n++) await rated.context.update("todo", todo(`v${n}`));
  await codeAsync(() => rated.context.update("builtin/todo#todo", todo("spelled differently")), "panel_rate_limited");
});

test("session deletion cascades to panels and receipts render as receipts in the view and terminal history", async () => {
  const { root, store, id } = setup();
  const registry = panelRegistry(async () => ({ isError: false, content: [{ type: "panel", panel: "todo", ...todo("a", "b") }] }));
  const script = scripted([{ id: "t1", name: "todo", arguments: {} }]);
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["todo"], persistence: { store, sessionId: id, surface: "cli" } });
  try { await agent.run("go"); } finally { await agent.close(); }
  const items = store.historyAfter(id, 0, store.historyWatermark(id));
  const receipt = (items as Array<{ kind: string; payload: Record<string, unknown>; sequence: number; createdAt: number; status: string }>).find((item) => item.kind === "panel_receipt");
  assert.ok(receipt, "history contains the receipt");
  const view = projectHistoryItem(receipt as never);
  assert.equal(view.panelReceipt?.panel, "todo");
  assert.equal(view.panelReceipt?.revision, 1);
  const text = renderTerminalHistory(receipt as never);
  assert.match(text, /todo/i);
  assert.doesNotMatch(text, /toolCallId|\{"/);
  store.deleteSession(id);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM session_panels").get()?.n, 0);
  store.close();
});

test("eviction deletes and closed state survive a restart of the store", async () => {
  const { root, store, id } = setup();
  const ids = Array.from({ length: 17 }, (_, index) => `p${index}`);
  const registry = createTestToolRegistry();
  registry.register({ name: "many", description: "Many", inputSchema: { type: "object", properties: { id: { type: "string" }, close: { type: "boolean" } } },
    panels: ids.map((panel) => decl(panel)),
    async handler(args): Promise<ToolHandlerResult> {
      const panel = String(args.id);
      return { isError: false, content: [{ type: "panel", panel, ...(args.close ? { op: "close" as const } : todo("a")) }] };
    } });
  const calls = [...ids.slice(0, 16).map((panel) => ({ id: panel, name: "many", arguments: { id: panel } })),
    { id: "close", name: "many", arguments: { id: "p2", close: true } }, { id: "new", name: "many", arguments: { id: "p16" } }];
  const script = scripted(...calls.map((call) => [call]));
  const agent = createAgent({ cwd: root, provider: script.provider, registry, system: "s", whitelist: ["many"], maxSteps: 40,
    persistence: { store, sessionId: id, surface: "cli" } });
  try { assert.equal((await agent.run("go")).status, "completed"); } finally { await agent.close(); }
  const ids2 = store.listSessionPanels(id).map((panel) => panel.panelId);
  assert.equal(ids2.length, 16);
  assert.ok(!ids2.includes("agent#many#p2") && !ids2.some((panel) => panel.endsWith("#p2")), "the closed panel was evicted from the table");
  assert.ok(ids2.some((panel) => panel.endsWith("#p16")));
  store.close();
});
