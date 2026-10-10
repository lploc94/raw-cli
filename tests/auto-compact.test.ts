import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { ToolRegistry, createTestToolRegistry } from "./fixtures/registry.js";
import { COMPACT_SYSTEM_PROMPT, CompactionOverheadError, estimateRequestTokens, summarizeTranscript } from "../src/compact.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";

const result = (text: string, usage?: unknown): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop",
  ...(usage === undefined ? {} : { usage }) });

test("trigger_tokens needs a context budget and validates its reserve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raw-auto-config-"));
  const path = join(directory, "config.json");
  const config = (context?: number, trigger = 500) => ({ default_agent: "p",
    models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture",
      ...(context === undefined ? {} : { context_window_tokens: context }) } },
    agents: { p: { model: "m", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] }, compact: { trigger_tokens: trigger, max_output_tokens: 100 } } } });
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
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 8000, maxOutputTokens: 100 }, async generate(request) {
    const { signal: _signal, onUsage: _onUsage, onTextDelta: _onTextDelta,
      onReasoningDelta: _onReasoningDelta, ...wire } = request;
    requests.push(structuredClone(wire));
    if (request.system === COMPACT_SYSTEM_PROMPT) return result("Summary of the prior task.", { prompt_tokens: 30, completion_tokens: 8 });
    return result(requests.length === 1 ? "x".repeat(1600) : "continued", requests.length === 1 ? { prompt_tokens: 100, completion_tokens: 400 } : { prompt_tokens: 100, completion_tokens: 10 });
  } };
  const events: string[] = [];
  const agent = createAgent({ provider, cwd, system: "tiny", registry: new ToolRegistry(),
    compact: { triggerTokens: 400, keepRecentTurns: 1, keepRecentTokens: 1, maxOutputTokens: 100 } });
  assert.equal((await agent.run("first")).status, "completed");
  assert.equal((await agent.run("continue", (event) => events.push(event.type))).status, "completed");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.system), ["tiny", COMPACT_SYSTEM_PROMPT, "tiny"]);
  assert.ok(events.includes("compact_start") && events.includes("compact_end"));
  assert.equal(agent.stats().requests, 3);
  assert.equal(requests[0]?.cacheKey, requests[2]?.cacheKey);
  assert.notEqual(requests[1]?.cacheKey, requests[2]?.cacheKey);
  assert.match(JSON.stringify(agent.transcript), /Raw compaction checkpoint #1/);
});

test("manual compaction chunks older turns and never sends image base64 to the summarizer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-auto-image-"));
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const registry = createTestToolRegistry([], true);
  registry.register({ name: "fixture_image", description: "image", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "image", mimeType: "image/png", data: image,
      path: "photo.png", byteSize: 8 }] }) });
  let calls = 0;
  const main: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", vision: true, contextWindow: 20000, maxOutputTokens: 100 }, async generate() {
    calls++;
    if (calls === 1) return { text: "", toolCalls: [{ id: "img", name: "fixture_image", arguments: {} }], finishReason: "tool_calls" };
    return result("answer ".repeat(80));
  } };
  const agent = createAgent({ provider: main, registry, cwd, system: "tiny" });
  await agent.run("first photo");
  for (let index = 0; index < 5; index++) await agent.run(`turn ${index}`);
  const summaries: ProviderRequest[] = [];
  // The summarizer's own context is small, so the older turns need several chunks.
  const summarizer: ProviderAdapter = { modelConfig: { ...main.modelConfig, contextWindow: 4600 }, async generate(request) {
    summaries.push(request);
    assert.ok(!JSON.stringify(request.messages).includes(image));
    assert.ok(!JSON.stringify(request.messages).includes("data:image"));
    return result("summary");
  } };
  const priorRequests = agent.stats().requests;
  const compacted = await agent.compact({ provider: summarizer, keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 100 });
  assert.equal(compacted.status, "compacted");
  assert.ok(summaries.length >= 2);
  assert.equal(agent.stats().requests, priorRequests + summaries.length);
  assert.ok(summaries.every((request) => !JSON.stringify(request.messages).includes(image)));
  assert.ok(summaries.every((request) => estimateRequestTokens(request.system, request.messages, request.tools) + 100 + 230 <= 4600));
  assert.ok(!JSON.stringify(agent.transcript).includes(image));
});

