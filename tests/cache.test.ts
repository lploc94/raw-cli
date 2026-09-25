import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/client.js";
import { createAgent } from "../src/agent.js";
import type { ProviderName, ResolvedModelConfig } from "../src/llm/types.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessions/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const finalFrames = (provider: ProviderName) => provider === "anthropic" ? [
  anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }),
  anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
  anthropicFrame("content_block_stop", { index: 0 }),
  anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
  anthropicFrame("message_stop", {}),
] : provider === "google"
  ? [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })]
  : [openAiFrame({ content: "ok" }, "stop"), openAiDone];

const makeProfile = (provider: ProviderName, baseUrl: string, cache?: ResolvedModelConfig["cache"]): ResolvedModelConfig => ({
  agentName: provider, provider, method: provider === "anthropic" ? "anthropic-messages" : provider === "google" ? "google-generate-content" : "openai-chat-completions", model: "fixture", baseUrl, apiKey: "key", ...(cache ? { cache } : {}),
});

test("OpenAI stable key, Anthropic cache_control, Google implicit and generic absence reach real SDK wire", async () => {
  for (const provider of ["openai", "anthropic", "google", "llamacpp", "openrouter", "ollama"] as const) {
    const fixture = await startMockProvider([{ frames: finalFrames(provider) }, { frames: finalFrames(provider) }]);
    try {
      const adapter = createProvider(makeProfile(provider, fixture.url));
      const base = { system: "stable", tools: [], timeoutMs: 1000, cacheKey: "opaque-stable-key" };
      await adapter.generate({ ...base, messages: [{ role: "user", content: "first" }] });
      await adapter.generate({ ...base, messages: [{ role: "user", content: "first" }, { role: "assistant", text: "ok", toolCalls: [] }, { role: "user", content: "second" }] });
      assert.equal(fixture.requests.length, 2);
      const first = fixture.requests[0]?.body as Record<string, unknown>;
      const second = fixture.requests[1]?.body as Record<string, unknown>;
      if (provider === "openai") {
        assert.equal(first.prompt_cache_key, "opaque-stable-key");
        assert.equal(second.prompt_cache_key, "opaque-stable-key");
        assert.deepEqual((second.messages as unknown[]).slice(0, 2), (first.messages as unknown[]));
      } else if (provider === "anthropic") {
        assert.deepEqual(first.cache_control, { type: "ephemeral" });
        assert.deepEqual(second.cache_control, first.cache_control);
      } else {
        assert.equal(first.prompt_cache_key, undefined);
        assert.equal(first.cache_control, undefined);
        assert.equal(first.cache_prompt, undefined);
        assert.equal(second.prompt_cache_key, undefined);
      }
    } finally { await fixture.close(); }
  }
});

test("explicit cache settings are validated, no-hints suppresses metadata, and llama.cpp is opt-in", async () => {
  const fixture = await startMockProvider(Array.from({ length: 6 }, () => ({ frames: finalFrames("openai") })));
  try {
    const req = { system: "stable", messages: [{ role: "user" as const, content: "hello" }], tools: [], timeoutMs: 1000, cacheKey: "derived" };
    await createProvider({ ...makeProfile("openai", fixture.url, { mode: "auto", key: "user-key", retention: "24h" }), model: "gpt-4.1" }).generate(req);
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).prompt_cache_key, "user-key");
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).prompt_cache_retention, "24h");
    await createProvider(makeProfile("openai", fixture.url, { mode: "no-hints", key: "ignored" })).generate(req);
    assert.equal((fixture.requests[1]?.body as Record<string, unknown>).prompt_cache_key, undefined);
    await createProvider(makeProfile("anthropic", fixture.url, { mode: "no-hints" })).generate(req).catch(() => {}); // fixture dialect differs; request still captured
    assert.equal((fixture.requests[2]?.body as Record<string, unknown>).cache_control, undefined);
    await createProvider(makeProfile("llamacpp", fixture.url, { mode: "auto", backend: "llama.cpp" })).generate(req);
    assert.equal((fixture.requests[3]?.body as Record<string, unknown>).cache_prompt, true);
    await createProvider(makeProfile("llamacpp", fixture.url, { mode: "no-hints", backend: "llama.cpp" })).generate(req);
    assert.equal((fixture.requests[4]?.body as Record<string, unknown>).cache_prompt, undefined);
    await assert.rejects(createProvider(makeProfile("openai", fixture.url, { retention: "bogus" })).generate(req));
    await assert.rejects(createProvider({ ...makeProfile("openai", fixture.url, { retention: "24h" }), model: "gpt-4o" }).generate(req));
    await assert.rejects(createProvider(makeProfile("llamacpp", fixture.url, { retention: "24h" })).generate(req));
    assert.equal(fixture.requests.length, 5);
  } finally { await fixture.close(); }
});

