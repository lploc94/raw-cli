import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import { compactionInput, isCompactionRequest } from "./fixtures/compaction.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "raw-session-agent-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "session" }).id;
  return { root, store, id };
}

function provider(generate: (request: ProviderRequest) => Promise<ProviderTurn>, vision = false): ProviderAdapter {
  return { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture", vision }, generate };
}

test("durable agent restores exact model messages, selected tools, and cache key", async () => {
  const { root, store, id } = setup();
  const registry = createTestToolRegistry();
  registry.register({ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { value: { type: "string" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: String(args.value) }] }) });
  const requests: Array<{ messages: unknown; tools: unknown; cacheKey: string | undefined; system: string }> = [];
  const firstProvider = provider(async (request) => {
    requests.push({ messages: structuredClone(request.messages), tools: structuredClone(request.tools), cacheKey: request.cacheKey, system: request.system });
    if (requests.length === 1) return { text: "", toolCalls: [{ id: "call-1", name: "echo", arguments: { value: "large" } }],
      finishReason: "tool_calls", opaque: { reasoning: "opaque-token" }, usage: { prompt_tokens: 20, completion_tokens: 2 } };
    return { text: "done", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent({ cwd: root, provider: firstProvider, registry, system: "system", whitelist: ["echo"],
    persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await agent.run("first")).status, "completed");
    const before = structuredClone(agent.transcript);
    const expected = { messages: [...before, { role: "user", content: "second" }],
      tools: requests[1]!.tools, cacheKey: requests[0]!.cacheKey, system: "system" };
    await agent.close();
    const resumedProvider = provider(async (request) => {
      assert.deepEqual({ messages: request.messages, tools: request.tools, cacheKey: request.cacheKey, system: request.system }, expected);
      return { text: "continued", toolCalls: [], finishReason: "stop" };
    });
    const resumed = createAgent({ cwd: root, provider: resumedProvider, registry, system: "system",
      persistence: { store, sessionId: id, surface: "cli" } });
    try {
      assert.deepEqual(resumed.transcript, before);
      assert.deepEqual(resumed.toolDefinitions, requests[1]!.tools);
      assert.equal((await resumed.run("second")).text, "continued");
      const history = store.getSessionHistory({ sessionId: id, limit: 100 }).items;
      assert.ok(history.some((item) => JSON.stringify(item.payload).includes("first")));
      assert.ok(history.some((item) => JSON.stringify(item.payload).includes("large")));
    } finally { await resumed.close(); }
  } finally { await agent.close(); store.close(); }
});

test("changed selected tool definition rotates generated cache key and preserves committed transcript", async () => {
  const { root, store, id } = setup();
  const makeRegistry = (description: string) => {
    const registry = createTestToolRegistry();
    registry.register({ name: "selected", description, inputSchema: { type: "object", properties: {} },
      async handler() { return { isError: false, content: [{ type: "text", text: "ran" }] }; } });
    return registry;
  };
  const keys: string[] = [];
  const first = createAgent({ cwd: root, provider: provider(async (request) => {
    keys.push(request.cacheKey!);
    return { text: "first", toolCalls: [], finishReason: "stop" };
  }), registry: makeRegistry("old"), whitelist: ["selected"], system: "system",
  persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await first.run("one")).status, "completed");
    const previous = first.transcript;
    await first.close();
    const second = createAgent({ cwd: root, provider: provider(async (request) => {
      keys.push(request.cacheKey!);
      assert.deepEqual(request.messages.slice(0, previous.length), previous);
      assert.equal(request.tools.find((tool) => tool.name === "selected")?.description, "new");
      return { text: "second", toolCalls: [], finishReason: "stop" };
    }), registry: makeRegistry("new"), whitelist: ["selected"], system: "system",
    persistence: { store, sessionId: id, surface: "cli" } });
    try {
      assert.equal(second.contextRevision, first.contextRevision + 1);
      assert.equal((await second.run("two")).status, "completed");
      assert.notEqual(keys[0], keys[1]);
    } finally { await second.close(); }
  } finally { await first.close(); store.close(); }
});

