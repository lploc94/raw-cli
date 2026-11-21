import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { createProvider } from "../src/llm/client.js";
import type { ProviderName, ResolvedModelConfig } from "../src/llm/types.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { BUILTIN_TOOL_DEFINITIONS } from "../src/tools/registry.js";

const agent = (provider: ProviderName, baseUrl: string): ResolvedModelConfig => ({ agentName: provider, provider, method: provider === "anthropic" ? "anthropic-messages" : provider === "google" ? "google-generate-content" : "openai-chat-completions", model: "fixture-model", baseUrl, apiKey: "fixture-key", maxOutputTokens: 128 });
const user = [{ role: "user" as const, content: "do it" }];

function openAiToolFrames() {
  return [
    openAiFrame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":' } }] }),
    openAiFrame({ tool_calls: [{ index: 0, function: { arguments: '"a"}]}' } }] }, "tool_calls"),
    openAiDone,
  ];
}

function anthropicToolFrames() {
  return [
    anthropicFrame("message_start", { message: { id: "msg", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call_1", name: "read_file", input: {} } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"files":[{"path":"a"}]}' } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
    anthropicFrame("message_stop", {}),
  ];
}

function googleToolFrames() {
  return [googleFrame({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_1", name: "read_file", args: { files: [{ path: "a" }] } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } })];
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
      const adapter = createProvider(agent(provider, fixture.url));
      const turn = await adapter.generate({ system: "tiny system", messages: user, tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 2000 });
      assert.equal(turn.toolCalls.length, 1);
      assert.deepEqual(turn.toolCalls[0]?.arguments, { files: [{ path: "a" }] });
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

// Non-canonical whitespace and key order: JSON.stringify(JSON.parse(x)) !== x, so only a verbatim copy passes.
const WRITTEN_ARGUMENTS = '{"b": 2,  "a":1}';

for (const provider of ["openai", "llamacpp"] as const) {
  test(`${provider} Chat Completions replays tool-call arguments exactly as the model streamed them`, async () => {
    const fixture = await startMockProvider([
      { frames: [
        openAiFrame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: WRITTEN_ARGUMENTS.slice(0, 7) } }] }),
        openAiFrame({ tool_calls: [{ index: 0, function: { arguments: WRITTEN_ARGUMENTS.slice(7) } }] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
    ]);
    try {
      const adapter = createProvider(agent(provider, fixture.url));
      const turn = await adapter.generate({ system: "tiny", messages: user, tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 2000 });
      assert.deepEqual(turn.toolCalls[0]?.arguments, { b: 2, a: 1 }, "tools still run with the parsed arguments");
      assert.equal(turn.toolCalls[0]?.argumentError, undefined);
      await adapter.generate({ system: "tiny", messages: [...user,
        { role: "assistant", text: turn.text, toolCalls: turn.toolCalls, opaque: turn.opaque },
        { role: "tool", callId: "call_1", name: "read_file", result: { isError: false, content: [{ type: "text", text: "ok" }] } },
      ], tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 2000 });
      const messages = (fixture.requests[1]?.body as { messages: Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }> }).messages;
      assert.equal(messages.find((message) => message.role === "assistant")?.tool_calls?.[0]?.function.arguments, WRITTEN_ARGUMENTS,
        `the replayed arguments are the streamed string ${WRITTEN_ARGUMENTS}`);
    } finally { await fixture.close(); }
  });
}

test("Chat Completions replays the model's argument string after a session restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-verbatim-args-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const sessionId = store.createSession({ cwd: root, title: "verbatim" }).id;
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "probe", arguments: WRITTEN_ARGUMENTS } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "first" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "second" }, "stop"), openAiDone] },
  ]);
  const registry = createTestToolRegistry();
  registry.register({ name: "probe", description: "probe", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: `sum ${Number(args.a) + Number(args.b)}` }] }) });
  const open = () => createAgent({ cwd: root, provider: createProvider(agent("openai", fixture.url)), system: "tiny", autoApprove: true, registry,
    persistence: { store, sessionId, surface: "cli" } });
  const sentArguments = (index: number) => (fixture.requests[index]?.body as { messages: Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }> })
    .messages.find((message) => message.role === "assistant" && message.tool_calls)?.tool_calls?.[0]?.function.arguments;
  try {
    const first = open();
    try { assert.equal((await first.run("go")).text, "first"); } finally { await first.close(); }
    assert.match(JSON.stringify(fixture.requests[1]?.body), /sum 3/, "the tool ran with the parsed arguments");
    assert.equal(sentArguments(1), WRITTEN_ARGUMENTS, "the next request replays the streamed string");
    const resumed = open();
    try { assert.equal((await resumed.run("again")).text, "second"); } finally { await resumed.close(); }
    assert.equal(sentArguments(2), WRITTEN_ARGUMENTS, "a restart still replays the streamed string");
  } finally { store.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); }
});
