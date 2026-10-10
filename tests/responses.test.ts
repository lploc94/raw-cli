import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/client.js";
import { loadConfig } from "../src/config.js";
import { BUILTIN_TOOL_DEFINITIONS } from "../src/tools/registry.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { testConfig } from "./fixtures/config.js";
import { normalizeUsage } from "../src/llm/cache.js";

const event = (type: string, value: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 1, ...value })}\n\n`;
const response = (output: unknown[], usage = { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } }) => ({
  id: "resp_fixture", object: "response", status: "completed", model: "gpt-6-astra", output, usage,
});

test("Responses streams a function call, replays complete output items, and links its result", async () => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque-token", status: "completed" };
  const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"files":[{"path":"a"}]}', status: "completed" };
  const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
  const fixture = await startMockProvider([
    { frames: [event("response.output_item.done", { output_index: 0, item: reasoning }), event("response.output_item.done", { output_index: 1, item: call }),
      event("response.completed", { response: response([reasoning, call]) }), "data: [DONE]\n\n"] },
    { frames: [event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "msg_1", delta: "done", logprobs: [] }),
      event("response.completed", { response: response([message]) }), "data: [DONE]\n\n"] },
  ]);
  try {
    const adapter = createProvider({ agentName: "fixture", provider: "openai", method: "openai-responses", model: "gpt-6-astra",
      baseUrl: fixture.url, apiKey: "fixture", maxOutputTokens: 128 });
    const first = await adapter.generate({ system: "tiny", messages: [{ role: "user", content: "inspect" }],
      tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 1000, cacheKey: "stable" });
    assert.equal(first.toolCalls[0]?.id, "call_1");
    assert.deepEqual(first.toolCalls[0]?.arguments, { files: [{ path: "a" }] });
    assert.equal(first.text, "");
    const deltas: string[] = [];
    const second = await adapter.generate({ system: "tiny", messages: [
      { role: "user", content: "inspect" },
      { role: "assistant", text: first.text, toolCalls: first.toolCalls, opaque: first.opaque },
      { role: "tool", callId: "call_1", name: "read_file", result: { isError: false, content: [{ type: "text", text: "content" }] } },
    ], tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 1000, cacheKey: "stable", onTextDelta: (part) => deltas.push(part) });
    assert.equal(second.text, "done");
    assert.deepEqual(deltas, ["done"]);
    const firstBody = fixture.requests[0]?.body as Record<string, unknown>;
    const secondBody = fixture.requests[1]?.body as Record<string, unknown>;
    assert.match(fixture.requests[0]?.url ?? "", /\/responses/);
    assert.equal(firstBody.store, false);
    assert.equal(firstBody.prompt_cache_key, "stable");
    assert.equal(secondBody.prompt_cache_key, "stable");
    assert.deepEqual((secondBody.input as unknown[]).slice(0, 1), firstBody.input);
    assert.match(JSON.stringify(secondBody.input), /opaque-token/);
    assert.match(JSON.stringify(secondBody.input), /function_call_output.*call_1.*content/);
    assert.equal((first.usage as { input_tokens: number }).input_tokens, 20);
  } finally { await fixture.close(); }
});

test("DeepSeek reasoning_content is replayed from ordinary and tool-call assistant turns", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ reasoning_content: "reason one", content: "first" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ reasoning_content: "reason two", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":"a"}]}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  try {
    const adapter = createProvider({ agentName: "deepseek", provider: "deepseek", method: "openai-chat-completions",
      model: "deepseek-flash", baseUrl: fixture.url, apiKey: "fixture" });
    const base = { system: "tiny", tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 1000 };
    const one = await adapter.generate({ ...base, messages: [{ role: "user", content: "first" }] });
    const two = await adapter.generate({ ...base, messages: [{ role: "user", content: "first" },
      { role: "assistant", text: one.text, toolCalls: [], opaque: one.opaque }, { role: "user", content: "second" }] });
    await adapter.generate({ ...base, messages: [{ role: "user", content: "first" },
      { role: "assistant", text: one.text, toolCalls: [], opaque: one.opaque }, { role: "user", content: "second" },
      { role: "assistant", text: two.text, toolCalls: two.toolCalls, opaque: two.opaque },
      { role: "tool", callId: "call_1", name: "read_file", result: { isError: false, content: [{ type: "text", text: "ok" }] } }] });
    assert.match(JSON.stringify(fixture.requests[1]?.body), /reason one/);
    assert.match(JSON.stringify(fixture.requests[2]?.body), /reason two/);
  } finally { await fixture.close(); }
});

test("agent request options validate before connection and do not allow arbitrary fields", async () => {
  const configPath = testConfig("openai", "gpt-6-astra", "http://127.0.0.1:1");
  const fs = await import("node:fs/promises");
  const doc = JSON.parse(await fs.readFile(configPath, "utf8"));
  doc.models.fixture.method = "openai-responses";
  doc.models.fixture.max_output_tokens = 1000;
  doc.agents.fixture.request = { service_tier: "fast", reasoning_effort: "high", max_output_tokens: 400 };
  await fs.writeFile(configPath, JSON.stringify(doc));
  const runtime = await loadConfig({ configPath, env: { OPENAI_API_KEY: "fixture" }, requireModel: true });
  assert.equal(runtime.modelConfig?.method, "openai-responses");
  assert.equal(runtime.modelConfig?.request?.maxOutputTokens, 400);
  doc.agents.fixture.request.model = "other";
  await fs.writeFile(configPath, JSON.stringify(doc));
  await assert.rejects(loadConfig({ configPath, env: { OPENAI_API_KEY: "fixture" }, requireModel: true }), /unknown|model/);
});

test("Responses usage reads cached input; output-limit streams become truncated turns, other incomplete streams fail", async () => {
  assert.deepEqual(normalizeUsage("openai-responses", { input_tokens: 100, output_tokens: 20,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 } }), {
    inputTokensTotal: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 5, cacheReadRatio: 0.6,
  });
  const incomplete = (reason: string) => ({ frames: [event("response.incomplete", { response: {
    id: "r", object: "response", status: "incomplete", usage: { input_tokens: 4, output_tokens: 2 },
    output: [{ type: "message", id: "m", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "half", annotations: [] }] }],
    incomplete_details: { reason },
  } }), "data: [DONE]\n\n"] });
  const fixture = await startMockProvider([incomplete("max_output_tokens"), incomplete("content_filter")]);
  try {
    const adapter = createProvider({ agentName: "fixture", provider: "openai", method: "openai-responses",
      model: "gpt-6-astra", baseUrl: fixture.url, apiKey: "fixture" });
    const observed: unknown[] = [];
    const turn = await adapter.generate({ system: "tiny", messages: [{ role: "user", content: "hello" }], tools: [], timeoutMs: 1000,
      onUsage: (raw) => observed.push(raw) });
    assert.equal(turn.truncated, true);
    assert.equal(turn.text, "half");
    assert.equal(turn.opaque, undefined);
    await assert.rejects(adapter.generate({ system: "tiny", messages: [{ role: "user", content: "hello" }], tools: [], timeoutMs: 1000 }), /incomplete: content_filter/);
    assert.equal(fixture.requests.length, 2);
    assert.equal((observed[0] as { output_tokens: number }).output_tokens, 2);
  } finally { await fixture.close(); }
});

test("Responses abort cancels the stream and makes no retry", async () => {
  const fixture = await startMockProvider([{ hold: true }]);
  try {
    const adapter = createProvider({ agentName: "fixture", provider: "openai", method: "openai-responses",
      model: "gpt-6-astra", baseUrl: fixture.url, apiKey: "fixture" });
    const controller = new AbortController();
    const pending = adapter.generate({ system: "tiny", messages: [{ role: "user", content: "hello" }], tools: [],
      timeoutMs: 1000, signal: controller.signal });
    for (let i = 0; i < 50 && !fixture.requests.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});
