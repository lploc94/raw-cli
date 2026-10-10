import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type RunEvent } from "../src/agent.js";
import { CHECKPOINT_NO_TOOLS_GUARD, COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import { normalizeUsage, toolChoiceKeepsCache } from "../src/llm/cache.js";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage, ProviderAdapter, ProviderRequest, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const stop = (text: string, usage?: unknown): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop", ...(usage === undefined ? {} : { usage }) });
const isSummary = (request: { system: string; tools: readonly unknown[]; messages: readonly ModelMessage[] }) =>
  request.system === COMPACT_SYSTEM_PROMPT || request.messages.at(-1)?.role === "user"
    && JSON.stringify(request.messages.at(-1)).includes(CHECKPOINT_NO_TOOLS_GUARD.slice(0, 30));
type Seen = Pick<ProviderRequest, "system" | "tools" | "messages" | "cacheKey" | "toolChoice" | "maxOutputTokens">;

function probes() {
  const registry = new ToolRegistry();
  registry.register({ name: "probe", description: "Reads a probe", inputSchema: { type: "object", properties: { n: { type: "integer" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: `probe ${String(args.n)} ${"r".repeat(800)}` }] }) });
  return registry;
}

/** A provider whose main replies call `probe` `calls` times, then answer; `summary` answers every compaction request. */
function scripted(model: Partial<ResolvedModelConfig>, calls: number, summary: (request: Seen) => ProviderTurn) {
  const seen: Seen[] = [];
  let main = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "p", provider: "ollama", method: "openai-chat-completions", model: "fixture",
    contextWindow: 60000, maxOutputTokens: 1000, ...model }, async generate(request) {
    const { system, tools, messages, cacheKey, toolChoice, maxOutputTokens } = request;
    const copy = structuredClone({ system, tools, messages, cacheKey, toolChoice, maxOutputTokens }) as Seen;
    seen.push(copy);
    if (isSummary(copy)) return summary(copy);
    main++;
    return main <= calls ? { text: "", toolCalls: [{ id: `c${main}`, name: "probe", arguments: { n: main } }], finishReason: "tool_calls" } : stop("answered");
  } };
  return { provider, seen };
}

async function session(model: Partial<ResolvedModelConfig>, summary: (request: Seen) => ProviderTurn) {
  const { provider, seen } = scripted(model, 4, summary);
  const agent = createAgent({ provider, registry: probes(), system: "You are the main agent.", cwd: mkdtempSync(join(tmpdir(), "raw-cache-compact-")) });
  await agent.run("first task");
  await agent.run("second task");
  return { agent, seen, provider };
}

