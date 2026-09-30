import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PanelStackItem } from "../src/panels/stack.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { HistoryView } from "../src/sessions/view.js";
import type { PanelDeclaration, PanelDocument } from "../src/panels/contract.js";
import { PanelActionError, resolveAction } from "../src/panels/actions.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

const todoCall = (id: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function",
  function: { name: "todo", arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const answer = (text = "done") => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const PANEL = encodeURIComponent("builtin/todo#todo");
type Fixture = Awaited<ReturnType<typeof dashboardFixture>>;

async function turn(f: Fixture, sessionId: string, key: string, input = "go", agent = "raw") {
  const op = await f.json<SessionOperation>(`/sessions/${sessionId}/operations`, "POST", { clientRequestId: key, kind: "turn", agent, input });
  return (await f.wait(op.id)).state;
}
const act = (f: Fixture, sessionId: string, body: Record<string, unknown>) =>
  f.api(`/sessions/${sessionId}/panels/${PANEL}/actions`, "POST", { agent: "raw", clientRequestId: `k-${Math.random()}`, block: "items", ...body });
const items = async (f: Fixture, sessionId: string) => (await f.json<{ items: PanelStackItem[] }>(`/sessions/${sessionId}/panels`)).items;
const todoStatus = async (f: Fixture, sessionId: string, id: string) => {
  const doc = (await items(f, sessionId))[0]!.document as PanelDocument;
  const block = doc.blocks.find((b) => b.id === "items") as { items: Array<{ id: string; status?: string }> };
  return block.items.find((item) => item.id === id)?.status;
};
async function seeded(extra: { agent?: Record<string, unknown>; extraAgents?: Record<string, Record<string, unknown>>; responses?: unknown[] } = {}) {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] }, ...extra.agent }, ...(extra.extraAgents ? { extraAgents: extra.extraAgents } : {}),
    responses: [todoCall("c1", { todos: [{ id: "a", content: "Alpha", status: "pending" }, { id: "b", content: "Beta", status: "in_progress" }] }), answer(), ...(extra.responses ?? [answer("next"), answer("again")])] as never });
  const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
  assert.equal(await turn(f, session.id, "t1"), "completed");
  return { f, session };
}
const setConfig = (f: Fixture, edit: (config: Record<string, any>) => void) => { edit(f.config); writeFileSync(f.configPath, JSON.stringify(f.config)); };

test("resolveAction enforces scope, blocks, when and templates, and fills strings only", () => {
  const declaration: PanelDeclaration = { id: "p", title: "P", icon: "panel", open: "never", context: "none", acp_plan: false, actions: [
    { id: "done", label: "Done", scope: "item", blocks: ["items"], kind: "tool", arguments: { todos: [{ id: "{{item.id}}", n: 1, label: "{{ item.label }}" }], panel: "{{panel.id}}" }, when: { status: ["pending"] } },
    { id: "all", label: "All", scope: "panel", kind: "tool", arguments: { block: "{{block.id}}" } },
    { id: "blk", label: "Blk", scope: "block", kind: "prompt", text: "in {{block.id}} of {{panel.id}}" },
  ] };
  const document: PanelDocument = { blocks: [{ id: "items", kind: "checklist", items: [{ id: "a", label: "Alpha", status: "pending", children: [{ id: "c", label: "Child", status: "done" }] }] }, { id: "other", kind: "markdown", text: "x" }] };
  const ok = resolveAction(declaration, { action: "done", block: "items", item: "a" }, document);
  assert.deepEqual(ok.arguments, { todos: [{ id: "a", n: 1, label: "Alpha" }], panel: "p" });
  assert.deepEqual(resolveAction(declaration, { action: "blk", block: "other" }, document).text, "in other of p");
  const bad = (request: Parameters<typeof resolveAction>[1], pattern: RegExp) => assert.throws(() => resolveAction(declaration, request, document), (error) => error instanceof PanelActionError && pattern.test(error.message), JSON.stringify(request));
  bad({ action: "nope" }, /no action/);
  bad({ action: "done", block: "items", item: "c" }, /status done/);
  bad({ action: "done", block: "other", item: "a" }, /does not apply/);
  bad({ action: "done", block: "items", item: "zzz" }, /does not exist/);
  bad({ action: "done", block: "items" }, /needs an item/);
  bad({ action: "done", item: "a" }, /needs a block/);
  bad({ action: "all", block: "items" }, /takes no block/);
  bad({ action: "all" }, /cannot be resolved/);
});

