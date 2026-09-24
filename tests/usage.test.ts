import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUsage, summarizeUsage } from "../src/llm/cache.js";
import { createAgent } from "../src/agent.js";

test("OpenAI and Google totals include cached reads; Anthropic adds disjoint categories once", () => {
  assert.deepEqual(normalizeUsage("openai-chat-completions", { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 } }), {
    inputTokensTotal: 100, outputTokens: 9, cacheReadTokens: 70, cacheWriteTokens: 20, cacheReadRatio: 0.7,
  });
  assert.deepEqual(normalizeUsage("anthropic-messages", { input_tokens: 10, cache_creation_input_tokens: 30, cache_read_input_tokens: 60,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 }, output_tokens: 8 }), {
    inputTokensTotal: 100, outputTokens: 8, cacheReadTokens: 60, cacheWriteTokens: 30, cacheReadRatio: 0.6,
  });
  assert.deepEqual(normalizeUsage("google-generate-content", { promptTokenCount: 80, candidatesTokenCount: 7, cachedContentTokenCount: 50 }), {
    inputTokensTotal: 80, outputTokens: 7, cacheReadTokens: 50, cacheReadRatio: 0.625,
  });
  assert.deepEqual(normalizeUsage("google-generate-content", { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 500, totalTokenCount: 620 }), {
    inputTokensTotal: 100, outputTokens: 520,
  });
});

test("absent metrics remain unknown; explicit zeros and mixed-known coverage are honest", () => {
  assert.deepEqual(normalizeUsage("openai-chat-completions", { prompt_tokens: 40, completion_tokens: 2 }), {
    inputTokensTotal: 40, outputTokens: 2,
  });
  assert.deepEqual(normalizeUsage("anthropic-messages", { input_tokens: 5, output_tokens: 2 }), { outputTokens: 2 });
  assert.deepEqual(normalizeUsage("google-generate-content", { promptTokenCount: 0, cachedContentTokenCount: 0, candidatesTokenCount: 0 }), {
    inputTokensTotal: 0, outputTokens: 0, cacheReadTokens: 0,
  });
  assert.deepEqual(normalizeUsage("openai-chat-completions", {}), {});
  const report = summarizeUsage([
    { method: "openai-chat-completions", raw: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 70 }, completion_tokens: 8 } },
    { method: "openai-chat-completions", raw: { prompt_tokens: 50, completion_tokens: 3 } },
    { method: "anthropic-messages", raw: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 20, output_tokens: 5 } },
  ]);
  assert.equal(report.requests, 3);
  assert.equal(report.cacheRatioCoverage, 2);
  assert.equal(report.cacheReadRatio, 90 / 150);
  assert.equal(report.outputTokensKnown, 16);
});

test("a custom service uses its selected method for agent usage", async () => {
  const agent = createAgent({ provider: {
    profile: { name: "custom", provider: "my-gemini-gateway", method: "google-generate-content", model: "fixture" },
    async generate() { return { text: "done", toolCalls: [], finishReason: "STOP",
      usage: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 500, totalTokenCount: 620 } }; },
  } });
  await agent.run("hello");
  assert.equal(agent.stats().outputTokensKnown, 520);
  assert.equal(agent.stats().inputTokensKnown, 100);
});