test("tool output and opaque reasoning trigger compact despite small previous usage", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "large", description: "large result", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "T".repeat(2200) }] }) });
  let summaries = 0;
  let main = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
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
  // The step in progress stays, with its result head/tail-cut to the tail budget and a pointer to the full text.
  const transcript = JSON.stringify(agent.transcript);
  assert.ok(!transcript.includes("T".repeat(2200)) && transcript.includes("bytes omitted; full output: "));
  assert.ok(transcript.includes('"callId":"c"') && transcript.includes('"id":"c"'));
});

test("an early no-op over the threshold is stuck: the next crossing takes the fallback, not the summarizer", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "large", description: "large", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "T".repeat(1600) }] }) });
  let main = 0;
  let summaries = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 5000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { summaries++; return result("summarized"); }
    main++;
    return main === 1 ? { text: "", toolCalls: [{ id: "c", name: "large", arguments: {} }], finishReason: "tool_calls" } : result("done");
  } };
  const statuses: string[] = [];
  const agent = createAgent({ provider, registry, system: "tiny", compact: { triggerTokens: 40,
    keepRecentTurns: 1, keepRecentTokens: 100, maxOutputTokens: 100 } });
  assert.equal((await agent.run("go", (event) => {
    if (event.type === "compact_end") statuses.push(event.result.status);
  })).status, "completed");
  // The no-op leaves the request over the threshold, so the fallback runs at once and finds nothing older either. After the
  // tool result, the stuck class sends the next crossing to the fallback's mechanical checkpoint.
  assert.deepEqual(statuses, ["noop", "noop", "compacted"]);
  assert.equal(summaries, 0);
  assert.match(JSON.stringify(agent.transcript), /\[Checkpoint unavailable: compaction earlier in this turn did not bring the context under the threshold; older steps were removed/);
});

test("an oversized recent image is summarized as metadata before the next main request", async () => {
  const data = Buffer.alloc(12_000, 7).toString("base64");
  const registry = new ToolRegistry();
  registry.register({ name: "photo", description: "photo", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "image", mimeType: "image/png", data,
      path: "photo.png", byteSize: 12_000 }] }) });
  let main = 0;
  let summarized = false;
  const provider: ProviderAdapter = { modelConfig: { agentName: "vision", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", vision: true, contextWindow: 4000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) {
      summarized = true;
      assert.ok(!JSON.stringify(request.messages).includes(data));
      return result("The photo was examined.");
    }
    main++;
    if (main === 1) return { text: "", toolCalls: [{ id: "i", name: "photo", arguments: {} }], finishReason: "tool_calls" };
    // The image in the kept step is replaced by its metadata line.
    assert.ok(!JSON.stringify(request.messages).includes(data));
    assert.match(JSON.stringify(request.messages), /photo\.png/);
    return result("done");
  } };
  const agent = createAgent({ provider, registry, system: "tiny", compact: { triggerTokens: 1000,
    keepRecentTurns: 1, maxOutputTokens: 100 } });
  assert.equal((await agent.run("view photo")).status, "completed");
  assert.equal(main, 2);
  assert.equal(summarized, true);
});

