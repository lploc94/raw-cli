import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { ToolRegistry, createToolRegistry } from "../src/tools/registry.js";
import { COMPACT_SYSTEM_PROMPT, estimateRequestTokens, performCompaction } from "../src/compact.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";

const result = (text: string, usage?: unknown): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop",
  ...(usage === undefined ? {} : { usage }) });

test("trigger_tokens needs a context budget and validates its reserve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raw-auto-config-"));
  const path = join(directory, "config.json");
  const config = (context?: number, trigger = 500) => ({ default_profile: "p",
    models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture",
      ...(context === undefined ? {} : { context_window_tokens: context }) } },
    profiles: { p: { model: "m", compact: { trigger_tokens: trigger, max_output_tokens: 100 } } } });
  await writeFile(path, JSON.stringify(config()));
  await assert.rejects(loadConfig({ configPath: path, env: {}, requireModel: true }), /trigger_tokens|context_window_tokens/);
  await writeFile(path, JSON.stringify(config(600)));
  await assert.rejects(loadConfig({ configPath: path, env: {}, requireModel: true }), /trigger_tokens/);
  await writeFile(path, JSON.stringify(config(4000)));
  const loaded = await loadConfig({ configPath: path, env: {}, requireModel: true });
  assert.equal(loaded.compact.triggerTokens, 500);
});

test("automatic compact runs before the next over-threshold inference and keeps usage/cache key visible", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-auto-run-"));
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 4000, maxOutputTokens: 100 }, async generate(request) {
    const { signal: _signal, onUsage: _onUsage, onTextDelta: _onTextDelta,
      onReasoningDelta: _onReasoningDelta, ...wire } = request;
    requests.push(structuredClone(wire));
    if (request.system === COMPACT_SYSTEM_PROMPT) return result("Summary of the prior task.", { prompt_tokens: 30, completion_tokens: 8 });
    return result(requests.length === 1 ? "x".repeat(1600) : "continued", { prompt_tokens: 100, completion_tokens: 10 });
  } };
  const events: string[] = [];
  const agent = createAgent({ provider, cwd, system: "tiny", registry: new ToolRegistry(),
    compact: { triggerTokens: 400, keepRecentTurns: 1, maxOutputTokens: 100 } });
  assert.equal((await agent.run("first")).status, "completed");
  assert.equal((await agent.run("continue", (event) => events.push(event.type))).status, "completed");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.system), ["tiny", COMPACT_SYSTEM_PROMPT, "tiny"]);
  assert.ok(events.includes("compact_start") && events.includes("compact_end"));
  assert.equal(agent.stats().requests, 3);
  assert.equal(requests[0]?.cacheKey, requests[2]?.cacheKey);
  assert.notEqual(requests[1]?.cacheKey, requests[2]?.cacheKey);
  assert.match(JSON.stringify(agent.transcript), /Conversation summary/);
});

test("manual compaction chunks older turns and never sends image base64 to the summarizer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-auto-image-"));
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const registry = createToolRegistry([], true);
  registry.register({ name: "fixture_image", description: "image", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "image", mimeType: "image/png", data: image,
      path: "photo.png", byteSize: 8 }] }) });
  let calls = 0;
  const main: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", vision: true, contextWindow: 1500, maxOutputTokens: 100 }, async generate() {
    calls++;
    if (calls === 1) return { text: "", toolCalls: [{ id: "img", name: "fixture_image", arguments: {} }], finishReason: "tool_calls" };
    return result("answer ".repeat(40));
  } };
  const agent = createAgent({ provider: main, registry, cwd });
  await agent.run("first photo");
  for (let index = 0; index < 5; index++) await agent.run(`turn ${index}`);
  const summaries: ProviderRequest[] = [];
  const summarizer: ProviderAdapter = { profile: main.profile, async generate(request) {
    summaries.push(request);
    assert.ok(!JSON.stringify(request.messages).includes(image));
    assert.ok(!JSON.stringify(request.messages).includes("data:image"));
    return result("summary");
  } };
  const priorRequests = agent.stats().requests;
  const compacted = await agent.compact({ provider: summarizer, keepRecentTurns: 0, maxOutputTokens: 100 });
  assert.equal(compacted.status, "compacted");
  assert.ok(summaries.length >= 2);
  assert.equal(agent.stats().requests, priorRequests + summaries.length);
  assert.ok(summaries.every((request) => !JSON.stringify(request.messages).includes(image)));
  assert.ok(summaries.every((request) => Buffer.byteLength(JSON.stringify({ system: request.system,
    messages: request.messages, tools: request.tools })) + 100 + 75 <= 1500));
  assert.ok(!JSON.stringify(agent.transcript).includes(image));
});