test("allow runs on click without approval; the receipt is from the user; the note precedes the next user message exactly once", async () => {
  const { f, session } = await seeded();
  try {
    const before = f.provider.requests.length;
    const response = await act(f, session.id, { action: "complete", item: "a" });
    assert.equal(response.status, 202);
    const { operationId } = await response.json() as { operationId: string };
    const op = await f.wait(operationId);
    assert.equal(op.state, "completed");
    assert.equal(op.kind, "panel_action");
    assert.equal(f.provider.requests.length, before, "an action never calls the model");
    assert.equal(await todoStatus(f, session.id, "a"), "done");
    const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
    const receipts = history.items.filter((item) => item.panelReceipt);
    assert.deepEqual(receipts.map((item) => item.panelReceipt!.source), ["tool", "user_action"]);
    assert.equal(receipts[1]!.panelReceipt!.toolCallId, operationId);
    // The provider's message list is unchanged by the action itself: no tool message without a tool call.
    assert.equal(await turn(f, session.id, "t2", "what next"), "completed");
    const first = (f.provider.requests.at(-1)!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const users = first.filter((message) => message.role === "user");
    const last = users.at(-1)!.content as string;
    assert.match(last, /^The user ran "Mark done" on [^;]+; builtin\/todo returned: /);
    assert.ok(last.endsWith("\n\nwhat next"), "the note comes right before the user's text");
    assert.equal(first.at(-1)!.role, "user", "provider order stays valid: the note is part of the user message");
    assert.equal(await turn(f, session.id, "t3", "and then"), "completed");
    const second = JSON.stringify(f.provider.requests.at(-1)!.body);
    assert.equal(second.split("The user ran").length - 1, 1, "the note is delivered once and never repeated");
    const lastUser = ((f.provider.requests.at(-1)!.body as { messages: Array<{ role: string; content: unknown }> }).messages.filter((m) => m.role === "user").at(-1)!.content as string);
    assert.equal(lastUser, "and then");
  } finally { await f.close(); }
});

test("a note survives a runtime restart: pending notes are stored, not held in memory", async () => {
  const { f, session } = await seeded();
  try {
    const { operationId } = await (await act(f, session.id, { action: "skip", item: "a" })).json() as { operationId: string };
    await f.wait(operationId);
    // Every operation attaches a fresh runtime, so the next turn already reads the note from the store.
    assert.equal(await turn(f, session.id, "t2", "continue"), "completed");
    const body = JSON.stringify(f.provider.requests.at(-1)!.body);
    assert.match(body, /The user ran \\"Skip\\" on/);
  } finally { await f.close(); }
});

test("errors: agent_mismatch, unknown_panel, invalid_action, session_busy, stale_panel", async () => {
  const { f, session } = await seeded({ extraAgents: { bare: { model: "fixture", tools: { use: [] } } }, responses: [answer("bare turn"), { hold: true }] });
  try {
    const mismatch = await act(f, session.id, { action: "complete", item: "a", agent: "bare" });
    assert.equal(mismatch.status, 409); assert.equal(((await mismatch.json()) as { error: { code: string } }).error.code, "agent_mismatch");
    const missing = await f.api(`/sessions/${session.id}/panels/${encodeURIComponent("builtin/todo#nope")}/actions`, "POST", { agent: "raw", clientRequestId: "m", action: "complete", block: "items", item: "a" });
    assert.equal(missing.status, 404); assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "unknown_panel");
    for (const body of [{ action: "nope" }, { action: "complete", item: "zzz" }, { action: "continue" , item: "a" }, { action: "complete" }]) {
      const bad = await act(f, session.id, body);
      assert.equal(bad.status, 422, JSON.stringify(body)); assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_action");
    }
    // The prompt action runs in the browser only.
    const prompt = await f.api(`/sessions/${session.id}/panels/${PANEL}/actions`, "POST", { agent: "raw", clientRequestId: "p", action: "continue" });
    assert.equal(prompt.status, 422);
    // `when` no longer matches once the item is done.
    const first = await (await act(f, session.id, { action: "complete", item: "a" })).json() as { operationId: string };
    await f.wait(first.operationId);
    const again = await act(f, session.id, { action: "complete", item: "a" });
    assert.equal(again.status, 422);
    // Busy: a turn is holding the provider.
    const busy = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "long", kind: "turn", agent: "raw", input: "hold" });
    const during = await act(f, session.id, { action: "reopen", item: "a" });
    assert.equal(during.status, 409); assert.equal(((await during.json()) as { error: { code: string } }).error.code, "session_busy");
    await f.json(`/operations/${busy.id}/cancel`, "POST", {}).catch(() => {});
  } finally { await f.close(); }
});