test("a summarizer context too small for the checkpoint prompt fails before inference and nonshrinking summary does not recurse", async () => {
  let requests = 0;
  const small = (contextWindow: number): ProviderAdapter => ({ modelConfig: { agentName: "small", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow, maxOutputTokens: 100 }, async generate(request) {
    requests++;
    if (request.system === COMPACT_SYSTEM_PROMPT) return result("S".repeat(5000));
    return result("answer");
  } });
  // A summarizer whose context cannot hold the checkpoint prompt fails before any request.
  const first = createAgent({ provider: small(20000), registry: new ToolRegistry(), system: "tiny" });
  await first.run("hello");
  await first.run("again");
  requests = 0;
  await assert.rejects(first.compact({ provider: small(2000), keepRecentTokens: 1 }), CompactionOverheadError);
  assert.equal(requests, 0);
  // A main context too small for any checkpoint degrades to the mechanical note and cuts the request with a pointer.
  const tight = createAgent({ provider: small(2000), registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 400, keepRecentTurns: 0, maxOutputTokens: 100 } });
  await tight.run("hello");
  const statuses: string[] = [];
  const degraded = await tight.run("X".repeat(5000), (event) => { if (event.type === "compact_end") statuses.push(event.result.status); });
  assert.equal(degraded.status, "completed");
  // Still over the threshold, so the fallback runs and finds nothing older to remove.
  assert.deepEqual(statuses, ["compacted", "noop"]);
  const context = JSON.stringify(tight.transcript);
  assert.match(context, /\[Checkpoint unavailable: no room left in the context for a new checkpoint; older steps were removed/);
  assert.ok(context.includes("[… cut; full text: not kept]") && !context.includes("X".repeat(5000)));
  requests = 0;
  const second = createAgent({ provider: small(6000), registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 250, keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 100 } });
  await second.run("hello");
  const nonshrinking = await second.run("Y".repeat(700), (event) => {
    if (event.type === "compact_end") statuses.push(event.result.status);
  });
  assert.equal(nonshrinking.status, "completed");
  // The fallback's mechanical checkpoint is not smaller either, and makes no request.
  assert.deepEqual(statuses.slice(2), ["not_smaller", "not_smaller"]);
  assert.equal(requests, 3);
});

test("automatic compact is abortable and cannot commit a late summary", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (turn: ProviderTurn) => void;
  const late = new Promise<ProviderTurn>((resolve) => { finish = resolve; });
  let main = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 4000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { entered(); return late; }
    main++;
    return result("x".repeat(1600));
  } };
  const agent = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 400, keepRecentTurns: 1, keepRecentTokens: 1, maxOutputTokens: 100 } });
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
  assert.doesNotMatch(JSON.stringify(agent.transcript), /Raw compaction checkpoint|late summary/);
});

test("a second automatic compact can summarize continuation after zero-retention compact", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "large", description: "large", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "T".repeat(2200) }] }) });
  let main = 0;
  let summaries = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
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
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 10000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { summaries++; return result("summary"); }
    main++;
    const base = estimateRequestTokens(request.system, request.messages, request.tools);
    const actual = Math.ceil(base * (main === 1 ? 1.5 : 1.9));
    return result("ok", { prompt_tokens: actual, completion_tokens: 1 });
  } };
  const agent = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 1700, keepRecentTurns: 1, maxOutputTokens: 100 } });
  await agent.run("a".repeat(100));
  await agent.run("b".repeat(1000));
  const events: string[] = [];
  assert.equal((await agent.run("c".repeat(1000), (event) => events.push(event.type))).status, "completed");
  assert.ok(events.includes("compact_start"));
  assert.equal(summaries, 1);
});

test("every chunk of a repeated compact budgets its accumulated summary", async () => {
  const contextWindow = 4600;
  const outputTokens = 100;
  const previousSummary = "Earlier task summary";
  const messages: ProviderRequest["messages"][number][] = [
    { role: "user", content: "task" },
    { role: "user", content: `[Conversation summary]\n${previousSummary}` },
  ];
  for (let index = 0; index < 6; index++) messages.push({ role: "user", content: `turn ${index}` },
    { role: "assistant", text: "A".repeat(500), toolCalls: [] });
  const totals: number[] = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow }, async generate(request) {
    totals.push(estimateRequestTokens(request.system, request.messages, request.tools) + outputTokens + 230);
    return result("S".repeat(350), { completion_tokens: 50 });
  } };
  const work = await summarizeTranscript(messages.slice(2), provider,
    { prior: previousSummary, maxOutputTokens: outputTokens, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
  assert.equal(work.status, "summarized");
  assert.ok(totals.length >= 2);
  assert.ok(totals.every((total) => total <= contextWindow), `out-of-budget requests: ${totals}`);
});

