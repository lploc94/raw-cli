import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage, ProviderAdapter, ProviderRequest, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

test("provider and tool changes replay old calls as text while canonical data and later prefix stay stable", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-replay-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "switch provider" }).id;
  const original = createTestToolRegistry();
  original.register({ name: "old_tool", description: "Original", inputSchema: { type: "object" },
    async handler() { return { isError: false, content: [
      { type: "text", text: "original result" },
      { type: "image", mimeType: "image/png", data: "QUJDRA==", byteSize: 4 },
    ] }; } });
  let turn = 0;
  const originalProvider: ProviderAdapter = {
    modelConfig: { agentName: "old", provider: "ollama", method: "openai-chat-completions", model: "old-model", vision: true },
    generate: async (): Promise<ProviderTurn> => ++turn === 1
      ? { text: "calling", toolCalls: [{ id: "old-call", name: "old_tool", arguments: {} }],
        finishReason: "tool_calls", opaque: { reasoning_content: "foreign-signature" } }
      : { text: "original answer", toolCalls: [], finishReason: "stop" },
  };
  const first = createAgent({ cwd: root, provider: originalProvider, registry: original, whitelist: ["old_tool"],
    system: "old system", persistence: { store, sessionId: id, surface: "cli" } });
  try {
    assert.equal((await first.run("start")).status, "completed");
    const canonical = structuredClone(first.transcript);
    await first.close();
    const requests: Array<{ messages: readonly ModelMessage[]; cacheKey: string | undefined; system: string }> = [];
    const replacementConfig: ResolvedModelConfig = { agentName: "new", provider: "anthropic", method: "anthropic-messages", model: "new-model", vision: false };
    const replacement: ProviderAdapter = { modelConfig: replacementConfig, generate: async (request) => {
      requests.push({ messages: structuredClone(request.messages), cacheKey: request.cacheKey, system: request.system });
      return { text: "continued", toolCalls: [], finishReason: "stop" };
    } };
    const second = createAgent({ cwd: root, provider: replacement, registry: createTestToolRegistry(), whitelist: [],
      system: "new system", persistence: { store, sessionId: id, surface: "cli" } });
    const changedRevision = second.contextRevision;
    try {
      assert.deepEqual(second.transcript, canonical);
      assert.equal((await second.run("continue" )).status, "completed");
      const wire = JSON.stringify(requests[0]?.messages);
      assert.match(wire, /old_tool|original result|Historical/);
      assert.match(wire, /image\/png|image/);
      assert.doesNotMatch(wire, /foreign-signature|QUJDRA==/);
      assert.ok(requests[0]?.messages.every((message) => message.role !== "tool"));
    } finally { await second.close(); }
    const third = createAgent({ cwd: root, provider: replacement, registry: createTestToolRegistry(), whitelist: [],
      system: "new system", persistence: { store, sessionId: id, surface: "cli" } });
    try {
      assert.equal(third.contextRevision, changedRevision);
      assert.equal((await third.run("again")).status, "completed");
      assert.equal(requests[0]!.cacheKey, requests[1]!.cacheKey);
      assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages);
    } finally { await third.close(); }

    const historical = requests[0]!.messages as ModelMessage[];
    const cases: Array<{ method: ResolvedModelConfig["method"]; provider: string; frames: string[] }> = [
      { method: "openai-chat-completions", provider: "openai", frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] },
      { method: "openai-responses", provider: "openai", frames: [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
        response: { id: "r", object: "response", status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: null } })}\n\n`, "data: [DONE]\n\n"] },
      { method: "anthropic-messages", provider: "anthropic", frames: [
        anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
        anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
        anthropicFrame("content_block_stop", { index: 0 }),
        anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
        anthropicFrame("message_stop", {}),
      ] },
      { method: "google-generate-content", provider: "google", frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })] },
    ];
    for (const item of cases) {
      const mock = await startMockProvider([{ frames: item.frames }]);
      try {
        const result = await createProvider({ agentName: "new", provider: item.provider, method: item.method,
          model: "fixture", baseUrl: mock.url, apiKey: "fixture", maxOutputTokens: 128 }).generate({
          system: "new system", messages: historical, tools: [], timeoutMs: 2000 });
        assert.equal(result.text, "ok");
        const body = JSON.stringify(mock.requests[0]?.body);
        assert.match(body, /old_tool|original result/);
        assert.doesNotMatch(body, /foreign-signature|QUJDRA==/);
      } finally { await mock.close(); }
    }
  } finally { await first.close(); store.close(); }
});
