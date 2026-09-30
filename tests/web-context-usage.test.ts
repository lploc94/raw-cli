import assert from "node:assert/strict";
import { test } from "node:test";
import { contextUsage, contextUsageText } from "../web/src/composer/context-usage.js";

test("usage is measured against the auto-compact trigger when the agent sets one", () => {
  const usage = contextUsage({ estimatedTokens: 90_000, contextWindow: 1_000_000, compactTrigger: 360_000 });
  assert.deepEqual(usage, { limit: 360_000, basis: "compact", percent: 25 });
  assert.equal(contextUsage({ estimatedTokens: 90_000, contextWindow: 1_000_000, compactTrigger: 200_000 })!.percent, 45);
});

test("without a trigger usage falls back to the context window, and without either it is unknown", () => {
  assert.deepEqual(contextUsage({ estimatedTokens: 50_000, contextWindow: 200_000 }), { limit: 200_000, basis: "window", percent: 25 });
  assert.equal(contextUsage({ estimatedTokens: 50_000 }), undefined);
  assert.equal(contextUsage({ estimatedTokens: 50_000, contextWindow: 0, compactTrigger: Number.NaN }), undefined);
  assert.equal(contextUsage(undefined), undefined);
});

test("past the trigger the percentage is reported as is, not clamped to the window", () => {
  assert.equal(contextUsage({ estimatedTokens: 400_000, contextWindow: 1_000_000, compactTrigger: 360_000 })!.percent.toFixed(1), "111.1");
});

test("footer text names the limit it uses", () => {
  assert.equal(contextUsageText({ estimatedTokens: 90_000, contextWindow: 1_000_000, compactTrigger: 360_000 }, false), `~${(90_000).toLocaleString()} / ${(360_000).toLocaleString()} · 25.0% · until auto compact`);
  assert.equal(contextUsageText({ estimatedTokens: 50_000, contextWindow: 200_000 }, true), `~${(50_000).toLocaleString()} / ${(200_000).toLocaleString()} · 25.0% · last measured`);
  assert.equal(contextUsageText({ estimatedTokens: 5 }, false), "~5 tokens · window unavailable");
  assert.equal(contextUsageText(undefined, false), "Context usage unavailable");
});