test("compact.instructions is validated and reaches the summarizer for manual and automatic compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raw-compact-instructions-"));
  const path = join(directory, "config.json");
  const config = (instructions: unknown) => ({ default_agent: "p",
    models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture", context_window_tokens: 20000 } },
    agents: { p: { model: "m", tools: { use: ["builtin/read_file"] }, compact: { instructions } } } });
  await writeFile(path, JSON.stringify(config("Keep every audit item ID.")));
  assert.equal((await loadConfig({ configPath: path, env: {}, requireModel: true })).compact.instructions, "Keep every audit item ID.");
  await writeFile(path, JSON.stringify(config("x".repeat(16384))));
  assert.equal((await loadConfig({ configPath: path, env: {}, requireModel: true })).compact.instructions?.length, 16384);
  for (const invalid of [42, ["a"], "x".repeat(16385)]) {
    await writeFile(path, JSON.stringify(config(invalid)));
    await assert.rejects(loadConfig({ configPath: path, env: {}, requireModel: true }), /compact\.instructions/);
  }

  const instructions = `instructions-${Math.random()}`;
  const marker = `Additional instructions from the agent configuration:\n${instructions}`;
  const seen: string[] = [];
  let main = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: 8000, maxOutputTokens: 100 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) {
      const content = request.messages[0]?.role === "user" ? request.messages[0].content : "";
      seen.push(typeof content === "string" && content.endsWith(marker) ? "with" : "without");
      return result("summary");
    }
    main++;
    return result("x".repeat(1600));
  } };
  const automatic = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { triggerTokens: 400, keepRecentTurns: 1, keepRecentTokens: 1, maxOutputTokens: 100, instructions } });
  await automatic.run("first");
  assert.equal((await automatic.run("second")).status, "completed");
  assert.deepEqual(seen, ["with"]);
  await automatic.run("third");
  const manual = createAgent({ provider, registry: new ToolRegistry(), system: "tiny",
    compact: { keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 100, instructions } });
  await manual.run("first");
  await manual.run("second");
  assert.equal((await manual.compact({ keepRecentTurns: 0, maxOutputTokens: 100 })).status, "compacted");
  const explicit = createAgent({ provider, registry: new ToolRegistry(), system: "tiny" });
  await explicit.run("first");
  await explicit.run("second");
  assert.equal((await explicit.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 100, instructions })).status, "compacted");
  const none = createAgent({ provider, registry: new ToolRegistry(), system: "tiny" });
  await none.run("first");
  await none.run("second");
  assert.equal((await none.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 100 })).status, "compacted");
  assert.deepEqual(seen.slice(-3), ["with", "with", "without"]);
});

/**
 * Phase 4 fixture (§6.5, §6.7): every main step calls `probe`, whose result is `pad` bytes, until `probes` calls; then "done".
 * `summary` answers the summarizer. `log` records the order of main ("M") and summarizer ("S") requests.
 */