test("tool output and opaque reasoning trigger compact despite small previous usage", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "large", description: "large result", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "T".repeat(2200) }] }) });
  let summaries = 0;
  let main = 0;
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 5000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { summaries++; return result("task and tool result summarized"); }
    main++;
    if (main === 1) return { text: "", toolCalls: [{ id: "c", name: "large", arguments: {} }],
      opaque: { reasoning: "R".repeat(1200) }, finishReason: "tool_calls", usage: { prompt_tokens: 20, completion_tokens: 5 } };
    return result("done");
  } };
  const agent = createAgent({ provider, registry, system: "tiny", compact: { triggerTokens: 700,
    keepRecentTurns: 0, maxOutputTokens: 100 } });
  const types: string[] = [];
  assert.equal((await agent.run("go", (event) => types.push(event.type))).status, "completed");
  assert.equal(main, 2);
  assert.equal(summaries, 1);
  assert.ok(types.includes("compact_start"));
  assert.ok(!JSON.stringify(agent.transcript).includes("T".repeat(100)));
});

test("an early no-op does not consume the one actual compact attempt after a tool result", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "large", description: "large", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "T".repeat(1600) }] }) });
  let main = 0;
  let summaries = 0;
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 5000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { summaries++; return result("summarized"); }
    main++;
    return main === 1 ? { text: "", toolCalls: [{ id: "c", name: "large", arguments: {} }], finishReason: "tool_calls" } : result("done");
  } };
  const statuses: string[] = [];
  const agent = createAgent({ provider, registry, system: "tiny", compact: { triggerTokens: 40,
    keepRecentTurns: 1, maxOutputTokens: 100 } });
  assert.equal((await agent.run("go", (event) => {
    if (event.type === "compact_end") statuses.push(event.result.status);
  })).status, "completed");
  assert.deepEqual(statuses, ["noop", "compacted"]);
  assert.equal(summaries, 1);
});

test("an oversized recent image is summarized as metadata before the next main request", async () => {
  const data = Buffer.alloc(12_000, 7).toString("base64");
  const registry = new ToolRegistry();
  registry.register({ name: "photo", description: "photo", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "image", mimeType: "image/png", data,
      path: "photo.png", byteSize: 12_000 }] }) });
  let main = 0;
  let summarized = false;
  const provider: ProviderAdapter = { profile: { name: "vision", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", vision: true, contextWindow: 4000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) {
      summarized = true;
      assert.ok(!JSON.stringify(request.messages).includes(data));
      assert.match(JSON.stringify(request.messages), /photo\.png/);
      return result("The photo was examined.");
    }
    main++;
    if (main === 1) return { text: "", toolCalls: [{ id: "i", name: "photo", arguments: {} }], finishReason: "tool_calls" };
    assert.ok(!JSON.stringify(request.messages).includes(data));
    return result("done");
  } };
  const agent = createAgent({ provider, registry, system: "tiny", compact: { triggerTokens: 1000,
    keepRecentTurns: 1, maxOutputTokens: 100 } });
  assert.equal((await agent.run("view photo")).status, "completed");
  assert.equal(main, 2);
  assert.equal(summarized, true);
});

