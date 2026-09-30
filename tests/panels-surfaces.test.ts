import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk";
import { createAcpServer } from "../src/acp/methods.js";
import { loadConfig } from "../src/config.js";
import { planEntries, selectPanels } from "../src/panels/render.js";
import type { PanelDocument, StoredPanel } from "../src/panels/contract.js";
import { openSessionStore } from "../src/sessions/store.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
import { testConfig } from "./fixtures/config.js";

const todoCall = (id: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function",
  function: { name: "todo", arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const answer = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const TODOS = { title: "Ship", todos: [{ id: "a", content: "Alpha", status: "pending" }, { id: "b", content: "Beta", status: "in_progress" }] };
type Fixture = Awaited<ReturnType<typeof dashboardFixture>>;

/** Runs the CLI as a child process; asynchronous, because the mock provider lives in this process. */
function raw(f: Fixture, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
      { cwd: f.root, env: { ...f.env, OPENAI_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
async function withTodoRun(action: (f: Fixture, sessionId: string, run: Awaited<ReturnType<typeof raw>>) => Promise<void>) {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] } }, responses: [todoCall("c1", TODOS), answer("all planned"), answer("more")] });
  try {
    const run = await raw(f, ["--config", f.configPath, "--agent", "raw", "-y", "plan it"]);
    const listed = await raw(f, ["sessions", "--all"]);
    await action(f, listed.stdout.split("\t")[0]!.trim(), run);
  } finally { await f.close(); }
}

test("one-shot run: stdout is only the answer and the receipt line goes to stderr with glyphs, not color", async () => {
  await withTodoRun(async (_f, _id, run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "all planned");
    assert.doesNotMatch(run.stdout, /▸/);
    assert.match(run.stderr, /^  ▸ Ship r1 · 0\/2 · /m);
    assert.doesNotMatch(run.stderr.split("\n").find((line) => line.includes("▸"))!, /\u001b\[/, "no escape codes when stderr is not a terminal");
  });
});

test("raw sessions panels prints open panels as text and JSON without any model credential; unknown ids fail", async () => {
  await withTodoRun(async (f, id) => {
    const text = await raw(f, ["sessions", "panels", id]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^Ship \(0\/2\)/);
    assert.match(text.stdout, /\[ \] Alpha/); assert.match(text.stdout, /\[~\] Beta/);
    const one = await raw(f, ["sessions", "panels", id, "todo"]);
    assert.equal(one.stdout, text.stdout, "a local panel id selects the same panel");
    const json = JSON.parse((await raw(f, ["sessions", "panels", id, "--json"])).stdout) as Array<{ panel: string; owner: string; revision: number; closed: boolean; document: PanelDocument }>;
    assert.equal(json.length, 1);
    assert.deepEqual([json[0]!.panel, json[0]!.owner, json[0]!.revision, json[0]!.closed], ["builtin/todo#todo", "builtin/todo", 1, false]);
    assert.equal(json[0]!.document.blocks[0]!.kind, "checklist");
    const missing = await raw(f, ["sessions", "panels", id, "nope"]);
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /unknown panel nope/);
    assert.notEqual((await raw(f, ["sessions", "panels", "no-such-session"])).status, 0);
    assert.notEqual((await raw(f, ["sessions", "--json"])).status, 0, "--json belongs to sessions panels only");
    assert.notEqual((await raw(f, ["sessions", "show", id, "--json"])).status, 0, "also not on sessions show");
  });
});

test("REPL /panels prints open panels, one panel by id, and rejects an unknown one", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] } }, responses: [todoCall("c1", TODOS), answer("planned")] });
  try {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), "--config", f.configPath, "--agent", "raw", "--interactive", "-y"],
      { cwd: f.root, env: { ...f.env, OPENAI_API_KEY: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    const until = async (read: () => string, token: string) => { for (let i = 0; i < 500 && !read().includes(token); i++) await new Promise((resolve) => setTimeout(resolve, 20)); assert.ok(read().includes(token), `missing ${token}: ${read().slice(-300)}`); };
    await until(() => stdout, "> ");
    child.stdin.write("/panels\n"); await until(() => stderr, "no open panels");
    child.stdin.write("plan it\n"); await until(() => stdout, "planned");
    child.stdin.write("/panels\n"); await until(() => stderr, "[~] Beta");
    child.stdin.write("/panels todo\n"); await until(() => stderr.slice(stderr.lastIndexOf("Ship")), "[ ] Alpha");
    child.stdin.write("/panels nope\n"); await until(() => stderr, "unknown panel nope");
    child.stdin.write("/exit\n");
    await new Promise((resolve) => child.once("close", resolve));
  } finally { await f.close(); }
});