function refill(options: { contextWindow: number; trigger: number; pad: number; probes: number; summary: () => ProviderTurn;
  system?: string; usage?: (index: number) => unknown; main?: (index: number) => ProviderTurn | undefined }) {
  const registry = new ToolRegistry();
  let serial = 0;
  registry.register({ name: "probe", description: "probe", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: `result ${++serial} ${"r".repeat(options.pad)}` }] }) });
  const log: string[] = [];
  const mains: ProviderRequest[] = [];
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions",
    model: "fixture", contextWindow: options.contextWindow, maxOutputTokens: 1000 }, async generate(request) {
    if (request.system === COMPACT_SYSTEM_PROMPT) { log.push("S"); return options.summary(); }
    log.push("M");
    mains.push(structuredClone({ system: request.system, messages: request.messages }) as ProviderRequest);
    const index = calls++;
    const usage = options.usage?.(index);
    const turn = options.main?.(index) ?? (index < options.probes
      ? { text: "", toolCalls: [{ id: `p${index}`, name: "probe", arguments: {} }], finishReason: "tool_calls" as const } : result("done"));
    return usage === undefined ? turn : { ...turn, usage };
  } };
  const events: Array<{ type: string; status?: string; cause?: string; afterTokens?: number | undefined }> = [];
  const agent = createAgent({ provider, registry, system: options.system ?? "tiny", maxSteps: 200,
    compact: { triggerTokens: options.trigger, keepRecentTurns: 0, keepRecentTokens: 1500, maxOutputTokens: 1000 } });
  const run = (input = "go") => agent.run(input, (event) => {
    if (event.type === "compact_end") events.push({ type: event.type, status: event.result.status, afterTokens: event.details?.afterTokens });
    else if (event.type === "compact_error") events.push({ type: event.type, cause: event.details.cause });
  });
  return { agent, log, mains, events, run };
}
const STUB = "[Old tool result cleared: ";
const MECHANICAL = "[Checkpoint unavailable: ";

test("phase 4/1: tool output that refills the window twice in one turn is compacted twice and the turn completes", async () => {
  // 40k context: input budget 37000, trigger 80% of it. A compaction lands near half the budget, under 0.7·T.
  const f = refill({ contextWindow: 40000, trigger: 29600, pad: 6000, probes: 25, summary: () => result("## Goal\nkeep probing") });
  const outcome = await f.run();
  assert.equal(outcome.status, "completed");
  const compactions = f.events.filter((event) => event.type === "compact_end");
  assert.ok(compactions.length >= 2, `compactions: ${compactions.length}`);
  assert.ok(compactions.every((event) => event.status === "compacted" && event.afterTokens! < 0.7 * 29600));
  assert.equal(f.log.filter((entry) => entry === "S").length, compactions.length);
  // Each compaction follows completed main steps, and the committed context is the latest checkpoint, not a fallback.
  assert.doesNotMatch(f.log.join(""), /SS/);
  const context = JSON.stringify(f.agent.transcript);
  assert.match(context, new RegExp(`Raw compaction checkpoint #${compactions.length}\\]`));
  assert.ok(!context.includes(MECHANICAL) && !context.includes(STUB));
});

test("phase 4/2: after a weak compaction the next crossing runs the fallback before any second summary", async () => {
  // A checkpoint of about 21k tokens leaves the context near 0.8·T after the first compaction.
  const f = refill({ contextWindow: 40000, trigger: 29600, pad: 6000, probes: 13, summary: () => result(`## Goal\n${"w ".repeat(21000)}`) });
  assert.equal((await f.run()).status, "completed");
  const first = f.events.find((event) => event.type === "compact_end")!;
  assert.equal(first.status, "compacted");
  assert.ok(first.afterTokens! >= 0.7 * 29600 && first.afterTokens! < 29600, `after ${first.afterTokens}`);
  assert.equal(f.log.filter((entry) => entry === "S").length, 1, "no second summarizer request");
  // The crossing after it cleared old results to saved copies instead, and the next request carried the stubs.
  const afterFirst = f.mains.filter((request) => JSON.stringify(request.messages).includes("Raw compaction checkpoint #1"));
  assert.ok(afterFirst.some((request) => JSON.stringify(request.messages).includes(STUB)));
});