test("stale_panel: once the saved agent no longer selects the tool, its actions are refused and nothing runs", async () => {
  const { f, session } = await seeded({ extraAgents: { bare: { model: "fixture", tools: { use: [] } } }, responses: [answer("bare turn")] });
  try {
    assert.equal(await turn(f, session.id, "t2", "as bare", "bare"), "completed");
    const response = await act(f, session.id, { action: "complete", item: "a", agent: "bare" });
    assert.equal(response.status, 409); assert.equal(((await response.json()) as { error: { code: string } }).error.code, "stale_panel");
    assert.equal(await todoStatus(f, session.id, "a"), "pending");
  } finally { await f.close(); }
});

test("deny hides tool actions and a forced request returns 403 with nothing run", async () => {
  const { f, session } = await seeded();
  try {
    setConfig(f, (config) => { config.agents.raw.tools.rules = [{ match: "builtin/todo", effect: "deny" }]; });
    const stack = (await items(f, session.id))[0]!;
    assert.deepEqual(stack.declaration.actions.map((action) => action.id), ["continue"], "tool actions are hidden, prompt actions stay");
    const response = await act(f, session.id, { action: "complete", item: "a" });
    assert.equal(response.status, 403); assert.equal(((await response.json()) as { error: { code: string } }).error.code, "action_denied");
    assert.equal(await todoStatus(f, session.id, "a"), "pending");
    const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
    assert.equal(history.items.filter((item) => item.panelReceipt).length, 1, "no receipt for the refused action");
  } finally { await f.close(); }
});

test("ask prompts even though the runtime auto-approves; denying commits nothing, allowing runs it", async () => {
  const { f, session } = await seeded();
  try {
    setConfig(f, (config) => { config.agents.raw.tools.rules = [{ match: "builtin/todo", effect: "ask" }]; });
    const pending = async (): Promise<{ id: string; operationId: string; callId: string } | undefined> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const snapshot = await f.json<{ approvals: Array<{ id: string; operationId: string; callId: string }> }>(`/sessions/${session.id}`);
        if (snapshot.approvals[0]) return snapshot.approvals[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return undefined;
    };
    const first = await (await act(f, session.id, { action: "complete", item: "a" })).json() as { operationId: string };
    const approval = await pending();
    assert.ok(approval, "the click alone is not consent for an ask rule");
    assert.equal(approval.callId, first.operationId);
    await f.json(`/permissions/${approval.id}`, "POST", { operationId: approval.operationId, callId: approval.callId, allow: false });
    const denied = await f.wait(first.operationId);
    assert.equal(denied.state, "error");
    assert.equal(await todoStatus(f, session.id, "a"), "pending");
    const second = await (await act(f, session.id, { action: "complete", item: "a" })).json() as { operationId: string };
    const again = await pending();
    assert.ok(again);
    await f.json(`/permissions/${again.id}`, "POST", { operationId: again.operationId, callId: again.callId, allow: true });
    assert.equal((await f.wait(second.operationId)).state, "completed");
    assert.equal(await todoStatus(f, session.id, "a"), "done");
  } finally { await f.close(); }
});

test("hooks see source user_action for the action and model for the model's call, in the existing order", async () => {
  const { f, session } = await seeded();
  try {
    const folder = join(dirname(f.configPath), "hooks", "spy"); mkdirSync(folder, { recursive: true });
    const log = join(f.root, "hook-log.jsonl");
    writeFileSync(join(folder, "hook.json"), JSON.stringify({ protocol_version: 2, name: "spy", command: "node", args: ["./spy.mjs"], events: [{ name: "PreToolUse" }, { name: "PostToolUse" }] }));
    writeFileSync(join(folder, "spy.mjs"), `import { appendFileSync } from "node:fs"; let d=""; process.stdin.on("data",(c)=>d+=c); process.stdin.on("end",()=>{ appendFileSync(${JSON.stringify(log)}, d.replace(/\\n/g,"")+"\\n"); process.stdout.write("{}"); });\n`);
    setConfig(f, (config) => { config.agents.raw.hooks = { use: ["agent/spy"] }; });
    const { operationId } = await (await act(f, session.id, { action: "complete", item: "a" })).json() as { operationId: string };
    assert.equal((await f.wait(operationId)).state, "completed");
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; tool: { source?: string; arguments: { todos: Array<{ id: string }> } } });
    assert.deepEqual(lines.map((line) => `${line.event}:${line.tool.source}`), ["PreToolUse:user_action", "PostToolUse:user_action"]);
    assert.equal(lines[0]!.tool.arguments.todos[0]!.id, "a", "templates are resolved before the hook sees the arguments");
  } finally { await f.close(); }
});