test("selectPanels: open by default, closed with all, by full or unambiguous local id", () => {
  const panel = (owner: string, id: string, closed: boolean): StoredPanel => ({ panelId: `${owner}#${id}`, owner, revision: 1, createdAt: 1, updatedAt: 1, closed,
    declaration: { id, title: id, icon: "panel", open: "never", context: "none", acp_plan: false, actions: [] }, document: { blocks: [] } });
  const all = [panel("a/x", "main", false), panel("b/y", "main", false), panel("a/x", "old", true)];
  assert.deepEqual(selectPanels(all)?.map((item) => item.panelId), ["a/x#main", "b/y#main"]);
  assert.deepEqual(selectPanels(all, { all: true })?.length, 3);
  assert.equal(selectPanels(all, { id: "main" }), undefined, "an ambiguous local id selects nothing");
  assert.deepEqual(selectPanels(all, { id: "b/y#main" })?.map((item) => item.panelId), ["b/y#main"]);
  assert.equal(selectPanels(all, { id: "old" }), undefined, "closed panels need all");
  assert.deepEqual(selectPanels(all, { id: "old", all: true })?.map((item) => item.panelId), ["a/x#old"]);
});

test("planEntries flattens the first checklist depth-first with the §6 status mapping and default priority", () => {
  const doc: PanelDocument = { blocks: [
    { id: "m", kind: "markdown", text: "x" },
    { id: "c", kind: "checklist", items: [
      { id: "1", label: "One", status: "done", children: [{ id: "1a", label: "One A", status: "skipped" }, { id: "1b", label: "One B", status: "failed", priority: "high" }] },
      { id: "2", label: "Two", status: "in_progress" }, { id: "3", label: "Three", status: "blocked", priority: "low" }, { id: "4", label: "Four" }] },
    { id: "c2", kind: "checklist", items: [{ id: "z", label: "Ignored" }] }] };
  assert.deepEqual(planEntries(doc), [
    { content: "One", priority: "medium", status: "completed" }, { content: "One A", priority: "medium", status: "completed" },
    { content: "One B", priority: "high", status: "pending" }, { content: "Two", priority: "medium", status: "in_progress" },
    { content: "Three", priority: "low", status: "pending" }, { content: "Four", priority: "medium", status: "pending" }]);
  assert.deepEqual(planEntries({ blocks: [] }), []);
});