test("OpenAI GPT-4.1 dated snapshot accepts 24h retention without changing the model", async () => {
  const fixture = await startMockProvider([{ frames: finalFrames("openai") }]);
  try {
    const model = "gpt-4.1-2025-04-14";
    await createProvider({ ...makeProfile("openai", fixture.url, { retention: "24h" }), model }).generate({
      system: "stable", messages: [{ role: "user", content: "hello" }], tools: [], timeoutMs: 1000,
    });
    assert.equal(fixture.requests.length, 1);
    const body = fixture.requests[0]?.body as Record<string, unknown>;
    assert.equal(body.model, model);
    assert.equal(body.prompt_cache_retention, "24h");
  } finally { await fixture.close(); }
});

test("OpenAI supported dated model families accept 24h without admitting unsupported families", async () => {
  const fixture = await startMockProvider([{ frames: finalFrames("openai") }]);
  try {
    const model = "gpt-5.2-2025-12-11";
    const req = { system: "stable", messages: [{ role: "user" as const, content: "hello" }], tools: [], timeoutMs: 1000 };
    await createProvider({ ...makeProfile("openai", fixture.url, { retention: "24h" }), model }).generate(req);
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).model, model);
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).prompt_cache_retention, "24h");
    await assert.rejects(createProvider({ ...makeProfile("openai", fixture.url, { retention: "24h" }), model: "gpt-4o-2024-11-20" }).generate(req));
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test("three SDK requests keep exact tool/result and system/schema prefix while appending a new turn", async () => {
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":"missing"}]}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "first answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "second answer" }, "stop"), openAiDone] },
  ]);
  try {
    const agent = createAgent({ provider: createProvider(makeProfile("openai", fixture.url)), cwd: process.cwd(), system: "stable", autoApprove: true });
    assert.equal((await agent.run("first")).status, "completed");
    const oldHistory = JSON.stringify(agent.transcript);
    agent.setMaxOutputBytes(16);
    assert.equal(JSON.stringify(agent.transcript), oldHistory);
    assert.equal((await agent.run("second", () => {})).status, "completed");
    assert.equal(fixture.requests.length, 3);
    const [a, b, c] = fixture.requests.map((item) => item.body as { messages: unknown[]; tools: unknown[]; prompt_cache_key: string });
    assert.deepEqual(a?.tools, b?.tools);
    assert.deepEqual(b?.tools, c?.tools);
    assert.deepEqual(a?.messages, b?.messages.slice(0, a!.messages.length));
    assert.deepEqual(b?.messages, c?.messages.slice(0, b!.messages.length));
    assert.equal(a?.prompt_cache_key, b?.prompt_cache_key);
    assert.equal(b?.prompt_cache_key, c?.prompt_cache_key);
    assert.ok(a?.prompt_cache_key && !a.prompt_cache_key.includes(process.cwd()) && !a.prompt_cache_key.includes("first"));
  } finally { await fixture.close(); }
});

test("tool generation change rotates generated OpenAI hint while explicit agent key remains literal", async () => {
  for (const explicit of [false, true]) {
    const fixture = await startMockProvider([{ frames: finalFrames("openai") }, { frames: finalFrames("openai") }]);
    const root = mkdtempSync(join(tmpdir(), "raw-cache-generation-"));
    const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
    const id = store.createSession({ cwd: root, title: "generation" }).id;
    const agent = makeProfile("openai", fixture.url, explicit ? { key: "literal-agent-key" } : undefined);
    const registry = (description: string) => {
      const tools = new ToolRegistry();
      tools.register({ name: "selected", description, inputSchema: { type: "object", properties: {} },
        async handler() { return { isError: false, content: [] }; } });
      return tools;
    };
    try {
      const first = createAgent({ provider: createProvider(agent), registry: registry("old"), cwd: root, system: "system",
        whitelist: ["selected"], persistence: { store, sessionId: id, surface: "cli" } });
      assert.equal((await first.run("one")).status, "completed");
      await first.close();
      const second = createAgent({ provider: createProvider(agent), registry: registry("new"), cwd: root, system: "system",
        whitelist: ["selected"], persistence: { store, sessionId: id, surface: "cli" } });
      assert.equal((await second.run("two")).status, "completed");
      await second.close();
      const [before, after] = fixture.requests.map((item) => item.body as {
        prompt_cache_key: string; messages: unknown[]; tools: Array<{ function: { description: string } }> });
      assert.deepEqual(after?.messages.slice(0, before?.messages.length), before?.messages);
      assert.equal(before?.tools[0]?.function.description, "old");
      assert.equal(after?.tools[0]?.function.description, "new");
      if (explicit) assert.deepEqual([before?.prompt_cache_key, after?.prompt_cache_key], ["literal-agent-key", "literal-agent-key"]);
      else assert.notEqual(before?.prompt_cache_key, after?.prompt_cache_key);
    } finally { store.close(); await fixture.close(); }
  }
});