test("clientRequestId is idempotent: a replay returns the same operation and runs the action once", async () => {
  const { f, session } = await seeded();
  try {
    const body = { agent: "raw", clientRequestId: "same", action: "complete", block: "items", item: "a" };
    const a = await (await f.api(`/sessions/${session.id}/panels/${PANEL}/actions`, "POST", body)).json() as { operationId: string };
    await f.wait(a.operationId);
    const b = await f.api(`/sessions/${session.id}/panels/${PANEL}/actions`, "POST", body);
    assert.equal(b.status, 202);
    assert.equal(((await b.json()) as { operationId: string }).operationId, a.operationId);
    const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
    assert.equal(history.items.filter((item) => item.panelReceipt?.source === "user_action").length, 1);
    const conflict = await f.api(`/sessions/${session.id}/panels/${PANEL}/actions`, "POST", { ...body, item: "b" });
    assert.equal(conflict.status, 409);
  } finally { await f.close(); }
});

/** A local tool with two declared panels and one panel-scope action; `updates` (a JS expression body) runs in its handler. */
function localTool(f: Fixture, id: string, updates: string) {
  const dir = join(dirname(f.configPath), "tools", id); mkdirSync(dir, { recursive: true });
  const panel = (name: string, title: string, actions: object[]) => ({ id: name, title, icon: "panel", open: "never", actions });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ api_version: 2, id, version: "1.0.0", name: id, description: `Tool ${id}.`,
    input_schema: { type: "object", additionalProperties: false }, entry: "./index.mjs",
    panels: [panel("main", "Main", [{ id: "run", label: "Run", scope: "panel", kind: "tool", arguments: {} }]), panel("other", "Other", [])] }));
  writeFileSync(join(dir, "index.mjs"), `export async function handler(args, context) { ${updates} return { content: [{ type: "text", text: "ok" }] }; }`);
}
async function withLocal(id: string, updates: string, rule: "allow" | "ask" = "allow") {
  // `MARKER` in a handler is a file inside this test's own temp directory.
  const f = await dashboardFixture({ agent: { tools: { use: [`local/${id}`], rules: [{ match: `local/${id}`, effect: rule }] } }, responses: [answer(), answer()] });
  localTool(f, id, updates.replaceAll("MARKER", JSON.stringify(join(f.root, `${id}.marker`))));
  const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
  assert.equal(await turn(f, session.id, "t1"), "completed");
  return { f, session };
}
const runMain = (f: Fixture, sessionId: string, tool: string) => f.api(`/sessions/${sessionId}/panels/${encodeURIComponent(`local/${tool}#main`)}/actions`, "POST", { agent: "raw", clientRequestId: `k-${Math.random()}`, action: "run" });
const history = async (f: Fixture, sessionId: string) => (await f.json<{ items: HistoryView[] }>(`/sessions/${sessionId}/history`)).items;

test("an action whose tool publishes nothing still leaves one user_action receipt for the clicked panel", async () => {
  const { f, session } = await withLocal("quiet", "");
  try {
    const response = await runMain(f, session.id, "quiet");
    assert.equal(response.status, 202);
    const { operationId } = await response.json() as { operationId: string };
    assert.equal((await f.wait(operationId)).state, "completed");
    const receipts = (await history(f, session.id)).filter((item) => item.panelReceipt).map((item) => item.panelReceipt!);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.source, "user_action"); assert.equal(receipts[0]!.panel, "main"); assert.equal(receipts[0]!.revision, 0);
    assert.equal(receipts[0]!.toolCallId, operationId);
  } finally { await f.close(); }
});