/** An ACP peer whose registered tool answers every call with the next panel document. */
async function acpScenario(options: { negotiate?: boolean; ask?: boolean; builtinTodo?: boolean; timeoutMs?: number; placement?: "chat" | "sidebar" } = {}) {
  const configPath = join(mkdtempSync(join(tmpdir(), "raw-panels-acp-config-")), "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "fixture",
    models: { fixture: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { fixture: { model: "fixture", tools: { use: options.builtinTodo ? ["builtin/todo"] : [], ...(options.ask ? { rules: [{ match: "acp:*", effect: "ask" }] } : {}) } } } }));
  const runtime = await loadConfig({ flags: { configPath, autoApprove: true, ...(options.timeoutMs ? { requestTimeoutMs: options.timeoutMs } : {}) }, env: {}, requireModel: true });
  const state = mkdtempSync(join(tmpdir(), "raw-panels-acp-state-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } };
  const cwd = mkdtempSync(join(tmpdir(), "raw-panels-acp-cwd-"));
  let alias = ""; let version = 0; let calls = 0; let permission: "allow" | "deny" = "allow"; let hang = false;
  const documents = [
    { blocks: [{ id: "c", kind: "checklist", items: [{ id: "a", label: "Write", status: "in_progress" }, { id: "b", label: "Test", children: [{ id: "b1", label: "Unit", status: "done" }] }] }] },
    { blocks: [{ id: "c", kind: "checklist", items: [{ id: "a", label: "Write", status: "done" }, { id: "b", label: "Test", status: "in_progress" }] }] },
    { blocks: [{ id: "c", kind: "checklist", items: [{ id: "a", label: "Write", status: "done" }, { id: "b", label: "Test", status: "done" }] }] },
  ];
  let turn = 0;
  const provider = () => ({ modelConfig: runtime.modelConfig!, generate: async (request: { messages: Array<{ role: string }> }) => {
    if (request.messages.at(-1)?.role === "tool") return { text: `answer-${++turn}`, toolCalls: [], finishReason: "stop" as const };
    if (options.builtinTodo) return { text: "", toolCalls: [{ id: `call-${turn}`, name: "todo", arguments: { title: "Ship", todos: [{ id: "a", content: "Alpha", status: "done" }, { id: "b", content: "Beta", status: "blocked" }] } }], finishReason: "tool_calls" as const };
    return { text: "", toolCalls: [{ id: `call-${turn}`, name: alias, arguments: {} }], finishReason: "tool_calls" as const };
  } });
  const start = async (label: string, negotiate = options.negotiate ?? true) => {
    const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: provider as never, storeOptions });
    const peer = client({ name: label });
    const notes: Array<{ method: string; params: any }> = [];
    peer.onNotification("session/update", ({ params }) => { notes.push({ method: "session/update", params }); });
    peer.onNotification("_raw/panel/update" as never, (params: unknown) => params, ({ params }: { params: unknown }) => { notes.push({ method: "_raw/panel/update", params }); });
    peer.onRequest("_raw/tool/call", (params: unknown) => params, () => { calls++; if (hang) return new Promise(() => {}); return { isError: false, content: [{ type: "panel", panel: "todo", op: "replace", document: documents[Math.min(version++, documents.length - 1)] }] }; });
    peer.onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: permission } }));
    const connection = peer.connect(server.app);
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, _meta: { raw: { toolRegister: true, toolCall: true, ...(negotiate ? { panelsV2: true } : {}) } } });
    return { server, connection, notes, close: async () => { connection.close(); await server.close(); } };
  };
  const register = async (peer: Awaited<ReturnType<typeof start>>, sessionId: string, actions: object[] = []) => {
    const registration = await peer.connection.agent.request<{ alias: string }>("_raw/tool/register", { sessionId, name: "todo_tool", description: "Todo", inputSchema: { type: "object" },
      panels: [{ id: "todo", title: "Todo", icon: "list-checks", acp_plan: options.placement !== "chat", actions,
        ...(options.placement ? { placement: options.placement } : {}) }] });
    alias = registration.alias;
  };
  return { start, register, cwd, storeOptions, calls: () => calls, permission: (value: "allow" | "deny") => { permission = value; }, hang: () => { hang = true; } };
}
const plans = (notes: Array<{ method: string; params: any }>) => notes.filter((note) => note.method === "session/update" && note.params.update.sessionUpdate === "plan").map((note) => note.params.update.entries as unknown[]);

test("ACP chat views carry distinct call identities and replay their immutable snapshots in history order", async () => {
  const scenario = await acpScenario({ placement: "chat" });
  const first = await scenario.start("inline-first");
  let sessionId = "";
  let snapshots: unknown[] = [];
  try {
    ({ sessionId } = await first.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] }));
    await scenario.register(first, sessionId);
    for (const text of ["one", "two"]) await first.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const frames = first.notes.filter(note => note.method === "_raw/panel/update");
    assert.equal(frames.length, 2);
    assert.notEqual(frames[0]!.params.view.instanceId, frames[1]!.params.view.instanceId);
    assert.deepEqual(frames.map(note => note.params.revision), [1, 1]);
    assert.deepEqual(plans(first.notes), []);
    snapshots = frames.map(note => ({ view: note.params.view, document: note.params.document }));
  } finally { await first.close(); }
  const second = await scenario.start("inline-reload");
  try {
    await second.connection.agent.request("session/load", { sessionId, cwd: scenario.cwd, mcpServers: [] });
    const frames = second.notes.filter(note => note.method === "_raw/panel/update");
    assert.deepEqual(frames.map(note => ({ view: note.params.view, document: note.params.document })), snapshots);
    assert.deepEqual(plans(second.notes), []);
  } finally { await second.close(); }
});