test("1: the summary request repeats the main request's system, tools and messages and adds only the checkpoint prompt", async () => {
  const { agent, seen } = await session({}, () => stop("## Goal\nkeep going"));
  const lastMain = seen.at(-1)!;
  const transcript = agent.transcript;
  const events: RunEvent[] = [];
  assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
  const summaries = seen.filter(isSummary);
  assert.equal(summaries.length, 1);
  const request = summaries[0]!;
  assert.equal(request.system, lastMain.system);
  assert.deepEqual(request.tools, lastMain.tools);
  assert.ok(request.tools.length > 0);
  // Every message the main context held at compaction, unchanged, then the prompt.
  assert.deepEqual(request.messages.slice(0, -1), transcript);
  assert.deepEqual(request.messages.slice(0, lastMain.messages.length), lastMain.messages);
  const prompt = request.messages.at(-1)!;
  assert.equal(prompt.role, "user");
  assert.ok(typeof prompt.content === "string" && prompt.content.startsWith(CHECKPOINT_NO_TOOLS_GUARD));
  // Same cache key as the main requests; tool settings unchanged on an adapter not listed for toolChoice.
  assert.equal(request.cacheKey, lastMain.cacheKey);
  assert.equal(request.toolChoice, undefined);
  // The checkpoint is assembled as in phase 2.
  assert.match(JSON.stringify(agent.transcript[0]), /Raw compaction checkpoint #1\]/);
  assert.match(JSON.stringify(agent.transcript[0]), /keep going/);
});

test("2: a returned tool call, a context that does not fit, or another compaction model use the chunked path", async () => {
  // A tool call: one same-context attempt, then the chunked request.
  {
    const { agent, seen } = await session({}, (request) => request.system === COMPACT_SYSTEM_PROMPT ? stop("## Goal\nchunked")
      : { text: "", toolCalls: [{ id: "x", name: "probe", arguments: {} }], finishReason: "tool_calls" });
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const summaries = seen.filter(isSummary);
    assert.equal(summaries.length, 2);
    assert.notEqual(summaries[0]!.system, COMPACT_SYSTEM_PROMPT);
    assert.equal(summaries[1]!.system, COMPACT_SYSTEM_PROMPT);
    assert.deepEqual(summaries[1]!.tools, []);
    assert.equal(summaries[1]!.messages.length, 1);
    assert.match(JSON.stringify(agent.transcript[0]), /chunked/);
  }
  // A tool call cut at the output limit is not retried in the same context, even when a larger budget would be allowed.
  {
    const { agent, seen } = await session({ maxOutputTokens: 8000 }, (request) => request.system === COMPACT_SYSTEM_PROMPT ? stop("## Goal\nchunked")
      : { text: "", toolCalls: [{ id: "x", name: "probe", arguments: {} }], finishReason: "length", truncated: true });
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1000 })).status, "compacted");
    assert.deepEqual(seen.filter(isSummary).map((request) => request.system === COMPACT_SYSTEM_PROMPT), [false, true]);
  }
  // A provider error on the same-context attempt also falls back.
  {
    const { agent, seen } = await session({}, (request) => { if (request.system !== COMPACT_SYSTEM_PROMPT) throw new Error("rejected"); return stop("## Goal\nafter error"); });
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.deepEqual(seen.filter(isSummary).map((request) => request.system === COMPACT_SYSTEM_PROMPT), [false, true]);
  }
  // A main context that leaves no room for the prompt and the output budget: the chunked path only.
  {
    const { agent, seen } = await session({ contextWindow: 9000 }, () => stop("## Goal\nsmall"));
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 4000 })).status, "compacted");
    assert.ok(seen.filter(isSummary).every((request) => request.system === COMPACT_SYSTEM_PROMPT));
  }
  // A different compaction model cannot reuse the main cache.
  {
    const { agent } = await session({}, () => stop("unused"));
    const other = scripted({}, 0, () => stop("## Goal\nother model"));
    assert.equal((await agent.compact({ provider: other.provider, keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.ok(other.seen.length >= 1 && other.seen.every((request) => request.system === COMPACT_SYSTEM_PROMPT));
  }
});

const anthropicText = (text: string, usage = { input_tokens: 1, output_tokens: 1 }) => [
  anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage } }),
  anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text } }),
  anthropicFrame("content_block_stop", { index: 0 }),
  anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
  anthropicFrame("message_stop", {}),
];
const responsesText = (text: string) => [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
  response: { id: "r", object: "response", status: "completed", model: "fixture", output: [{ type: "message", id: "o", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }], usage: null } })}\n\n`, "data: [DONE]\n\n"];

test("3: toolChoice is sent only when set, in each adapter's form, and compaction sets it only where the cache is documented to survive", async () => {
  const tool = { name: "probe", description: "probe", inputSchema: { type: "object" as const, properties: {} } };
  const cases = [
    { provider: "openai", method: "openai-chat-completions", frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone],
      read: (body: Record<string, unknown>) => body.tool_choice, none: "none", auto: "auto" },
    { provider: "openai", method: "openai-responses", frames: responsesText("ok"), read: (body: Record<string, unknown>) => body.tool_choice, none: "none", auto: "auto" },
    { provider: "anthropic", method: "anthropic-messages", frames: anthropicText("ok"), read: (body: Record<string, unknown>) => body.tool_choice,
      none: { type: "none" }, auto: { type: "auto" } },
    { provider: "google", method: "google-generate-content", frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })],
      read: (body: Record<string, unknown>) => (body.toolConfig as { functionCallingConfig?: { mode?: string } } | undefined)?.functionCallingConfig?.mode, none: "NONE", auto: "AUTO" },
  ] as const;
  for (const scenario of cases) {
    const fixture = await startMockProvider([{ frames: [...scenario.frames] }, { frames: [...scenario.frames] }, { frames: [...scenario.frames] }]);
    try {
      const adapter = createProvider({ agentName: "a", provider: scenario.provider, method: scenario.method, model: "fixture", baseUrl: fixture.url, apiKey: "k", maxOutputTokens: 100 });
      const base = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [tool], timeoutMs: 5000 };
      await adapter.generate(base);
      await adapter.generate({ ...base, toolChoice: "none" });
      await adapter.generate({ ...base, toolChoice: "auto" });
      const bodies = fixture.requests.map((request) => request.body as Record<string, unknown>);
      assert.equal(scenario.read(bodies[0]!), undefined, `${scenario.method} sends nothing by default`);
      assert.deepEqual(scenario.read(bodies[1]!), scenario.none, scenario.method);
      assert.deepEqual(scenario.read(bodies[2]!), scenario.auto, scenario.method);
    } finally { await fixture.close(); }
  }
  // Only OpenAI documents that tool_choice "none" keeps the prompt cache.
  assert.equal(toolChoiceKeepsCache({ provider: "openai", method: "openai-chat-completions" }), true);
  assert.equal(toolChoiceKeepsCache({ provider: "openai", method: "openai-responses" }), true);
  assert.equal(toolChoiceKeepsCache({ provider: "anthropic", method: "anthropic-messages" }), false);
  assert.equal(toolChoiceKeepsCache({ provider: "google", method: "google-generate-content" }), false);
  assert.equal(toolChoiceKeepsCache({ provider: "ollama", method: "openai-chat-completions" }), false);
  // End to end: the OpenAI summary request carries tool_choice "none"; the Anthropic one keeps the main tool settings.
  for (const scenario of [{ provider: "openai", method: "openai-chat-completions" }, { provider: "anthropic", method: "anthropic-messages" }] as const) {
    const answer = (text: string) => scenario.provider === "openai" ? [openAiFrame({ content: text }, "stop"), openAiDone] : anthropicText(text);
    const call = (id: string) => scenario.provider === "openai"
      ? [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name: "probe", arguments: "{\"n\":1}" } }] }, "tool_calls"), openAiDone]
      : [anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
        anthropicFrame("content_block_start", { index: 0, content_block: { type: "tool_use", id, name: "probe", input: {} } }),
        anthropicFrame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"n\":1}" } }),
        anthropicFrame("content_block_stop", { index: 0 }),
        anthropicFrame("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }),
        anthropicFrame("message_stop", {})];
    const fixture = await startMockProvider([{ frames: call("c1") }, { frames: answer("first done") }, { frames: answer("second") }, { frames: answer("## Goal\nwire") }]);
    try {
      const agent = createAgent({ provider: createProvider({ agentName: "a", provider: scenario.provider, method: scenario.method, model: "fixture",
        baseUrl: fixture.url, apiKey: "k", maxOutputTokens: 1000, contextWindow: 60000 }), registry: probes(), system: "main", cwd: mkdtempSync(join(tmpdir(), "raw-cache-wire-")) });
      await agent.run("one");
      await agent.run("two");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
      const bodies = fixture.requests.map((request) => request.body as Record<string, unknown>);
      const main = bodies[2]!;
      const summary = bodies[3]!;
      assert.deepEqual(summary.tools, main.tools);
      assert.deepEqual(summary.system, main.system);
      assert.equal(main.tool_choice, undefined);
      assert.deepEqual(summary.tool_choice, scenario.provider === "openai" ? "none" : undefined);
    } finally { await fixture.close(); }
  }
});

test("4: usage of the same-context request reports the provider's cache-read count", async () => {
  const cached = { prompt_tokens: 9000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 8700 } };
  const { agent } = await session({}, () => stop("## Goal\ncached", cached));
  const usage: unknown[] = [];
  assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => { if (event.type === "usage") usage.push(event.raw); })).status, "compacted");
  assert.equal(usage.length, 1);
  assert.equal(normalizeUsage("openai-chat-completions", usage[0], "ollama").cacheReadTokens, 8700);
});