test("irreducible summary fails before inference and nonshrinking summary does not recurse", async () => {
  let requests = 0;
  const provider: ProviderAdapter = { profile: { name: "small", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 2000, maxOutputTokens: 100 }, async generate(request) {
    requests++;
    if (request.system === COMPACT_SYSTEM_PROMPT) return result("S".repeat(5000));
    return result("answer");
  } };
  const first = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 400, keepRecentTurns: 0, maxOutputTokens: 100 } });
  const irreducible = await first.run("X".repeat(5000));
  assert.equal(irreducible.code, "compact_error");
  assert.equal(requests, 0);
  const second = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 250, keepRecentTurns: 0, maxOutputTokens: 100 } });
  const statuses: string[] = [];
  const nonshrinking = await second.run("Y".repeat(700), (event) => {
    if (event.type === "compact_end") statuses.push(event.result.status);
  });
  assert.equal(nonshrinking.status, "completed");
  assert.deepEqual(statuses, ["not_smaller"]);
  assert.equal(requests, 2);
});

test("automatic compact is abortable and cannot commit a late summary", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (turn: ProviderTurn) => void;
  const late = new Promise<ProviderTurn>((resolve) => { finish = resolve; });
  let main = 0;
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 4000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { entered(); return late; }
    main++;
    return result("x".repeat(1600));
  } };
  const agent = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 400, keepRecentTurns: 1, maxOutputTokens: 100 } });
  await agent.run("first");
  const prior = JSON.stringify(agent.transcript);
  const pending = agent.run("continue");
  await ready;
  agent.abort();
  assert.equal((await pending).status, "cancelled");
  finish(result("late summary"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main, 1);
  assert.ok(JSON.stringify(agent.transcript).startsWith(prior.slice(0, -1)));
  assert.doesNotMatch(JSON.stringify(agent.transcript), /Conversation summary|late summary/);
});

test("a second automatic compact can summarize continuation after zero-retention compact", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "large", description: "large", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "T".repeat(2200) }] }) });
  let main = 0;
  let summaries = 0;
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 5000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { summaries++; return result(`summary ${summaries}`); }
    main++;
    if (main === 1) return { text: "", toolCalls: [{ id: "c", name: "large", arguments: {} }], finishReason: "tool_calls" };
    return result("D".repeat(1400));
  } };
  const agent = createAgent({ provider, registry, system: "tiny", compact: { triggerTokens: 700,
    keepRecentTurns: 2, maxOutputTokens: 100 } });
  assert.equal((await agent.run("go")).status, "completed");
  assert.equal((await agent.run("continue")).status, "completed");
  assert.ok(summaries >= 2);
  assert.equal(agent.transcript[0]?.role, "user");
});

test("successive usage reports can increase absolute token calibration", async () => {
  let main = 0;
  let summaries = 0;
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 10000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { summaries++; return result("summary"); }
    main++;
    const base = estimateRequestTokens(request.system, request.messages, request.tools);
    const actual = Math.ceil(base * (main === 1 ? 1.5 : 1.9));
    return result("ok", { prompt_tokens: actual, completion_tokens: 1 });
  } };
  const agent = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 1900, keepRecentTurns: 1, maxOutputTokens: 100 } });
  await agent.run("a".repeat(100));
  await agent.run("b".repeat(1000));
  const events: string[] = [];
  assert.equal((await agent.run("c".repeat(1000), (event) => events.push(event.type))).status, "completed");
  assert.ok(events.includes("compact_start"));
  assert.equal(summaries, 1);
});

test("every chunk of a repeated compact budgets its accumulated summary", async () => {
  const contextWindow = 1500;
  const outputTokens = 100;
  const previousSummary = "Earlier task summary";
  const messages: ProviderRequest["messages"][number][] = [
    { role: "user", content: "task" },
    { role: "user", content: `[Conversation summary]\n${previousSummary}` },
  ];
  for (let index = 0; index < 6; index++) messages.push({ role: "user", content: `turn ${index}` },
    { role: "assistant", text: "A".repeat(250), toolCalls: [] });
  const totals: number[] = [];
  const provider: ProviderAdapter = { profile: { name: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow }, async generate(request) {
    totals.push(Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages,
      tools: request.tools })) + outputTokens + 75);
    return result("S".repeat(350), { completion_tokens: 50 });
  } };
  const work = await performCompaction({ messages, originalTask: "task", previousSummary }, provider,
    { keepRecentTurns: 0, maxOutputTokens: outputTokens, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
  assert.equal(work.result.status, "compacted");
  assert.ok(totals.length >= 2);
  assert.ok(totals.every((total) => total <= contextWindow), `out-of-budget requests: ${totals}`);
});
