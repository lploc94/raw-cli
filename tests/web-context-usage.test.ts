import assert from "node:assert/strict";
import { test } from "node:test";
import { contextUsage } from "../web/src/composer/context-usage.js";
import { contextCard } from "../web/src/composer/context-card.js";

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

test("the ring and its card: the tokens, the limit and what it is, the messages kept and the trigger", () => {
  const card = contextCard({ estimatedTokens: 5_855, contextWindow: 8_192 }, { stale: false, messages: 30 });
  assert.deepEqual(card, { label: "Context: 71% used", percent: 71, tone: "accent", tokens: "~5.9k", of: "/ 8.2k tokens", line: "30 messages kept · auto compact off" });
  const trigger = contextCard({ estimatedTokens: 3_000, contextWindow: 8_192, compactTrigger: 4_000 }, { stale: false, messages: 1 });
  assert.equal(trigger.of, "/ 4k tokens until auto compact");
  assert.equal(trigger.line, "1 message kept · auto compact at 4k");
  assert.equal(trigger.percent, 75);
  // Claude Code's trigger is Raw's estimate: marked, and still the basis of the ring.
  const estimated = contextCard({ estimatedTokens: 100_000, source: "provider", contextWindow: 360_000, compactTrigger: 327_000,
    compactTriggerEstimated: true }, { stale: false, messages: 4 });
  assert.equal(estimated.of, "/ ≈327k tokens until auto compact");
  assert.equal(estimated.line, "4 messages kept · auto compact at ≈327k");
  assert.equal(estimated.percent, 31);
});

test("a provider-reported size has no estimate mark; old measurements without a source do", () => {
  assert.equal(contextCard({ estimatedTokens: 15_865, source: "provider", contextWindow: 200_000 }, { stale: false }).tokens, "16k");
  assert.equal(contextCard({ estimatedTokens: 15_865, source: "estimate", contextWindow: 200_000 }, { stale: false }).tokens, "~16k");
  assert.equal(contextCard({ estimatedTokens: 15_865, contextWindow: 200_000 }, { stale: false }).tokens, "~16k");
});

test("the tone is the accent, amber from 80 % and red from 95 %, past the trigger too", () => {
  const tone = (estimatedTokens: number) => contextCard({ estimatedTokens, contextWindow: 1_000 }, { stale: false }).tone;
  assert.deepEqual([tone(790), tone(800), tone(949), tone(950), tone(1_200)], ["accent", "warning", "warning", "error", "error"]);
  assert.equal(contextCard({ estimatedTokens: 1_200, contextWindow: 1_000 }, { stale: false }).label, "Context: 120% used");
});

test("an old measurement says so; before the first one, and without a limit, there is no percent", () => {
  assert.equal(contextCard({ estimatedTokens: 500, contextWindow: 1_000 }, { stale: true, messages: 2 }).line, "2 messages kept · auto compact off · last measured");
  assert.deepEqual(contextCard(undefined, { stale: false }), { label: "Context: not measured yet", tone: "accent", line: "" });
  const unknown = contextCard({ estimatedTokens: 5 }, { stale: false });
  assert.equal(unknown.percent, undefined);
  assert.equal(unknown.label, "Context: ~5 tokens, no limit known");
  assert.equal(unknown.of, "tokens");
});
