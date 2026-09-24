import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUsage, summarizeUsage } from "../src/llm/cache.js";

test("OpenAI and Google totals include cached reads; Anthropic adds disjoint categories once", () => {
  assert.deepEqual(normalizeUsage("openai", { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 } }), {
    inputTokensTotal: 100, outputTokens: 9, cacheReadTokens: 70, cacheWriteTokens: 20, cacheReadRatio: 0.7,
  });
  assert.deepEqual(normalizeUsage("anthropic", { input_tokens: 10, cache_creation_input_tokens: 30, cache_read_input_tokens: 60,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 }, output_tokens: 8 }), {
    inputTokensTotal: 100, outputTokens: 8, cacheReadTokens: 60, cacheWriteTokens: 30, cacheReadRatio: 0.6,
  });
  assert.deepEqual(normalizeUsage("google", { promptTokenCount: 80, candidatesTokenCount: 7, cachedContentTokenCount: 50 }), {
    inputTokensTotal: 80, outputTokens: 7, cacheReadTokens: 50, cacheReadRatio: 0.625,
  });
  assert.deepEqual(normalizeUsage("google", { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 500, totalTokenCount: 620 }), {
    inputTokensTotal: 100, outputTokens: 520,
  });
});

test("absent metrics remain unknown; explicit zeros and mixed-known coverage are honest", () => {
  assert.deepEqual(normalizeUsage("openai-compatible", { prompt_tokens: 40, completion_tokens: 2 }), {
    inputTokensTotal: 40, outputTokens: 2,
  });
  assert.deepEqual(normalizeUsage("anthropic", { input_tokens: 5, output_tokens: 2 }), { outputTokens: 2 });
  assert.deepEqual(normalizeUsage("google", { promptTokenCount: 0, cachedContentTokenCount: 0, candidatesTokenCount: 0 }), {
    inputTokensTotal: 0, outputTokens: 0, cacheReadTokens: 0,
  });
  assert.deepEqual(normalizeUsage("ollama", {}), {});
  const report = summarizeUsage([
    { provider: "openai", raw: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 70 }, completion_tokens: 8 } },
    { provider: "openai-compatible", raw: { prompt_tokens: 50, completion_tokens: 3 } },
    { provider: "anthropic", raw: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 20, output_tokens: 5 } },
  ]);
  assert.equal(report.requests, 3);
  assert.equal(report.cacheRatioCoverage, 2);
  assert.equal(report.cacheReadRatio, 90 / 150);
  assert.equal(report.outputTokensKnown, 16);
});
