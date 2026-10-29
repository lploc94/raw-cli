import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createAgent, type RunEvent } from "../src/agent.js";
import { CLAUDE_ADAPTER, adapterDirectory } from "../src/backends/adapters.js";
import { startBridge } from "../src/backends/bridge/server.js";
import { createAcpSessionAgent, sessionIdentity } from "../src/backends/factory.js";
import { loadConfig } from "../src/config.js";
import type { InteractionRequest } from "../src/interactions/contract.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { dashboardFixture } from "./fixtures/dashboard.js";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");
const TODO = { title: "Ship", todos: [{ content: "Write tests", status: "in_progress" }, { content: "Docs", status: "pending" }] };

/** A `claude` on PATH and an installed "adapter" that is the fake ACP agent, so the real Claude launch runs it. */
function fakeClaude(root: string): Record<string, string> {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, XDG_DATA_HOME: join(root, "data"), FAKE_ACP_STATE: join(root, "fake") };
  const entry = join(adapterDirectory(CLAUDE_ADAPTER, env), "node_modules", ...CLAUDE_ADAPTER.name.split("/"), CLAUDE_ADAPTER.entry);
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(FAKE).href)};\n`);
  return env;
}

/** The fake adapter's log: every ACP call and every MCP server it started. */
function calls(root: string): Array<Record<string, unknown>> {
  const dir = join(root, "fake");
  return readdirSync(dir).filter((name) => name.startsWith("calls-")).flatMap((name) =>
    readFileSync(join(dir, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>));
}

type Step = string | ((agent: ReturnType<typeof createAcpSessionAgent>) => Promise<unknown>);

async function backendTurn(root: string, agent: Record<string, unknown>, inputs: Step[],
  options: { approve?: () => boolean; onEvent?: (event: RunEvent, agent: { abort(): boolean }) => void } = {}) {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "c", agents: { c: { backend: { kind: "claude" }, ...agent } } }));
  const runtime = await loadConfig({ configPath, env: { XDG_CONFIG_HOME: root } });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const session = store.createSession({ cwd: root, title: "t", ...sessionIdentity(runtime) });
  const events: RunEvent[] = [];
  const created = createAcpSessionAgent({ runtime, tools, cwd: root,
    host: { ...(options.approve ? { approve: options.approve } : {}), persistence: { store, sessionId: session.id, surface: "web" } } },
    { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ACP_STATE: join(root, "fake") } });
  const results: Array<Awaited<ReturnType<typeof created.run>>> = [];
  // Raw's own stderr during the turns: the token must not reach it (Invariant 3).
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { stderr += String(chunk); return (write as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  try {
    for (const input of inputs) {
      if (typeof input === "function") await input(created);
      else results.push(await created.run(input, (event) => { events.push(event); options.onEvent?.(event, created); }));
    }
  }
  finally { process.stderr.write = write; await created.close(); await tools.mcp.close(); }
  return { results, events, store, session, warnings: tools.warnings, stderr };
}

const panelShape = (events: RunEvent[]) => events.filter((event) => event.type === "panel_update")
  .map(({ turnId: _turn, segmentId: _segment, view: _view, ...event }) => event);

test("the bridge binds loopback and refuses requests without the exact token, with a browser origin, or off its path", async () => {
  const bridge = await startBridge({ tools: () => [], call: async () => assert.fail("no call expected") });
  try {
    const url = new URL(bridge.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(bridge.token, /^[0-9a-f]{64}$/);
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const post = (headers: Record<string, string>, target = bridge.url) => fetch(target, { method: "POST", body: initialize,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${"0".repeat(64)}` })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${bridge.token}x` })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${bridge.token}`, Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ Authorization: `Bearer ${bridge.token}` }, bridge.url.replace("/mcp", "/other"))).status, 404);
    const accepted = await post({ Authorization: `Bearer ${bridge.token}` });
    assert.equal(accepted.status, 200);
    await accepted.body?.cancel();
    // Another interface of this machine does not reach it.
    const external = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal);
    if (external) await assert.rejects(fetch(`http://${external.address}:${url.port}/mcp`, { signal: AbortSignal.timeout(3000) }));
  } finally { await bridge.close(); }
});