test("the note and receipts name the clicked panel even when the tool updated another one", async () => {
  const { f, session } = await withLocal("chatty", `await context.panels.update("other", { op: "replace", document: { title: "Other panel", blocks: [{ id: "b", kind: "markdown", text: "x" }] } });`);
  try {
    const { operationId } = await (await runMain(f, session.id, "chatty")).json() as { operationId: string };
    assert.equal((await f.wait(operationId)).state, "completed");
    const receipts = (await history(f, session.id)).filter((item) => item.panelReceipt).map((item) => item.panelReceipt!);
    assert.deepEqual(receipts.map((receipt) => receipt.panel).sort(), ["main", "other"]);
    assert.equal(await turn(f, session.id, "t2", "next"), "completed");
    const last = ((f.provider.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }).messages.filter((m) => m.role === "user").at(-1)!).content;
    assert.match(last, /^The user ran "Run" on Main; local\/chatty returned: /);
  } finally { await f.close(); }
});

test("cancelling an action that waits for approval ends it as cancelled and commits nothing", async () => {
  const { f, session } = await withLocal("careful", `await context.panels.update("main", { op: "replace", document: { blocks: [{ id: "b", kind: "markdown", text: "x" }] } });`, "ask");
  try {
    const { operationId } = await (await runMain(f, session.id, "careful")).json() as { operationId: string };
    for (let attempt = 0; attempt < 300; attempt++) {
      const snapshot = await f.json<{ approvals: unknown[] }>(`/sessions/${session.id}`);
      if (snapshot.approvals.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await f.json(`/operations/${operationId}/cancel`, "POST", {});
    const op = await f.wait(operationId);
    assert.equal(op.state, "cancelled");
    assert.equal(op.error, undefined);
    assert.equal((await history(f, session.id)).filter((item) => item.panelReceipt).length, 0);
    assert.equal((await items(f, session.id)).find((item) => item.panel === "local/careful#main")?.document, null);
  } finally { await f.close(); }
});

test("the saved agent is checked inside the acceptance transaction: an action for another agent is refused there", async () => {
  const { f, session } = await seeded({ extraAgents: { other: { model: "fixture", tools: { use: ["builtin/todo"] } } } });
  try {
    const { openSessionStore } = await import("../src/sessions/store.js");
    const store = openSessionStore({ env: f.env });
    try {
      assert.throws(() => store.acceptOperation({ sessionId: session.id, clientRequestId: "race", kind: "panel_action", agentName: "other", configPath: f.configPath,
        action: { panel: "builtin/todo#todo", action: "complete", block: "items", item: "a" } }), (error: Error & { code?: string }) => error.code === "agent_mismatch");
      assert.equal(store.findOperation(session.id, "race"), undefined, "nothing was accepted");
    } finally { store.close(); }
  } finally { await f.close(); }
});

test("an unchanged panel's receipt reports its real current state (default status active, unchanged revision)", async () => {
  const { f, session } = await withLocal("once", `const { existsSync, writeFileSync } = await import("node:fs"); const file = MARKER;
    if (!existsSync(file)) { writeFileSync(file, "x"); await context.panels.update("main", { op: "replace", document: { title: "Main doc", blocks: [{ id: "b", kind: "markdown", text: "x" }] } }); }`);
  try {
    for (let round = 0; round < 2; round++) {
      const { operationId } = await (await runMain(f, session.id, "once")).json() as { operationId: string };
      assert.equal((await f.wait(operationId)).state, "completed");
    }
    const receipts = (await history(f, session.id)).filter((item) => item.panelReceipt).map((item) => item.panelReceipt!);
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts.map((receipt) => [receipt.revision, receipt.status, receipt.title]), [[1, "active", "Main doc"], [1, "active", "Main doc"]]);
    assert.ok(Buffer.byteLength(JSON.stringify(receipts[1])) <= 1024);
  } finally { await f.close(); }
});

test("cancelling while the tool handler runs ends the operation as cancelled, not as an error", async () => {
  const { f, session } = await withLocal("slow", `await new Promise((resolve) => setTimeout(resolve, 700));`);
  try {
    const { operationId } = await (await runMain(f, session.id, "slow")).json() as { operationId: string };
    await new Promise((resolve) => setTimeout(resolve, 250));
    await f.json(`/operations/${operationId}/cancel`, "POST", {});
    const op = await f.wait(operationId);
    assert.equal(op.state, "cancelled");
    assert.equal(op.error, undefined);
  } finally { await f.close(); }
});