test("phase 4/3: a failing summarizer warns, commits a mechanical checkpoint, and the turn completes", async () => {
  // Results under 2 KB cannot be cleared, so the fallback reaches the mechanical checkpoint.
  const f = refill({ contextWindow: 20000, trigger: 14400, pad: 1800, probes: 20, summary: () => { throw new Error("summary unavailable"); } });
  const outcome = await f.run();
  assert.equal(outcome.status, "completed");
  assert.deepEqual(f.events.find((event) => event.type === "compact_error"), { type: "compact_error", cause: "automatic" });
  const context = JSON.stringify(f.agent.transcript);
  assert.ok(context.includes(`${MECHANICAL}the checkpoint request failed; older steps were removed`));
  assert.match(context, /Raw compaction checkpoint #1\]/);
  assert.ok(f.mains.some((request) => JSON.stringify(request.messages).includes(`${MECHANICAL}the checkpoint request failed`)));
});

test("phase 4/4: a summarizer that keeps failing is never asked twice without a completed step in between", async () => {
  const f = refill({ contextWindow: 20000, trigger: 14400, pad: 1800, probes: 60, summary: () => { throw new Error("summary unavailable"); } });
  assert.equal((await f.run()).status, "completed");
  const summaries = f.log.filter((entry) => entry === "S").length;
  assert.ok(summaries >= 2, `summaries: ${summaries}`);
  assert.doesNotMatch(f.log.join(""), /SS/);
  assert.ok(summaries <= f.log.filter((entry) => entry === "M").length);
});

test("phase 4/5: after the fallbacks a measured overflow ends the turn, and an estimated one is sent to the provider", async () => {
  // Measured: the provider reports 50k input tokens for a 20k context, and nothing older can be removed.
  const measured = refill({ contextWindow: 20000, trigger: 14400, pad: 10, probes: 5, summary: () => result("unused"),
    usage: () => ({ prompt_tokens: 50000, completion_tokens: 10 }) });
  const stopped = await measured.run();
  assert.equal(stopped.status, "error");
  assert.equal(stopped.code, "context_budget_exceeded");
  assert.equal(measured.log.filter((entry) => entry === "M").length, 1);
  assert.ok(!measured.events.some((event) => event.type === "compact_error"));
  // Estimated: a system prompt larger than the budget cannot be compacted; the request is sent and the provider decides.
  const estimated = refill({ contextWindow: 20000, trigger: 14400, pad: 10, probes: 0, summary: () => result("unused"), system: "S".repeat(40000),
    main: () => { throw Object.assign(new Error("prompt is too long"), { code: "provider_error" }); } });
  const rejected = await estimated.run();
  assert.equal(rejected.status, "error");
  assert.equal(rejected.code, "provider_error");
  assert.match(rejected.message ?? "", /prompt is too long/);
  assert.equal(estimated.log.filter((entry) => entry === "M").length, 1);
});

test("phase 4/6: manual compaction still rejects on a provider error", async () => {
  const f = refill({ contextWindow: 20000, trigger: 14400, pad: 10, probes: 0, summary: () => { throw new Error("summary unavailable"); } });
  await f.run("first");
  await f.run("second");
  const prior = JSON.stringify(f.agent.transcript);
  await assert.rejects(f.agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }), /summary unavailable/);
  assert.equal(JSON.stringify(f.agent.transcript), prior);
});

test("phase 4/R1: an abort when the mechanical fallback starts cancels the turn and commits nothing", async () => {
  const f = refill({ contextWindow: 20000, trigger: 14400, pad: 1800, probes: 20, summary: () => { throw new Error("summary unavailable"); } });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    let starts = 0;
    let before: string | undefined;
    const outcome = await f.agent.run("go", (event) => {
      // The first start is the failing summary; the second is the fallback's mechanical checkpoint.
      if (event.type === "compact_start" && ++starts === 2) { before = JSON.stringify(f.agent.transcript); f.agent.abort(); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 2);
    assert.equal(outcome.status, "cancelled");
    assert.equal(JSON.stringify(f.agent.transcript), before);
    assert.doesNotMatch(before!, /Raw compaction checkpoint|Checkpoint unavailable/);
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});