test("the CLI sees the bridged selection minus deny, through the real proxy, and the token is only in the proxy's environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    const { results, store, session, warnings, stderr } = await backendTurn(root, { tools: { use: ["builtin/todo", "builtin/ask_user", "builtin/list_skills", "builtin/bash"],
      rules: [{ match: "builtin/ask_user", effect: "deny" }] } }, ["bridge-list"]);
    assert.equal(results[0]!.status, "completed", JSON.stringify(results[0]));
    assert.equal(results[0]!.text, "tools:todo,list_skills");
    assert.deepEqual(warnings, ['claude agent "c" skips builtin/bash: Claude Code uses its own shell tool']);
    const spawned = calls(root).find((call) => call.method === "mcp/spawn")!;
    assert.equal(spawned.name, "raw");
    assert.deepEqual(spawned.envNames, ["RAW_BRIDGE_URL", "RAW_BRIDGE_TOKEN"]);
    assert.ok((spawned.args as string[]).includes("__bridge-proxy"));
    const token = /[0-9a-f]{64}/;
    assert.ok(!(spawned.args as string[]).some((arg) => token.test(arg)), "no token in argv");
    const owner = store.claimSession(session.id);
    const history = JSON.stringify([store.readAgentState(session.id, owner), store.getSessionHistory({ sessionId: session.id, limit: 100 }).items]);
    store.releaseSession(session.id, owner);
    assert.ok(!token.test(history), "no token in history");
    assert.ok(!token.test(stderr), "no token on stderr");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bridged todo call produces the same panel event as Raw's loop, is recorded once, and the CLI's own report of it is not shown", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    const { results, events, store, session } = await backendTurn(root, { tools: { use: ["builtin/todo"] } }, [`bridge todo ${JSON.stringify(TODO)}`]);
    assert.equal(results[0]!.status, "completed", JSON.stringify(results[0]));
    assert.match(results[0]!.text!, /"isError":false|^result:\{"content"/);
    const starts = events.filter((event) => event.type === "tool_start");
    assert.deepEqual(starts.map((event) => event.type === "tool_start" && event.name), ["todo"], "only the bridge's own start");
    assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
    const panel = store.listSessionPanels(session.id).find((item) => item.panelId === "builtin/todo#todo");
    assert.equal(panel?.document.title, "Ship");
    const history = store.getSessionHistory({ sessionId: session.id, limit: 100 }).items;
    assert.ok(!JSON.stringify(history).includes("mcp__raw__"), "the CLI's report of the call is not recorded");
    store.close();

    // Raw's own loop, same call.
    const loopRuntime = await loadConfig({ configPath: (() => { const path = join(root, "loop.json");
      writeFileSync(path, JSON.stringify({ default_agent: "l", models: { m: { provider: "openai", method: "openai-chat-completions", model_id: "m", api_key: "k" } },
        agents: { l: { model: "m", tools: { use: ["builtin/todo"] } } } })); return path; })(), env: {} });
    const loopTools = await createRuntimeTools({ runtime: loopRuntime, cwd: root });
    let step = 0;
    const provider: ProviderAdapter = { modelConfig: loopRuntime.modelConfig!, generate: async () => step++ === 0
      ? { text: "", toolCalls: [{ id: "c1", name: "todo", arguments: TODO }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" } };
    const loopEvents: RunEvent[] = [];
    const loop = createAgent({ provider, registry: loopTools.registry, cwd: root });
    await loop.run("go", (event) => loopEvents.push(event));
    await loop.close();
    await loopTools.mcp.close();
    assert.ok(panelShape(loopEvents).length > 0);
    assert.deepEqual(panelShape(events), panelShape(loopEvents));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a panel action on a bridged tool's panel runs in Raw, and the CLI hears of it with the next prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    let action: Awaited<ReturnType<ReturnType<typeof createAcpSessionAgent>["runPanelAction"]>> | undefined;
    const { results, store, session } = await backendTurn(root, { tools: { use: ["builtin/todo"] } }, [`bridge todo ${JSON.stringify(TODO)}`,
      async (agent) => { action = await agent.runPanelAction({ panel: "builtin/todo#todo", action: "complete", block: "items", item: "t1" }); }, "next"]);
    assert.equal(action?.status, "completed", JSON.stringify(action));
    const panel = store.listSessionPanels(session.id).find((item) => item.panelId === "builtin/todo#todo");
    assert.match(JSON.stringify(panel?.document), /"done"/);
    assert.match(results[1]!.text!, /^echo:The user ran "Mark done"/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a call the CLI makes when no turn is running is refused with an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    const { results, store } = await backendTurn(root, { tools: { use: ["builtin/todo"] } }, ["bridge-late", async () => {
      for (let i = 0; i < 200 && !calls(root).some((call) => call.method === "mcp/late"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    }]);
    assert.equal(results[0]!.status, "completed");
    const late = calls(root).find((call) => call.method === "mcp/late");
    assert.deepEqual(late?.result, { isError: true, content: [{ type: "text", text: "no active turn" }] });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an ask rule on a bridged tool uses Raw's approval channel; a refusal reaches the CLI as an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    const asked: string[] = [];
    const { results, store } = await backendTurn(root, { tools: { use: ["builtin/todo"], rules: [{ match: "builtin/todo", effect: "ask" }] } },
      [`bridge todo ${JSON.stringify(TODO)}`], { approve: () => { asked.push("todo"); return false; } });
    assert.deepEqual(asked, ["todo"]);
    assert.match(results[0]!.text!, /"isError":true/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bridged call larger than max_output_bytes reaches the CLI capped and marked", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    const todos = Array.from({ length: 30 }, (_, index) => ({ content: `Item ${index} ${"x".repeat(150)}`, status: "pending" }));
    const { results, store } = await backendTurn(root, { tools: { use: ["builtin/todo"] }, max_output_bytes: 1024 }, [`bridge todo ${JSON.stringify({ todos })}`]);
    assert.equal(results[0]!.status, "completed");
    const sent = (JSON.parse(results[0]!.text!.slice("result:".length)) as { content: Array<{ text: string }> }).content.map((block) => block.text).join("");
    assert.ok(Buffer.byteLength(sent) <= 1024, String(Buffer.byteLength(sent)));
    assert.match(sent, /\[Output truncated: showing \d+ of \d+ bytes/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bridged tool that ignores cancel still gets its cancelled result before the run's end, and nothing after it", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bridge-"));
  try {
    const folder = join(root, "raw", "tools", "slow");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "slow", version: "1.0.0", name: "slow", description: "Slow",
      input_schema: { type: "object", properties: {}, additionalProperties: false }, entry: "./index.mjs" }));
    writeFileSync(join(folder, "index.mjs"), "export async function handler() { await new Promise((resolve) => setTimeout(resolve, 2500)); return { content: [{ type: 'text', text: 'late' }] }; }\n");
    const { results, store, session } = await backendTurn(root, { tools: { use: ["local/slow"] } }, ["bridge slow {}"],
      { onEvent: (event, agent) => { if (event.type === "tool_start") setTimeout(() => agent.abort(), 200); } });
    assert.equal(results[0]!.status, "cancelled");
    const history = store.getSessionHistory({ sessionId: session.id, limit: 100 }).items;
    const end = history.findIndex((item) => item.kind === "run_end");
    assert.ok(end >= 0, JSON.stringify(history.map((item) => item.kind)));
    assert.deepEqual(history.slice(end + 1).map((item) => item.kind), []);
    const result = history.slice(0, end).find((item) => item.kind === "tool_result");
    assert.match(JSON.stringify(result?.payload), /cancelled/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("in the dashboard, a bridged todo fills the session's todo panel and ask_user waits for the dashboard's answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-bridge-dash-"));
  const f = await dashboardFixture({ env: fakeClaude(dir), extraAgents: {
    cc: { backend: { kind: "claude" }, tools: { use: ["builtin/todo", "builtin/ask_user"] }, request_timeout_ms: 60000 } } });
  try {
    const session = await f.json<{ id: string }>("/sessions", "POST", { cwd: f.root, agent: "cc" });
    const todo = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: "todo", kind: "turn", agent: "cc", input: `bridge todo ${JSON.stringify(TODO)}` });
    assert.equal((await f.wait(todo.id)).state, "completed");
    const panels = await f.json<{ items: Array<{ panel: string; document: { title?: string } | null }> }>(`/sessions/${session.id}/panels`);
    assert.equal(panels.items.find((item) => item.panel === "builtin/todo#todo")?.document?.title, "Ship");

    const ask = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: "ask", kind: "turn", agent: "cc", input: `bridge ask_user ${JSON.stringify({ question: "Which colour?" })}` });
    let pending: InteractionRequest | undefined;
    for (let i = 0; i < 1000 && !pending; i++) {
      pending = (await f.json<{ interactions: InteractionRequest[] }>(`/sessions/${session.id}`)).interactions.find((item) => item.state === "pending");
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pending, "the question is shown while the CLI's call waits");
    assert.equal((await f.json<SessionOperation>(`/operations/${ask.id}`)).state, "running");
    await f.json(`/sessions/${session.id}/interactions/${pending.identity.requestId}/responses`, "POST", { requestId: pending.identity.requestId,
      expectedRevision: pending.revision, idempotencyKey: randomUUID(), response: "submit", answers: { answer: "teal" } });
    assert.equal((await f.wait(ask.id)).state, "completed");
    const transcript = JSON.stringify(await f.json(`/sessions/${session.id}`));
    assert.match(transcript, /User answered: teal/);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cancelling a turn during a bridged call ends the call and the turn, and nothing is recorded after the run's end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-bridge-dash-"));
  const f = await dashboardFixture({ env: fakeClaude(dir), extraAgents: {
    cc: { backend: { kind: "claude" }, tools: { use: ["builtin/ask_user"] }, request_timeout_ms: 60000 } } });
  try {
    const session = await f.json<{ id: string }>("/sessions", "POST", { cwd: f.root, agent: "cc" });
    const ask = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: "ask", kind: "turn", agent: "cc", input: `bridge ask_user ${JSON.stringify({ question: "Never answered" })}` });
    let pending: InteractionRequest | undefined;
    for (let i = 0; i < 1000 && !pending; i++) {
      pending = (await f.json<{ interactions: InteractionRequest[] }>(`/sessions/${session.id}`)).interactions.find((item) => item.state === "pending");
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pending);
    await f.json(`/operations/${ask.id}/cancel`, "POST", {});
    const ended = await f.wait(ask.id);
    assert.ok(["cancelled", "interrupted"].includes(ended.state), ended.state);
    const history = (await f.json<{ history: { items: Array<{ kind: string; turnId?: string; toolState?: string; toolCall?: { name?: string } }> } }>(`/sessions/${session.id}`)).history.items;
    const end = history.findIndex((item) => item.kind === "run_end" && item.turnId === ask.id);
    assert.ok(end >= 0, JSON.stringify(history.map((item) => item.kind)));
    assert.deepEqual(history.slice(end + 1).filter((item) => item.turnId === ask.id), []);
    assert.ok(history.slice(0, end).some((item) => item.toolState === "cancelled"), JSON.stringify(history));
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});
