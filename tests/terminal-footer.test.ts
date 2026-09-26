import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTurnFooter, formatStats } from "../src/terminal/footer.js";
import { effectiveInputBudget } from "../src/llm/context.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";
import type { UsageSummary } from "../src/llm/cache.js";

const ui = resolveUiOptions({ color: "never", icons: "ascii" });
const caps = terminalCapabilities(false, { TERM: "dumb" }, ui);
const base: UsageSummary = { requests: 2, inputTokensKnown: 1200, inputCoverage: 2,
  outputTokensKnown: 100, outputCoverage: 2, cacheReadTokensKnown: 300,
  cacheWriteTokensKnown: 0, cacheReadCoverage: 2, cacheWriteCoverage: 0,
  cacheRatioCoverage: 2, cacheReadRatio: 0.25 };

test("footer separates turn timing, estimated context and observed session usage", () => {
  const rendered = formatTurnFooter({ status: "completed", elapsedMs: 8400, startedToolCalls: 3, notRunToolCalls: 0,
    stats: base, contextTokens: 500, contextWindow: 1000, inputBudget: effectiveInputBudget(1000, 100),
    sessionId: "session-123", resumable: true, ui, caps });
  assert.match(rendered, /Done.*8\.4s.*3 tool/);
  assert.match(rendered, /Context.*~500 \/ 1k.*50\.0%/);
  assert.match(rendered, /Session.*1\.2k input.*100 output.*300 cache read/);
  assert.match(rendered, /raw --resume session-123 "query"/);
  assert.doesNotMatch(rendered, /cache miss|\$0/);
});

test("missing cache fields stay unknown; reported zero is displayed", () => {
  const missing = { ...base, cacheReadCoverage: 0, cacheRatioCoverage: 0 };
  const format = (stats: UsageSummary) => formatTurnFooter({ status: "completed", elapsedMs: 0,
    startedToolCalls: 0, notRunToolCalls: 0, stats, contextTokens: 200, sessionId: "id", resumable: true, ui, caps });
  assert.doesNotMatch(format(missing), /cache read/);
  assert.match(format({ ...base, cacheReadTokensKnown: 0 }), /0 cache read/);
  assert.match(format(missing), /window unknown/);
  const verboseUi = resolveUiOptions({ density: "verbose", color: "never", icons: "ascii" });
  const verbose = formatTurnFooter({ status: "completed", elapsedMs: 200, startedToolCalls: 1, notRunToolCalls: 0,
    stats: { ...missing, inputCoverage: 1 }, contextTokens: 200, sessionId: "id", resumable: true, ui: verboseUi, caps });
  assert.match(verbose, /Input.*reported 1\/2 requests/);
  assert.match(verbose, /Cache read.*reported 0\/2 requests/);
});

test("failed and cancelled saved sessions retain continuation; persistence failure does not", () => {
  const format = (status: "error" | "cancelled", resumable: boolean, code: string) =>
    formatTurnFooter({ status, code, elapsedMs: 50, startedToolCalls: 1, notRunToolCalls: 1,
      stats: { ...base, requests: 0 }, contextTokens: 0, sessionId: "id", resumable, ui, caps });
  assert.match(format("error", true, "provider_error"), /Failed.*provider_error[\s\S]*raw --resume id/);
  assert.match(format("cancelled", true, "cancelled"), /Cancelled[\s\S]*raw --resume id/);
  assert.doesNotMatch(format("error", false, "persistence_error"), /raw --resume/);
  const high = formatTurnFooter({ status: "completed", elapsedMs: 1, startedToolCalls: 0, notRunToolCalls: 0,
    stats: { ...base, requests: 0 }, contextTokens: 1500, contextWindow: 1000, inputBudget: 836,
    sessionId: "id", resumable: true, ui, caps });
  assert.match(high, /150\.0%/);
});

test("stats table reports coverage and no JSON or inferred misses", () => {
  const text = formatStats({ ...base, cacheReadCoverage: 1, cacheWriteCoverage: 0 }, ui, caps,
    { elapsedMs: 1234, firstTextMs: 234 });
  assert.match(text, /Requests\s+2/);
  assert.match(text, /Cache read.*reported 1\/2/);
  assert.match(text, /Cache write.*reported 0\/2/);
  assert.match(text, /Last turn.*1\.2s/);
  assert.doesNotMatch(text, /\{|cache miss/);
});
