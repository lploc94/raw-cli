import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/client.js";
import type { ProviderName, ProviderProfile } from "../src/llm/types.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { BUILTIN_TOOL_DEFINITIONS } from "../src/tools/registry.js";

const profile = (provider: ProviderName, baseUrl: string): ProviderProfile => ({ name: provider, provider, method: provider === "anthropic" ? "anthropic-messages" : provider === "google" ? "google-generate-content" : "openai-chat-completions", model: "fixture-model", baseUrl, apiKey: "fixture-key", maxOutputTokens: 128 });
const user = [{ role: "user" as const, content: "do it" }];

function openAiToolFrames() {
  return [
    openAiFrame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }),
    openAiFrame({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, "tool_calls"),
    openAiDone,
  ];
}

function anthropicToolFrames() {
  return [
    anthropicFrame("message_start", { message: { id: "msg", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call_1", name: "read_file", input: {} } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
    anthropicFrame("message_stop", {}),
  ];
}

function googleToolFrames() {
  return [googleFrame({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_1", name: "read_file", args: { path: "a" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } })];
}

for (const provider of ["openai", "llamacpp", "openrouter", "ollama", "anthropic", "google"] as const) {
  test(`${provider} SDK streams tool call and replays native tool result on next request`, async () => {
    const first = provider === "anthropic" ? anthropicToolFrames() : provider === "google" ? googleToolFrames() : openAiToolFrames();
    const second = provider === "anthropic"
      ? [
          anthropicFrame("message_start", { message: { id: "msg2", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }),
          anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "done" } }),
          anthropicFrame("content_block_stop", { index: 0 }),
          anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
          anthropicFrame("message_stop", {}),
        ]
      : provider === "google"
        ? [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] })]
        : [openAiFrame({ content: "done" }, "stop"), openAiDone];
    const fixture = await startMockProvider([{ frames: first }, { frames: second }]);
    try {
      const adapter = createProvider(profile(provider, fixture.url));
      const turn = await adapter.generate({ system: "tiny system", messages: user, tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 2000 });
      assert.equal(turn.toolCalls.length, 1);
      assert.deepEqual(turn.toolCalls[0]?.arguments, { path: "a" });
      assert.equal(turn.toolCalls[0]?.id, "call_1");
      const next = await adapter.generate({ system: "tiny system", messages: [
        ...user,
        { role: "assistant", text: turn.text, toolCalls: turn.toolCalls, opaque: turn.opaque },
        { role: "tool", callId: "call_1", name: "read_file", result: { isError: false, content: [{ type: "text", text: "file content" }] } },
      ], tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 2000 });
      assert.equal(next.text, "done");
      assert.equal(fixture.requests.length, 2);
      const body = fixture.requests[0]?.body as Record<string, unknown>;
      if (provider === "google") assert.match(fixture.requests[0]?.url ?? "", /fixture-model/);
      else assert.equal(body.model, "fixture-model");
      assert.match(JSON.stringify(body), /tiny system/);
      assert.match(JSON.stringify(body), /read_file/);
      assert.match(JSON.stringify(body), /128/);
      if (provider === "openai") assert.equal(body.max_completion_tokens, 128);
      if (provider === "ollama" || provider === "llamacpp" || provider === "openrouter") assert.equal(body.max_tokens, 128);
      const replay = JSON.stringify(fixture.requests[1]?.body);
      assert.match(replay, /call_1|read_file/);
      assert.match(replay, /file content/);
      if (provider === "anthropic") assert.match(fixture.requests[0]?.url ?? "", /\/v1\/messages/);
      else if (provider === "google") assert.match(fixture.requests[0]?.url ?? "", /streamGenerateContent/);
      else assert.match(fixture.requests[0]?.url ?? "", /\/chat\/completions/);
    } finally { await fixture.close(); }
  });
}