test("ACP: a committed update sends the standard plan and, once negotiated, _raw/panel/update", async () => {
  const scenario = await acpScenario();
  const peer = await scenario.start("peer");
  try {
    const { sessionId } = await peer.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] });
    await scenario.register(peer, sessionId);
    await peer.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    assert.deepEqual(plans(peer.notes), [[
      { content: "Write", priority: "medium", status: "in_progress" }, { content: "Test", priority: "medium", status: "pending" }, { content: "Unit", priority: "medium", status: "completed" }]]);
    const raw = peer.notes.filter((note) => note.method === "_raw/panel/update");
    assert.equal(raw.length, 1);
    assert.deepEqual([raw[0]!.params.sessionId, raw[0]!.params.revision, raw[0]!.params.closed, raw[0]!.params.declaration.acp_plan, raw[0]!.params.panel.endsWith("#todo")], [sessionId, 1, false, true, true]);
    assert.equal(raw[0]!.params.document.blocks[0].id, "c");
  } finally { await peer.close(); }
});

test("ACP: a client that did not negotiate panels still gets the standard plan, and never the extension message", async () => {
  const scenario = await acpScenario({ builtinTodo: true });
  const peer = await scenario.start("plain", false);
  try {
    const { sessionId } = await peer.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] });
    await peer.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    assert.deepEqual(plans(peer.notes), [[{ content: "Alpha", priority: "medium", status: "completed" }, { content: "Beta", priority: "medium", status: "pending" }]]);
    assert.equal(peer.notes.filter((note) => note.method === "_raw/panel/update").length, 0);
  } finally { await peer.close(); }
});

test("ACP: load replays receipts in history position, then sends only the latest open state once; resume sends it once with no replay", async () => {
  const scenario = await acpScenario();
  const first = await scenario.start("first");
  let sessionId = "";
  try {
    ({ sessionId } = await first.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] }));
    await scenario.register(first, sessionId);
    await first.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] });
    await first.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] });
  } finally { await first.close(); }
  const second = await scenario.start("second");
  try {
    await second.connection.agent.request("session/load", { sessionId, cwd: scenario.cwd, mcpServers: [] });
    const flow = second.notes.filter((note) => note.method === "session/update").map((note) => note.params.update as SessionUpdate);
    const label = (update: SessionUpdate) => update.sessionUpdate === "plan" ? "plan"
      : update.sessionUpdate === "user_message_chunk" ? `user:${(update.content as { text: string }).text}`
      : update.sessionUpdate === "agent_message_chunk" ? `agent:${(update.content as { text: string }).text}`
      : update.sessionUpdate === "agent_thought_chunk" && /^▸ Todo r\d/.test((update.content as { text: string }).text) ? `receipt:${(update.content as { text: string }).text.split(" ")[2]}` : "other";
    const seen = flow.map(label).filter((item) => item !== "other");
    assert.deepEqual(seen, ["user:one", "receipt:r1", "agent:answer-1", "user:two", "receipt:r2", "agent:answer-2", "plan"]);
    const latest = plans(second.notes);
    assert.equal(latest.length, 1, "history states are not reconstructed: one plan, after everything");
    assert.deepEqual(latest[0], [{ content: "Write", priority: "medium", status: "completed" }, { content: "Test", priority: "medium", status: "in_progress" }]);
    const raw = second.notes.filter((note) => note.method === "_raw/panel/update");
    assert.deepEqual(raw.map((note) => note.params.revision), [2]);
    assert.equal(second.notes.at(-1)!.method, "_raw/panel/update", "the state comes after the whole history");
  } finally { await second.close(); }
  const third = await scenario.start("third");
  try {
    let during: Promise<unknown> | undefined;
    const original = third.notes.push.bind(third.notes);
    third.notes.push = (...items) => {
      during ??= third.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "too early" }] }).catch((error: { code: number }) => error.code);
      return original(...items);
    };
    await third.connection.agent.request("session/resume", { sessionId, cwd: scenario.cwd, mcpServers: [] });
    assert.equal(await during, -32002, "the session is busy until its current panel state is delivered");
    assert.equal(third.notes.filter((note) => note.method === "session/update" && note.params.update.sessionUpdate !== "plan").length, 0, "no replay on resume");
    assert.equal(plans(third.notes).length, 1);
    assert.equal(third.notes.filter((note) => note.method === "_raw/panel/update").length, 1);
  } finally { await third.close(); }
  const plain = await scenario.start("plain", false);
  try {
    await plain.connection.agent.request("session/resume", { sessionId, cwd: scenario.cwd, mcpServers: [] });
    assert.equal(plain.notes.filter((note) => note.method === "_raw/panel/update").length, 0, "extension messages need negotiation");
    assert.equal(plans(plain.notes).length, 1);
  } finally { await plain.close(); }
  openSessionStore(scenario.storeOptions).close();
});