test("code-only selected tool source change rotates key but an unchanged source does not", async () => {
  const { root, store, id } = setup();
  const registry = createTestToolRegistry();
  const keys: string[] = [];
  const make = (source: string) => createAgent({ cwd: root, provider: provider(async (request) => {
    keys.push(request.cacheKey!);
    return { text: "done", toolCalls: [], finishReason: "stop" };
  }), registry, whitelist: ["read_file"], toolSourceDigest: source, system: "system",
  persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const first = make("source-one");
    assert.equal((await first.run("one")).status, "completed");
    await first.close();
    const same = make("source-one");
    assert.equal(same.contextRevision, first.contextRevision);
    assert.equal((await same.run("two")).status, "completed");
    await same.close();
    const changed = make("source-two");
    assert.equal(changed.contextRevision, same.contextRevision + 1);
    assert.equal((await changed.run("three")).status, "completed");
    await changed.close();
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[1], keys[2]);
  } finally { store.close(); }
});

test("skill-only change keeps cache key and appends one durable reload notice after a linked load", async () => {
  const { root, store, id } = setup();
  const selected = (markdown: string) => [{ id: "agent/example", version: "1.0.0", name: "example",
    description: "Example", markdown }];
  const registry = createTestToolRegistry();
  registry.register({ name: "load_skill", description: "Load selected skill", inputSchema: { type: "object",
    properties: { name: { type: "string" } } },
  async handler() { return { isError: false, content: [{ type: "text", text: "OLD_SKILL_BODY" }] }; } });
  const keys: string[] = [];
  let turns = 0;
  const first = createAgent({ cwd: root, provider: provider(async (request) => {
    keys.push(request.cacheKey!);
    return ++turns === 1 ? { text: "", toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "example" } }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" };
  }), registry, whitelist: ["load_skill"], selectedSkills: selected("OLD_SKILL_BODY"), system: "system",
  persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await first.run("one")).status, "completed");
    const prior = first.transcript;
    await first.close();
    const second = createAgent({ cwd: root, provider: provider(async (request) => {
      keys.push(request.cacheKey!);
      const prefix = request.messages.slice(0, prior.length);
      assert.deepEqual(prefix, prior);
      assert.match(JSON.stringify(request.messages.at(-2)), /reload|stale/i);
      return { text: "done", toolCalls: [], finishReason: "stop" };
    }), registry, whitelist: ["load_skill"], selectedSkills: selected("NEW_SKILL_BODY"), system: "system",
    persistence: { store, sessionId: id, surface: "cli" } });
    try {
      assert.equal(second.contextRevision, first.contextRevision + 1);
      assert.equal((await second.run("two")).status, "completed");
      assert.equal(keys[0], keys.at(-1));
      assert.equal(second.transcript.filter((item) => item.role === "user" && JSON.stringify(item.content).includes("reload")).length, 1);
    } finally { await second.close(); }
  } finally { await first.close(); store.close(); }
});

test("skill version label alone leaves the session generation and request prefix unchanged", async () => {
  const { root, store, id } = setup();
  const selected = (version: string) => [{ id: "agent/example", version, name: "example",
    description: "Unchanged", markdown: "same instructions" }];
  const requests: ProviderRequest[] = [];
  const runtime = provider(async (request) => {
    requests.push({ ...request, messages: structuredClone(request.messages) });
    return { text: "done", toolCalls: [], finishReason: "stop" };
  });
  try {
    const first = createAgent({ cwd: root, provider: runtime, system: "system", selectedSkills: selected("1.0.0"),
      persistence: { store, sessionId: id, surface: "cli" } });
    assert.equal((await first.run("one")).status, "completed");
    await first.close();
    const second = createAgent({ cwd: root, provider: runtime, system: "system", selectedSkills: selected("2.0.0"),
      persistence: { store, sessionId: id, surface: "cli" } });
    try {
      assert.equal(second.contextRevision, first.contextRevision);
      assert.equal((await second.run("two")).status, "completed");
      assert.equal(requests[0]!.cacheKey, requests[1]!.cacheKey);
      assert.equal(second.transcript.some((item) => item.role === "user" && String(item.content).includes("reload")), false);
    } finally { await second.close(); }
  } finally { store.close(); }
});

