import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { DEFAULT_OUTPUT_TOKENS, effectiveOutputTokens } from "../src/llm/output.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { anthropicFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const openAi = (baseUrl: string) => createProvider({ agentName: "fixture", provider: "openai", method: "openai-chat-completions",
  model: "fixture", baseUrl, apiKey: "fixture" });

test("an answer cut at the output limit continues in a new request and the run reports the whole text", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ content: "first half, " }, "length"), openAiDone] },
    { frames: [openAiFrame({ content: "second half" }, "stop"), openAiDone] },
  ]);
  const agent = createAgent({ provider: openAi(fixture.url), registry: createTestToolRegistry() });
  try {
    const result = await agent.run("write a long answer");
    assert.equal(result.status, "completed");
    assert.equal(result.status === "completed" ? result.text : "", "first half, second half");
    assert.equal(fixture.requests.length, 2);
    const messages = (fixture.requests[1]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    assert.equal(messages.at(-2)?.role, "assistant");
    assert.equal(messages.at(-2)?.content, "first half, ");
    assert.equal(messages.at(-1)?.role, "user");
    assert.match(String(messages.at(-1)?.content), /cut off at the output token limit/);
  } finally { await agent.close(); await fixture.close(); }
});

test("a tool call cut at the output limit returns a recoverable argument error instead of failing the run", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "write_file", arguments: '{"files":[{"path":"a.txt","content":"par' } }] }, "length"), openAiDone] },
    { frames: [openAiFrame({ content: "will split it" }, "stop"), openAiDone] },
  ]);
  const agent = createAgent({ provider: openAi(fixture.url), registry: createTestToolRegistry(), autoApprove: true });
  try {
    const result = await agent.run("write a big file");
    assert.equal(result.status, "completed");
    const tool = agent.transcript.find((message) => message.role === "tool");
    assert.equal(tool?.role === "tool" ? tool.result.code : undefined, "invalid_arguments");
    assert.match(JSON.stringify(tool), /cut off at the output token limit/);
  } finally { await agent.close(); await fixture.close(); }
});

test("output reserve defaults to 32k, bounded by a declared context, and configured caps win", () => {
  assert.equal(effectiveOutputTokens({}), DEFAULT_OUTPUT_TOKENS);
  assert.equal(effectiveOutputTokens({ contextWindow: 1_048_576 }), DEFAULT_OUTPUT_TOKENS);
  assert.equal(effectiveOutputTokens({ contextWindow: 32768 }), 4096);
  assert.equal(effectiveOutputTokens({ contextWindow: 32768, maxOutputTokens: 8000 }), 8000);
  assert.equal(effectiveOutputTokens({ maxOutputTokens: 8000, request: { kind: "generic", maxOutputTokens: 2000 } }), 2000);
});

const anthropicOk = [
  anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
  anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
  anthropicFrame("content_block_stop", { index: 0 }),
  anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
  anthropicFrame("message_stop", {}),
];

test("Anthropic sends a 32k default max_tokens and lowers it to an older model's stated maximum", async () => {
  const fixture = await startMockProvider([
    { status: 400, body: { type: "error", error: { type: "invalid_request_error",
      message: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-old" } } },
    { frames: anthropicOk },
  ]);
  try {
    const provider = createProvider({ agentName: "fixture", provider: "anthropic", method: "anthropic-messages", model: "claude-old", baseUrl: fixture.url, apiKey: "fixture" });
    const turn = await provider.generate({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 5000 });
    assert.equal(turn.text, "ok");
    assert.deepEqual(fixture.requests.map((request) => (request.body as { max_tokens: number }).max_tokens), [32000, 8192]);
  } finally { await fixture.close(); }
});

test("a configured Anthropic cap is never silently lowered", async () => {
  const fixture = await startMockProvider([
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 50000 > 8192, which is the maximum" } } },
  ]);
  try {
    const provider = createProvider({ agentName: "fixture", provider: "anthropic", method: "anthropic-messages", model: "claude-old",
      baseUrl: fixture.url, apiKey: "fixture", maxOutputTokens: 50000 });
    await assert.rejects(provider.generate({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 5000 }));
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test("default compaction on Anthropic lowers its assumed summary cap to the model's stated maximum", async () => {
  const anthropicText = (text: string) => [
    anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ];
  const fixture = await startMockProvider([
    { frames: anthropicText(`first answer ${"x".repeat(4000)}`) },
    { frames: anthropicText("second answer") },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 16384 > 8192, which is the maximum allowed number of output tokens for claude-old" } } },
    { frames: anthropicText("the summary") },
  ]);
  const agent = createAgent({ provider: createProvider({ agentName: "fixture", provider: "anthropic", method: "anthropic-messages", model: "claude-old",
    baseUrl: fixture.url, apiKey: "fixture" }), registry: createTestToolRegistry() });
  try {
    assert.equal((await agent.run("hello")).status, "completed");
    assert.equal((await agent.run("again")).status, "completed");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.deepEqual(fixture.requests.slice(2).map((request) => (request.body as { max_tokens: number }).max_tokens), [16384, 8192]);
  } finally { await agent.close(); await fixture.close(); }
});

test("an explicitly configured compaction cap is never lowered, even when it equals the default", async () => {
  const fixture = await startMockProvider([
    { frames: [
      anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "first answer" } }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      anthropicFrame("message_stop", {}),
    ] },
    { frames: [
      anthropicFrame("message_start", { message: { id: "m2", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "second answer" } }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      anthropicFrame("message_stop", {}),
    ] },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 16384 > 8192, which is the maximum" } } },
  ]);
  const agent = createAgent({ provider: createProvider({ agentName: "fixture", provider: "anthropic", method: "anthropic-messages", model: "claude-old",
    baseUrl: fixture.url, apiKey: "fixture" }), registry: createTestToolRegistry() });
  try {
    assert.equal((await agent.run("hello")).status, "completed");
    assert.equal((await agent.run("again")).status, "completed");
    await assert.rejects(agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 16384 }));
    assert.equal(fixture.requests.length, 3);
  } finally { await agent.close(); await fixture.close(); }
});
