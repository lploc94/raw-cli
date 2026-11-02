import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage, ProviderName, ResolvedModelConfig, UserInput } from "../src/llm/types.js";
import { makePng } from "./fixtures/images.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import type { ToolResult } from "../src/tools/types.js";
import { nativeToolContent } from "../src/llm/content.js";

const agent = (provider: ProviderName, baseUrl: string): ResolvedModelConfig => ({ agentName: provider, provider, method: provider === "anthropic" ? "anthropic-messages" : provider === "google" ? "google-generate-content" : "openai-chat-completions", model: "fixture-model", baseUrl, apiKey: "fixture-key", maxOutputTokens: 128 });
const request = { system: "sys", messages: [{ role: "user" as const, content: "hello" }], tools: [], timeoutMs: 1000 };

test("OpenAI assembles interleaved fragmented calls, Unicode, usage and finish reason", async () => {
  const fixture = await startMockProvider([{ frames: [
    openAiFrame({ content: "hé", tool_calls: [{ index: 1, id: "two", type: "function", function: { name: "bash", arguments: '{"command":' } }] }),
    openAiFrame({ content: "😀", tool_calls: [{ index: 0, id: "one", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":' } }, { index: 1, function: { arguments: '"pwd"}' } }] }),
    openAiFrame({ tool_calls: [{ index: 0, function: { arguments: '"a"}]}' } }] }, "tool_calls"),
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`,
    openAiDone,
  ] }]);
  try {
    const deltas: string[] = [];
    const result = await createProvider(agent("openai", fixture.url)).generate({ ...request, onTextDelta: (delta) => deltas.push(delta) });
    assert.deepEqual(deltas, ["hé", "😀"]);
    assert.equal(result.text, "hé😀");
    assert.deepEqual(result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [["one", "read_file", { files: [{ path: "a" }] }], ["two", "bash", { command: "pwd" }]]);
    assert.equal(result.finishReason, "tool_calls");
    assert.equal((result.usage as { prompt_tokens: number }).prompt_tokens, 10);
  } finally { await fixture.close(); }
});

test("Anthropic thinking/signature and Google thought signatures survive replay without display", async () => {
  for (const provider of ["anthropic", "google"] as const) {
    const first = provider === "anthropic" ? [
      anthropicFrame("message_start", { message: { id: "msg", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      anthropicFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      anthropicFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "secret" } }),
      anthropicFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signed" } }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("content_block_start", { index: 1, content_block: { type: "tool_use", id: "c", name: "bash", input: {} } }),
      anthropicFrame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } }),
      anthropicFrame("content_block_stop", { index: 1 }),
      anthropicFrame("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
      anthropicFrame("message_stop", {}),
    ] : [googleFrame({ candidates: [{ content: { role: "model", parts: [
      { text: "secret", thought: true, thoughtSignature: "signed" },
      { functionCall: { id: "c", name: "bash", args: { command: "pwd" } }, thoughtSignature: "signed-call" },
    ] }, finishReason: "STOP" }] })];
    const second = provider === "anthropic" ? [
      anthropicFrame("message_start", { message: { id: "m2", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      anthropicFrame("message_stop", {}),
    ] : [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })];
    const fixture = await startMockProvider([{ frames: first }, { frames: second }]);
    try {
      const adapter = createProvider(agent(provider, fixture.url));
      const deltas: string[] = [];
      const turn = await adapter.generate({ ...request, onTextDelta: (delta) => deltas.push(delta) });
      assert.deepEqual(deltas, []);
      assert.equal(turn.text, "");
      assert.equal(turn.toolCalls[0]?.id, "c");
      await adapter.generate({ ...request, messages: [...request.messages,
        { role: "assistant", text: turn.text, toolCalls: turn.toolCalls, opaque: turn.opaque },
        { role: "tool", callId: "c", name: "bash", result: { isError: false, content: [{ type: "text", text: "ok" }] } },
      ] });
      assert.match(JSON.stringify(fixture.requests[1]?.body), /signed/);
      const replayMessages = (fixture.requests[1]?.body as { messages?: { role: string; content: unknown }[]; contents?: { role: string; parts: unknown }[] });
      const userMessages = replayMessages.messages?.filter((message) => message.role === "user" && typeof message.content === "string") ?? [];
      assert.ok(userMessages.every((message) => !String(message.content).includes("secret")));
    } finally { await fixture.close(); }
  }
});

test("client errors, incomplete stream and cancellation are terminal with no retries", async () => {
  // Transient 408/409/429/5xx failures are retried; tests/provider-retry.test.ts covers them.
  for (const status of [401, 403, 404]) {
    const fixture = await startMockProvider([{ status, body: { error: { message: "failed", type: "fixture" } } }]);
    try {
      await assert.rejects(createProvider(agent("openai", fixture.url)).generate(request));
      assert.equal(fixture.requests.length, 1);
    } finally { await fixture.close(); }
  }
  const incomplete = await startMockProvider([{ frames: [openAiFrame({ content: "partial" })] }]);
  try { await assert.rejects(createProvider(agent("openai", incomplete.url)).generate(request)); assert.equal(incomplete.requests.length, 1); }
  finally { await incomplete.close(); }
  const malformed = await startMockProvider([{ frames: ["data: {broken-json}\n\n", openAiDone] }]);
  try { await assert.rejects(createProvider(agent("openai", malformed.url)).generate(request)); assert.equal(malformed.requests.length, 1); }
  finally { await malformed.close(); }
  const refusal = await startMockProvider([{ frames: [openAiFrame({ refusal: "no" }, "stop"), openAiDone] }]);
  try { await assert.rejects(createProvider(agent("openai", refusal.url)).generate(request), /no/); assert.equal(refusal.requests.length, 1); }
  finally { await refusal.close(); }
  for (const method of ["openai-chat-completions", "openai-responses", "anthropic-messages", "google-generate-content"] as const) {
    const provider: ProviderName = method === "anthropic-messages" ? "anthropic" : method === "google-generate-content" ? "google" : "openai";
    const hanging = await startMockProvider([{ hold: true }]);
    try {
      await assert.rejects(
        createProvider({ ...agent(provider, hanging.url), method }).generate({ ...request, timeoutMs: 80 }),
        (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "timeout" && /timed out/.test(err.message),
      );
      assert.equal(hanging.requests.length, 1);
    } finally { await hanging.close(); }
  }
  const abortFixture = await startMockProvider([{ hold: true }]);
  try {
    const controller = new AbortController();
    const run = createProvider(agent("openai", abortFixture.url)).generate({ ...request, timeoutMs: 1000, signal: controller.signal });
    for (let i = 0; i < 50 && !abortFixture.requests.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(run, /aborted/);
    assert.equal(abortFixture.requests.length, 1);
  } finally { await abortFixture.close(); }
});

test("native text, JSON, PNG/JPEG mapping preserves linkage and rejects unsupported media", async () => {
  const image: ToolResult = { isError: false, content: [
    { type: "text", text: "caption" },
    { type: "json", value: { count: 2 } },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    { type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" },
  ] };
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const frames = provider === "anthropic" ? [
      anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "seen" } }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      anthropicFrame("message_stop", {}),
    ] : provider === "google" ? [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "seen" }] }, finishReason: "STOP" }] })] : [openAiFrame({ content: "seen" }, "stop"), openAiDone];
    const fixture = await startMockProvider([{ frames }]);
    try {
      const adapter = createProvider(agent(provider, fixture.url));
      await adapter.generate({ ...request, messages: [
        ...request.messages,
        { role: "assistant", text: "", toolCalls: [{ id: "c", name: "view", arguments: {} }] },
        { role: "tool", callId: "c", name: "view", result: image },
      ] });
      const body = JSON.stringify(fixture.requests[0]?.body);
      assert.match(body, /c/);
      assert.match(body, /iVBORw0KGgo=/);
      assert.match(body, /\/9j\/2Q==/);
      assert.match(body, /caption/);
      assert.match(body, /count/);
      assert.match(body, provider === "openai" ? /image_url/ : provider === "anthropic" ? /"image"/ : /inlineData/);
      await assert.rejects(adapter.generate({ ...request, messages: [...request.messages, { role: "tool", callId: "c", name: "view", result: { isError: false, content: [{ type: "image", mimeType: "image/gif", data: "AA==" }] } as unknown as ToolResult }] }));
      assert.equal(fixture.requests.length, 1);
    } finally { await fixture.close(); }
  }
});

test("OpenAI emits every tool result before user image attachments", async () => {
  const fixture = await startMockProvider([{ frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] }]);
  try {
    await createProvider(agent("openai", fixture.url)).generate({ ...request, messages: [
      ...request.messages,
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "view", arguments: {} }, { id: "b", name: "read_file", arguments: {} }] },
      { role: "tool", callId: "a", name: "view", result: { isError: false, content: [{ type: "image", mimeType: "image/png", data: "AA==" }] } },
      { role: "tool", callId: "b", name: "read_file", result: { isError: false, content: [{ type: "text", text: "x" }] } },
    ] });
    const messages = (fixture.requests[0]?.body as { messages: { role: string; tool_call_id?: string }[] }).messages;
    assert.deepEqual(messages.slice(-4).map((message) => [message.role, message.tool_call_id]), [["assistant", undefined], ["tool", "a"], ["tool", "b"], ["user", undefined]]);
  } finally { await fixture.close(); }
});

test("Google groups parallel responses, echoes provider IDs and accepts omitted arguments", async () => {
  const fixture = await startMockProvider([{ frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [
    { functionCall: { id: "raw-google-from-provider", name: "noop" } },
    { functionCall: { id: "b", name: "noop", args: {} } },
  ] }, finishReason: "STOP" }] })] }, { frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })] }]);
  try {
    const adapter = createProvider(agent("google", fixture.url));
    const first = await adapter.generate(request);
    assert.deepEqual(first.toolCalls.map((call) => call.arguments), [{}, {}]);
    await adapter.generate({ ...request, messages: [...request.messages,
      { role: "assistant", text: "", toolCalls: first.toolCalls, opaque: first.opaque },
      ...first.toolCalls.map((call) => ({ role: "tool" as const, callId: call.id, name: call.name, result: { isError: false, content: [{ type: "text" as const, text: "ok" }] } })),
    ] });
    const contents = (fixture.requests[1]?.body as { contents: { role: string; parts: { functionResponse?: { id?: string } }[] }[] }).contents;
    assert.equal(contents.at(-1)?.parts.length, 2);
    assert.deepEqual(contents.at(-1)?.parts.map((part) => part.functionResponse?.id), ["raw-google-from-provider", "b"]);
  } finally { await fixture.close(); }
});

test("Google synthetic ID state does not shadow a later real ID with the same spelling", async () => {
  const response = (parts: unknown[]) => [googleFrame({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] })];
  const fixture = await startMockProvider([
    { frames: response([{ functionCall: { name: "noop", args: {} } }]) },
    { frames: response([{ functionCall: { id: "raw-google-0", name: "noop", args: {} } }]) },
    { frames: response([{ text: "done" }]) },
  ]);
  try {
    const adapter = createProvider(agent("google", fixture.url));
    const messages: Array<import("../src/llm/types.js").ModelMessage> = [...request.messages];
    for (let i = 0; i < 2; i++) {
      const turn = await adapter.generate({ ...request, messages });
      assert.equal(turn.toolCalls.length, 1);
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, opaque: turn.opaque });
      const call = turn.toolCalls[0]!;
      messages.push({ role: "tool", callId: call.id, name: call.name, result: { isError: false, content: [{ type: "text", text: "ok" }] } });
    }
    await adapter.generate({ ...request, messages });
    const contents = (fixture.requests[2]?.body as { contents: { parts: { functionResponse?: { id?: string } }[] }[] }).contents;
    assert.equal(contents.at(-1)?.parts[0]?.functionResponse?.id, "raw-google-0");
  } finally { await fixture.close(); }
});

test("OpenRouter replays opaque reasoning details without showing them", async () => {
  const signed = { type: "reasoning.encrypted", data: "signed", format: "google-gemini-v1", index: 0 };
  const fixture = await startMockProvider([{ frames: [
    openAiFrame({ reasoning_details: [signed], tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "bash", arguments: "{}" } }] }, "tool_calls"), openAiDone,
  ] }, { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] }]);
  try {
    const adapter = createProvider(agent("openrouter", fixture.url));
    const deltas: string[] = [];
    const first = await adapter.generate({ ...request, onTextDelta: (delta) => deltas.push(delta) });
    assert.deepEqual(deltas, []);
    await adapter.generate({ ...request, messages: [...request.messages,
      { role: "assistant", text: first.text, toolCalls: first.toolCalls, opaque: first.opaque },
      { role: "tool", callId: "c", name: "bash", result: { isError: false, content: [{ type: "text", text: "ok" }] } },
    ] });
    assert.deepEqual(((fixture.requests[1]?.body as { messages: Record<string, unknown>[] }).messages.find((message) => message.role === "assistant")?.reasoning_details), [signed]);
  } finally { await fixture.close(); }
});

test("duplicate call IDs and malformed Anthropic block lifecycle are terminal", async () => {
  const openai = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [
    { index: 0, id: "same", type: "function", function: { name: "bash", arguments: "{}" } },
    { index: 1, id: "same", type: "function", function: { name: "bash", arguments: "{}" } },
  ] }, "tool_calls"), openAiDone] }]);
  try { await assert.rejects(createProvider(agent("openai", openai.url)).generate(request)); }
  finally { await openai.close(); }
  const anthropic = await startMockProvider([{ frames: [
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "a", name: "bash", input: {} } }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ] }]);
  try { await assert.rejects(createProvider(agent("anthropic", anthropic.url)).generate(request)); }
  finally { await anthropic.close(); }
  const google = await startMockProvider([{ frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [
    { functionCall: { id: "same", name: "bash", args: {} } }, { functionCall: { id: "same", name: "bash", args: {} } },
  ] }, finishReason: "STOP" }] })] }]);
  try { await assert.rejects(createProvider(agent("google", google.url)).generate(request)); }
  finally { await google.close(); }
});

test("early error closes live provider response and large valid image passes validation", async () => {
  const fixture = await startMockProvider([{ frames: [googleFrame({ promptFeedback: { blockReason: "SAFETY" } })], keepOpen: true }]);
  try {
    await assert.rejects(createProvider(agent("google", fixture.url)).generate(request));
    for (let i = 0; i < 40 && fixture.closed === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fixture.closed, 1);
  } finally { await fixture.close(); }
  const data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
  assert.equal(nativeToolContent({ isError: false, content: [{ type: "image", mimeType: "image/png", data }] }).images.length, 1);
});

test("linked malformed arguments remain an error call for matching tool-result continuation", async () => {
  const fixture = await startMockProvider([{ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "bash", arguments: "{oops" } }] }, "tool_calls"), openAiDone] }]);
  try {
    const result = await createProvider(agent("openai", fixture.url)).generate(request);
    assert.equal(result.toolCalls[0]?.id, "a");
    assert.ok(result.toolCalls[0]?.argumentError);
  } finally { await fixture.close(); }
});

// docs/providers.md: a user message after tool results joins their user turn for Anthropic and Google.
{
  const anthropicOk = [
    anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ];
  const googleOk = [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })];
  const responsesOk = [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
    response: { id: "r", object: "response", status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: null } })}\n\n`, "data: [DONE]\n\n"];
  const png = makePng().toString("base64");
  const withImage: UserInput = [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", data: png }];
  const result = (text: string): ToolResult => ({ isError: false, content: [{ type: "text", text }] });
  /** assistant(tool_use a, b) → tool a → tool b → the user message `last`. */
  const afterTools = (last: UserInput): ModelMessage[] => [
    { role: "user", content: "hello" },
    { role: "assistant", text: "", toolCalls: [{ id: "a", name: "noop", arguments: {} }, { id: "b", name: "noop", arguments: {} }] },
    { role: "tool", callId: "a", name: "noop", result: result("A") },
    { role: "tool", callId: "b", name: "noop", result: result("B") },
    { role: "user", content: last },
  ];
  async function sent(method: ResolvedModelConfig["method"], frames: string[], messages: ModelMessage[]) {
    const provider = method === "anthropic-messages" ? "anthropic" : method === "google-generate-content" ? "google" : "openai";
    const mock = await startMockProvider([{ frames }]);
    try {
      const turn = await createProvider({ ...agent(provider, mock.url), method }).generate({ ...request, messages });
      assert.equal(turn.text, "ok");
      return mock.requests[0]!.body as Record<string, unknown>;
    } finally { await mock.close(); }
  }
  const anthropicMessages = async (messages: ModelMessage[]) => (await sent("anthropic-messages", anthropicOk, messages)).messages;
  const googleContents = async (messages: ModelMessage[]) => (await sent("google-generate-content", googleOk, messages)).contents;
  const anthropicResult = (id: string, text: string) => ({ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text }] });
  const googleResult = (id: string, text: string) => ({ functionResponse: { name: "noop", id, response: { output: text } } });

  test("Anthropic: the tool results and the user message after them are one user message", async () => {
    const turn = (await anthropicMessages(afterTools("x"))) as Array<{ role: string; content: unknown }>;
    assert.deepEqual(turn.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(turn[0]!.content, "hello");
    assert.deepEqual(turn[2]!.content, [anthropicResult("a", "A"), anthropicResult("b", "B"), { type: "text", text: "x" }]);
    const image = (await anthropicMessages(afterTools(withImage))) as Array<{ role: string; content: unknown }>;
    assert.deepEqual(image[2]!.content, [anthropicResult("a", "A"), anthropicResult("b", "B"), { type: "text", text: "x" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]);
  });

  test("Google: the tool results and the user message after them are one user content", async () => {
    const turn = (await googleContents(afterTools("x"))) as Array<{ role: string; parts: unknown[] }>;
    assert.deepEqual(turn.map((content) => content.role), ["user", "model", "user"]);
    assert.deepEqual(turn[0]!.parts, [{ text: "hello" }]);
    assert.deepEqual(turn[2]!.parts, [googleResult("a", "A"), googleResult("b", "B"), { text: "x" }]);
    const image = (await googleContents(afterTools(withImage))) as Array<{ role: string; parts: unknown[] }>;
    assert.deepEqual(image[2]!.parts, [googleResult("a", "A"), googleResult("b", "B"), { text: "x" }, { inlineData: { mimeType: "image/png", data: png } }]);
  });

  test("two user messages in a row are one message with both parts in order; a message after an answer stays apart", async () => {
    const twice: ModelMessage[] = [{ role: "user", content: "hello" }, { role: "user", content: withImage }];
    assert.deepEqual(await anthropicMessages(twice), [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "x" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }]);
    assert.deepEqual(await googleContents(twice), [{ role: "user", parts: [{ text: "hello" }, { text: "x" }, { inlineData: { mimeType: "image/png", data: png } }] }]);
    const apart: ModelMessage[] = [{ role: "user", content: "hello" }, { role: "assistant", text: "hi", toolCalls: [] }, { role: "user", content: "again" }];
    assert.deepEqual(await anthropicMessages(apart), [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "again" }]);
    assert.deepEqual(await googleContents(apart), [{ role: "user", parts: [{ text: "hello" }] }, { role: "model", parts: [{ text: "hi" }] },
      { role: "user", parts: [{ text: "again" }] }]);
  });

  test("OpenAI chat and Responses keep the tool results and the user message after them apart", async () => {
    const chat = (await sent("openai-chat-completions", [openAiFrame({ content: "ok" }, "stop"), openAiDone], afterTools("x"))).messages as Array<{ role: string }>;
    assert.deepEqual(chat.map((message) => message.role), ["system", "user", "assistant", "tool", "tool", "user"]);
    const responses = (await sent("openai-responses", responsesOk, afterTools("x"))).input as Array<{ type?: string; role?: string }>;
    assert.deepEqual(responses.map((item) => item.role ?? item.type), ["user", "function_call", "function_call", "function_call_output", "function_call_output", "user"]);
  });
}