test("compaction that removes a loaded skill appends one durable tail reminder", async () => {
  const { root, store, id } = setup();
  const body = "SKILL_BODY_TO_RELOAD_".repeat(80);
  const registry = createTestToolRegistry();
  registry.register({ name: "load_skill", description: "Load skill", inputSchema: { type: "object",
    properties: { name: { type: "string" } } },
  async handler() { return { isError: false, content: [{ type: "text", text: body }] }; } });
  let ordinary = 0;
  const agent = createAgent({ cwd: root, provider: provider(async (request) => {
    if (isCompactionRequest(request)) return { text: "Earlier work summarized.", toolCalls: [], finishReason: "stop" };
    return ++ordinary === 1 ? { text: "", toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "example" } }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" };
  }), registry, whitelist: ["load_skill"], selectedSkills: [{ id: "agent/example", version: "1.0.0", name: "example",
    description: "Example", markdown: body }], system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await agent.run("first")).status, "completed");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.doesNotMatch(JSON.stringify(agent.transcript), /SKILL_BODY_TO_RELOAD_/);
    assert.match(JSON.stringify(agent.transcript.at(-1)), /example.*load_skill/);
    const notices = agent.transcript.filter((item) => item.role === "user" && JSON.stringify(item.content).includes("reload notice"));
    assert.equal(notices.length, 1);
    await agent.close();
    const owner = store.claimSession(id);
    try { assert.equal(store.readAgentState(id, owner).messages.filter((item) => item.role === "user"
      && JSON.stringify(item.content).includes("reload notice")).length, 1); }
    finally { store.releaseSession(id, owner); }
  } finally { await agent.close(); store.close(); }
});