test("ACP _raw/panel/action runs a declared tool action through dispatch and returns its operation id; errors use the extension codes", async () => {
  const scenario = await acpScenario({ ask: true });
  const peer = await scenario.start("peer");
  try {
    const { sessionId } = await peer.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] });
    await scenario.register(peer, sessionId, [{ id: "again", label: "Again", scope: "panel", kind: "tool", arguments: {} }, { id: "say", label: "Say", scope: "panel", kind: "prompt", text: "hi" }]);
    await peer.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    const panel = peer.notes.find((note) => note.method === "_raw/panel/update")!.params.panel as string;
    const before = scenario.calls();
    const result = await peer.connection.agent.request<{ operationId: string }>("_raw/panel/action", { sessionId, panel, action: "again" });
    assert.match(result.operationId, /^[0-9a-f-]{36}$/);
    assert.equal(scenario.calls(), before + 1, "the owning tool's handler ran");
    assert.equal(peer.notes.filter((note) => note.method === "_raw/panel/update").at(-1)!.params.revision, 2);
    const code = (promise: Promise<unknown>) => promise.then(() => 0, (error: { code: number }) => error.code);
    assert.equal(await code(peer.connection.agent.request("_raw/panel/action", { sessionId, panel, action: "nope" })), -32602);
    assert.equal(await code(peer.connection.agent.request("_raw/panel/action", { sessionId, panel, action: "say" })), -32602, "prompt actions run in the client");
    assert.equal(await code(peer.connection.agent.request("_raw/panel/action", { sessionId, panel: "acp/x#y", action: "again" })), -32602);
    assert.equal(await code(peer.connection.agent.request("_raw/panel/action", { sessionId: "missing", panel, action: "again" })), -32001);
    // Ask is never skipped: the client denies the permission request, so nothing runs.
    scenario.permission("deny");
    const ran = scenario.calls();
    assert.equal(await code(peer.connection.agent.request("_raw/panel/action", { sessionId, panel, action: "again" })), -32004);
    assert.equal(scenario.calls(), ran);
  } finally { await peer.close(); }
  const plain = await scenario.start("plain", false);
  try {
    const { sessionId } = await plain.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] });
    await assert.rejects(plain.connection.agent.request("_raw/panel/action", { sessionId, panel: "a#b", action: "c" }), (error: { code: number }) => error.code === -32003);
  } finally { await plain.close(); }
});

test("ACP _raw/panel/action reports a reverse-tool timeout as -32005", async () => {
  const scenario = await acpScenario({ timeoutMs: 150 });
  const peer = await scenario.start("peer");
  try {
    const { sessionId } = await peer.connection.agent.request("session/new", { cwd: scenario.cwd, mcpServers: [] });
    await scenario.register(peer, sessionId, [{ id: "again", label: "Again", scope: "panel", kind: "tool", arguments: {} }]);
    await peer.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    const panel = peer.notes.find((note) => note.method === "_raw/panel/update")!.params.panel as string;
    scenario.hang();
    await assert.rejects(peer.connection.agent.request("_raw/panel/action", { sessionId, panel, action: "again" }), (error: { code: number }) => error.code === -32005);
  } finally { await peer.close(); }
});