test("crash recovery links unresolved calls before a skill notice and a failed transition retries once", async () => {
  const { root, store, id } = setup();
  let sideEffects = 0;
  const registry = createTestToolRegistry();
  registry.register({ name: "load_skill", description: "Load", inputSchema: { type: "object", properties: { name: { type: "string" } } },
    async handler() { return { isError: false, content: [{ type: "text", text: "OLD_BODY" }] }; } });
  registry.register({ name: "side_effect", description: "Side effect", inputSchema: { type: "object", properties: {} },
    async handler() { sideEffects++; return { isError: false, content: [] }; } });
  const skills = (markdown: string) => [{ id: "agent/example", version: "1.0.0", name: "example", description: "Example", markdown }];
  let calls = 0;
  const first = createAgent({ cwd: root, provider: provider(async () => ++calls === 1
    ? { text: "", toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "example" } }], finishReason: "tool_calls" }
    : { text: "done", toolCalls: [], finishReason: "stop" }), registry,
  whitelist: ["load_skill", "side_effect"], selectedSkills: skills("OLD_BODY"), system: "system",
  persistence: { store, sessionId: id, surface: "cli" } });
  try { assert.equal((await first.run("one")).status, "completed"); }
  finally { await first.close(); }
  const owner = store.claimSession(id);
  store.appendAgentMessage(id, owner, { role: "user", content: "run side effect" });
  store.appendAgentMessage(id, owner, { role: "assistant", text: "", toolCalls: [{ id: "pending", name: "side_effect", arguments: {} }] });
  store.releaseSession(id, owner);
  store.database.exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON model_context
    WHEN NEW.payload_json LIKE '%Raw skill reload notice%'
    BEGIN SELECT RAISE(ABORT, 'simulated notice failure'); END`);
  const make = () => createAgent({ cwd: root, provider: provider(async () => ({ text: "done", toolCalls: [], finishReason: "stop" })),
    registry, whitelist: ["load_skill", "side_effect"], selectedSkills: skills("NEW_BODY"), system: "system",
    persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.throws(make, /simulated notice failure/);
    assert.equal(store.database.prepare("SELECT context_revision AS revision FROM sessions WHERE id = ?").get(id)?.revision, 1);
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM model_context WHERE payload_json LIKE '%outcome_unknown%'").get()?.n, 0);
  } finally { store.database.exec("DROP TRIGGER fail_notice"); }
  const resumed = make();
  try {
    const tail = resumed.transcript.slice(-2);
    assert.deepEqual(tail.map((item) => item.role), ["tool", "user"]);
    assert.equal(tail[0]?.role === "tool" ? tail[0].result.code : undefined, "outcome_unknown");
    assert.match(JSON.stringify(tail[1]), /reload notice.*example/);
    assert.equal(sideEffects, 0);
    assert.equal(resumed.contextRevision, 2);
  } finally { await resumed.close(); }
  const again = make();
  try { assert.equal(again.transcript.filter((item) => item.role === "user" && JSON.stringify(item.content).includes("reload notice")).length, 1); }
  finally { await again.close(); store.close(); }
});

test("pending declared tool recovers as uncertain without dispatch on resume", async () => {
  const { root, store, id } = setup();
  const registry = createTestToolRegistry();
  let executed = 0;
  registry.register({ name: "side_effect", description: "Side effect", inputSchema: { type: "object" },
    handler: async () => { executed++; return { isError: false, content: [{ type: "text", text: "done" }] }; } });
  const owner = store.claimSession(id);
  store.initializeAgent(id, owner, { cwd: root, system: "system", modelConfig: provider(async () => { throw new Error("unused"); }).modelConfig,
    toolDefinitions: registry.definitions(), selectedTools: null, cacheKey: "stable" });
  store.appendAgentMessage(id, owner, { role: "user", content: "execute" }, { originalTask: "execute" });
  store.appendAgentMessage(id, owner, { role: "assistant", text: "", toolCalls: [
    { id: "one", name: "side_effect", arguments: {} }, { id: "two", name: "side_effect", arguments: {} } ] });
  store.releaseSession(id, owner);
  const agent = createAgent({ cwd: root, provider: provider(async () => ({ text: "safe", toolCalls: [], finishReason: "stop" })),
    registry, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const tools = agent.transcript.filter((message) => message.role === "tool");
    assert.deepEqual(tools.map((item) => item.result.code), ["outcome_unknown", "cancelled"]);
    assert.equal(executed, 0);
    assert.equal((await agent.run("inspect first")).status, "completed");
    assert.equal(executed, 0);
  } finally { await agent.close(); store.close(); }
});

test("compact checkpoint retains visible large text while releasing model-only payloads", () => {
  const { root, store, id } = setup();
  const owner = store.claimSession(id);
  const agent = provider(async () => { throw new Error("unused"); }).modelConfig;
  store.initializeAgent(id, owner, { cwd: root, system: "system", modelConfig: agent, toolDefinitions: [], selectedTools: [], cacheKey: "stable" });
  const visible = "visible:" + "x".repeat(70_000);
  const hidden = "hidden:" + "y".repeat(70_000);
  store.appendAgentMessage(id, owner, { role: "user", content: "first" }, { originalTask: "first" });
  store.appendAgentMessage(id, owner, { role: "assistant", text: visible, toolCalls: [], opaque: { hidden } }, {},
    [{ kind: "assistant", payload: { text: visible } }]);
  const before = store.database.prepare("SELECT count(*) AS n FROM payloads").get()?.n;
  assert.equal(before, 2, "visible text should share one payload reference between context and history");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM payloads WHERE ref_count = 2").get()?.n, 1);
  store.replaceAgentContext(id, owner, [{ role: "user", content: "summary" }], { summaryText: "summary" });
  const history = store.getSessionHistory({ sessionId: id }).items;
  assert.equal(history[0]?.payload.text, visible);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM payloads").get()?.n, 1);
  store.releaseSession(id, owner);
  store.deleteSession(id);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM payloads").get()?.n, 0);
  store.close();
});

test("provider error flushes one incomplete text and reasoning record without a model assistant", async () => {
  const { root, store, id } = setup();
  const broken = provider(async (request) => {
    request.onTextDelta?.("par"); request.onTextDelta?.("tial");
    request.onReasoningDelta?.("thinking");
    throw new Error("stream broke");
  });
  const agent = createAgent({ cwd: root, provider: broken, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await agent.run("first")).status, "error");
    assert.deepEqual(agent.transcript.map((item) => item.role), ["user"]);
    const history = store.getSessionHistory({ sessionId: id }).items;
    assert.deepEqual(history.filter((item) => item.kind === "assistant").map((item) => [item.payload.text, item.status]), [["partial", "error"]]);
    assert.deepEqual(history.filter((item) => item.kind === "reasoning").map((item) => [item.payload.text, item.status]), [["thinking", "error"]]);
  } finally { await agent.close(); store.close(); }
});

test("CLI history preserves the order of streamed reasoning and answer fragments", async () => {
  const { root, store, id } = setup();
  const runtime = provider(async (request) => {
    request.onReasoningDelta?.("think-");
    request.onReasoningDelta?.("first");
    request.onTextDelta?.("answer-one");
    request.onReasoningDelta?.("think-again");
    request.onTextDelta?.("answer-two");
    return { text: "answer-oneanswer-two", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await agent.run("question")).status, "completed");
    const history = store.getSessionHistory({ sessionId: id, limit: 100 }).items;
    assert.deepEqual(history.map((item) => [item.kind, item.payload.text ?? item.payload.input]), [
      ["user", "question"],
      ["reasoning", "think-first"],
      ["assistant", "answer-one"],
      ["reasoning", "think-again"],
      ["assistant", "answer-two"],
    ]);
  } finally { await agent.close(); store.close(); }
});

test("CLI history puts a nonstreamed final answer after streamed reasoning", async () => {
  const { root, store, id } = setup();
  const runtime = provider(async (request) => {
    request.onReasoningDelta?.("thinking");
    return { text: "answer", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await agent.run("question")).status, "completed");
    const history = store.getSessionHistory({ sessionId: id, limit: 100 }).items;
    assert.deepEqual(history.map((item) => [item.kind, item.payload.text ?? item.payload.input]), [
      ["user", "question"], ["reasoning", "thinking"], ["assistant", "answer"],
    ]);
  } finally { await agent.close(); store.close(); }
});

test("graceful cancel keeps streamed text incomplete after restart", async () => {
  const { root, store, id } = setup();
  let started!: () => void;
  const seen = new Promise<void>((resolve) => { started = resolve; });
  const pending = provider(async (request) => {
    request.onTextDelta?.("half");
    started();
    await new Promise<void>(() => {});
    return { text: "never", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent({ cwd: root, provider: pending, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const running = agent.run("first");
    await seen;
    agent.abort();
    assert.equal((await running).status, "cancelled");
    await agent.close();
    const resumed = createAgent({ cwd: root, provider: provider(async () => ({ text: "okay", toolCalls: [], finishReason: "stop" })),
      system: "system", persistence: { store, sessionId: id, surface: "cli" } });
    try {
      assert.deepEqual(resumed.transcript.map((item) => item.role), ["user"]);
      const fragments = store.getSessionHistory({ sessionId: id }).items.filter((item) => item.kind === "assistant");
      assert.deepEqual(fragments.map((item) => [item.payload.text, item.status]), [["half", "interrupted"]]);
    } finally { await resumed.close(); }
  } finally { await agent.close(); store.close(); }
});

test("saved resource link, image result, and opaque block survive a new process model request", async () => {
  const { root, store, id } = setup();
  const image = "a".repeat(90_000);
  let turn = 0;
  const registry = createTestToolRegistry([], true);
  registry.register({ name: "native", description: "Native", inputSchema: { type: "object" }, handler: async () => ({
    isError: false, content: [{ type: "image", data: image, mimeType: "image/png" }],
  }) });
  const first = provider(async () => ++turn === 1
    ? { text: "", toolCalls: [{ id: "opaque-call", name: "native", arguments: {} }], finishReason: "tool_calls",
      opaque: { encrypted_content: "opaque-blob", custom: { exact: true } } }
    : { text: "seen", toolCalls: [], finishReason: "stop" }, true);
  const agent = createAgent({ cwd: root, provider: first, registry, system: "system", persistence: { store, sessionId: id, surface: "acp" } });
  try {
    const input = [{ type: "resource_link" as const, uri: "file:///a", name: "a" }];
    assert.equal((await agent.run(input)).status, "completed");
    const saved = structuredClone(agent.transcript);
    await agent.close();
    const next = provider(async (request) => {
      assert.deepEqual(request.messages.slice(0, -1), saved);
      return { text: "continued", toolCalls: [], finishReason: "stop" };
    }, true);
    const resumed = createAgent({ cwd: root, provider: next, registry, system: "system", persistence: { store, sessionId: id, surface: "acp" } });
    try { assert.equal((await resumed.run("next")).status, "completed"); }
    finally { await resumed.close(); }
  } finally { await agent.close(); store.close(); }
});

test("successful compact retains full CLI Bash arguments and ACP raw result in display history", async () => {
  const { root, store, id } = setup();
  const bashArgument = "printf " + "a".repeat(70_000);
  let ordinary = 0;
  const runtime = provider(async (request) => {
    if (isCompactionRequest(request)) return { text: "short summary", toolCalls: [], finishReason: "stop" };
    ordinary++;
    if (ordinary === 1) {
      request.onReasoningDelta?.("visible reasoning");
      return { text: "", toolCalls: [{ id: "bad-bash", name: "bash",
        arguments: { commands: [{ command: bashArgument }] }, argumentError: "invalid fixture command" }], finishReason: "tool_calls" };
    }
    return { text: "finished", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await agent.run("first")).status, "completed");
    const oldContext = structuredClone(agent.transcript);
    assert.equal((await agent.compact({ keepRecentTurns: 0 })).status, "compacted");
    assert.ok(JSON.stringify(agent.transcript).length < JSON.stringify(oldContext).length);
    await agent.close();
    const history = store.getSessionHistory({ sessionId: id, limit: 100 }).items;
    const displayedArgs = (history.find((item) => item.kind === "tool_call")?.payload.display as {
      arguments: Record<string, unknown>;
    }).arguments;
    assert.deepEqual(displayedArgs, { commands: [{ command: bashArgument }] });
    assert.ok(history.some((item) => item.kind === "tool_result"));
    assert.ok(history.some((item) => item.kind === "reasoning" && item.payload.text === "visible reasoning"));
    const resumed = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
    try { assert.deepEqual(resumed.transcript, agent.transcript); }
    finally { await resumed.close(); }
  } finally { await agent.close(); store.close(); }

  const acp = setup();
  const output = "raw:" + "b".repeat(70_000);
  const registry = createTestToolRegistry();
  registry.register({ name: "large", description: "Large", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: output }] }) });
  let step = 0;
  const acpProvider = provider(async (request) => {
    if (isCompactionRequest(request)) return { text: "summary", toolCalls: [], finishReason: "stop" };
    return ++step === 1 ? { text: "", toolCalls: [{ id: "large-result", name: "large", arguments: {} }], finishReason: "tool_calls" }
      : { text: "done", toolCalls: [], finishReason: "stop" };
  });
  const acpAgent = createAgent({ cwd: acp.root, provider: acpProvider, registry, system: "system", maxOutputBytes: 100_000,
    persistence: { store: acp.store, sessionId: acp.id, surface: "acp" } });
  try {
    assert.equal((await acpAgent.run("first")).status, "completed");
    assert.equal((await acpAgent.compact({ keepRecentTurns: 0 })).status, "compacted");
    const history = acp.store.getSessionHistory({ sessionId: acp.id, limit: 100 }).items;
    assert.ok(JSON.stringify(history).includes(output));
    assert.equal((history.find((item) => item.kind === "tool_call")?.payload.update as { sessionUpdate: string }).sessionUpdate, "tool_call");
    assert.equal((history.find((item) => item.kind === "tool_result")?.payload.update as { sessionUpdate: string }).sessionUpdate, "tool_call_update");
    assert.ok(history.some((item) => item.kind === "acp_update"
      && (item.payload.update as { status?: string }).status === "in_progress"));
  } finally { await acpAgent.close(); acp.store.close(); }
});

test("failed compaction leaves durable context intact and changed tool schema transitions on resume", async () => {
  const { root, store, id } = setup();
  const registry = createTestToolRegistry();
  registry.register({ name: "selected", description: "Original", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [] }) });
  const runtime = provider(async (request) => isCompactionRequest(request)
    ? { text: "", toolCalls: [], finishReason: "stop" }
    : { text: "answer", toolCalls: [], finishReason: "stop" });
  const agent = createAgent({ cwd: root, provider: runtime, registry, system: "system",
    persistence: { store, sessionId: id, surface: "cli" } });
  try {
    agent.setToolView(["selected"]);
    assert.equal((await agent.run("first")).status, "completed");
    assert.equal((await agent.run("second")).status, "completed");
    const before = structuredClone(agent.transcript);
    await assert.rejects(agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }), /empty summary/i);
    assert.deepEqual(agent.transcript, before);
    await agent.close();
    const changed = createTestToolRegistry();
    changed.register({ name: "selected", description: "Changed", inputSchema: { type: "object" },
      handler: async () => ({ isError: false, content: [] }) });
    const resumed = createAgent({ cwd: root, provider: runtime, registry: changed, system: "system",
      persistence: { store, sessionId: id, surface: "cli" } });
    try { assert.deepEqual(resumed.transcript, before); assert.equal(resumed.toolDefinitions.find((tool) => tool.name === "selected")?.description, "Changed"); }
    finally { await resumed.close(); }
  } finally { await agent.close(); store.close(); }
});

test("released generation cannot write after another owner claims the session", () => {
  const { store, id } = setup();
  const first = store.claimSession(id);
  store.releaseSession(id, first);
  const second = store.claimSession(id);
  try {
    assert.throws(() => store.appendAgentMessage(id, first, { role: "user", content: "stale" }), /ownership/i);
    store.appendAgentMessage(id, second, { role: "user", content: "current" });
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM model_context").get()?.n, 1);
  } finally { store.releaseSession(id, second); store.close(); }
});

test("persistent clear resets the original task while keeping prior display history", async () => {
  const { root, store, id } = setup();
  const runtime = provider(async () => ({ text: "done", toolCalls: [], finishReason: "stop" }));
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    await agent.run("old task");
    agent.clear();
    await agent.close();
    const resumed = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
    try {
      const empty = resumed.transcript;
      assert.equal(empty.length, 0);
      await resumed.run("new task");
      assert.equal(resumed.transcript[0]?.role, "user");
      assert.equal((resumed.transcript[0] as { content: string }).content, "new task");
      assert.ok(store.getSessionHistory({ sessionId: id, limit: 100 }).items.some((item) => JSON.stringify(item.payload).includes("old task")));
    } finally { await resumed.close(); }
  } finally { await agent.close(); store.close(); }
});

test("precreated cache identity survives attach and endpoint credentials are never stored", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-identity-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const endpoint = "https://user:secret@example.test/v1?token=hidden";
  const id = store.createSession({ cwd: root, title: "identity", agentName: "test", modelId: "fixture",
    provider: "ollama", method: "openai-chat-completions", endpoint, systemPrompt: "system", cacheKey: "precreated" }).id;
  const current = store.database.prepare("SELECT endpoint FROM sessions WHERE id = ?").get(id);
  assert.doesNotMatch(String(current?.endpoint), /secret|token|user/);
  const runtime: ProviderAdapter = { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", baseUrl: endpoint }, generate: async (request) => {
    assert.equal(request.cacheKey, "precreated");
    return { text: "ok", toolCalls: [], finishReason: "stop" };
  } };
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  try { assert.equal((await agent.run("hi")).status, "completed"); }
  finally { await agent.close(); store.close(); }
});

test("large JSON __proto__ field round-trips without prototype mutation", () => {
  const { store, id } = setup();
  const owner = store.claimSession(id);
  const value = "v".repeat(70_000);
  const payload = JSON.parse(JSON.stringify({ __proto__: null })) as Record<string, unknown>;
  Object.defineProperty(payload, "__proto__", { value, enumerable: true, writable: true, configurable: true });
  try {
    store.appendOwnedHistory(id, owner, "tool_result", payload);
    const restored = store.getSessionHistory({ sessionId: id }).items[0]?.payload;
    assert.equal(Object.hasOwn(restored!, "__proto__"), true);
    assert.equal(restored?.__proto__, value);
    assert.equal(Object.hasOwn(Object.prototype, "reviewPollution"), false);
  } finally { store.releaseSession(id, owner); store.close(); }
});

test("a failed durable assistant commit reports persistence error, not cancellation", async () => {
  const { root, store, id } = setup();
  const agent = createAgent({ cwd: root, provider: provider(async () => ({ text: "answer", toolCalls: [], finishReason: "stop" })),
    system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  const original = store.appendAgentMessage.bind(store);
  store.appendAgentMessage = (...args) => {
    if (args[2].role === "assistant") throw new Error("SQLITE_FULL fixture");
    return original(...args);
  };
  try {
    const terminal: unknown[] = [];
    const result = await agent.run("first", (event) => { if (event.type === "run_end") terminal.push(event.result); });
    assert.equal(result.status, "error");
    assert.equal(result.code, "persistence_error");
    assert.match(result.message!, /SQLITE_FULL/);
    assert.deepEqual(terminal, [result]);
    await assert.rejects(agent.run("again"), /persistence failed/i);
  } finally { await agent.close(); store.close(); }
});

test("a failed durable compact checkpoint leaves the previous context on disk", async () => {
  const { root, store, id } = setup();
  const runtime = provider(async (request) => isCompactionRequest(request)
    ? { text: "summary", toolCalls: [], finishReason: "stop" }
    : { text: "a".repeat(80_000), toolCalls: [], finishReason: "stop" });
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  const original = store.replaceAgentContext.bind(store);
  try {
    await agent.run("first");
    await agent.run("second");
    const before = structuredClone(agent.transcript);
    store.replaceAgentContext = () => { throw new Error("SQLITE_FULL checkpoint"); };
    await assert.rejects(agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }), /SQLITE_FULL checkpoint/);
    assert.deepEqual(agent.transcript, before);
    store.replaceAgentContext = original;
    await agent.close();
    const resumed = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
    try { assert.deepEqual(resumed.transcript, before); }
    finally { await resumed.close(); }
  } finally { store.replaceAgentContext = original; await agent.close(); store.close(); }
});

test("terminal partial-history flush failure still emits one persistence error", async () => {
  const { root, store, id } = setup();
  const runtime = provider(async (request) => {
    request.onTextDelta?.("partial");
    throw new Error("provider failed");
  });
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  const original = store.appendOwnedHistory.bind(store);
  store.appendOwnedHistory = () => { throw new Error("SQLITE_FULL terminal flush"); };
  try {
    const terminal: unknown[] = [];
    const result = await agent.run("first", (event) => { if (event.type === "run_end") terminal.push(event.result); });
    assert.equal(result.code, "persistence_error");
    assert.equal(result.status, "error");
    assert.match(result.message!, /SQLITE_FULL/);
    assert.deepEqual(terminal, [result]);
  } finally { store.appendOwnedHistory = original; await agent.close(); store.close(); }
});

test("heartbeat storage failure aborts active work as persistence error", async () => {
  const { root, store, id } = setup();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const runtime = provider(async () => { started(); await new Promise<void>(() => {}); return { text: "never", toolCalls: [], finishReason: "stop" }; });
  const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  const original = store.renewSession.bind(store);
  try {
    const running = agent.run("first");
    await ready;
    store.renewSession = () => { throw new Error("SQLITE_FULL heartbeat"); };
    const result = await running;
    assert.equal(result.status, "error");
    assert.equal(result.code, "persistence_error");
    assert.match(result.message!, /SQLITE_FULL heartbeat/);
  } finally { store.renewSession = original; await agent.close(); store.close(); }
});

test("nonshrinking and aborted compact leave durable context unchanged", async () => {
  for (const mode of ["not_smaller", "cancelled"] as const) {
    const { root, store, id } = setup();
    let summaryStarted!: () => void;
    const ready = new Promise<void>((resolve) => { summaryStarted = resolve; });
    const runtime = provider(async (request) => {
      if (isCompactionRequest(request)) {
        if (mode === "not_smaller") return { text: "expanded".repeat(2000), toolCalls: [], finishReason: "stop" };
        summaryStarted();
        await new Promise<void>(() => {});
        return { text: "late", toolCalls: [], finishReason: "stop" };
      }
      return { text: "answer", toolCalls: [], finishReason: "stop" };
    });
    const agent = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
    try {
      await agent.run("first");
      await agent.run("second");
      const before = structuredClone(agent.transcript);
      if (mode === "not_smaller") assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "not_smaller");
      else {
        const compacting = agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 });
        await ready;
        agent.abort();
        assert.equal((await compacting).status, "cancelled");
      }
      assert.deepEqual(agent.transcript, before);
      await agent.close();
      const resumed = createAgent({ cwd: root, provider: runtime, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
      try { assert.deepEqual(resumed.transcript, before); }
      finally { await resumed.close(); }
    } finally { await agent.close(); store.close(); }
  }
});
