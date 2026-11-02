import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider, isTerminalQuotaError, parseDurationOrDateMs, ProviderError, retryAfterMs, retryable, withProviderAbort } from "../src/llm/client.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const provider = (baseUrl: string) => createProvider({ agentName: "fixture", provider: "openai", method: "openai-chat-completions",
  model: "fixture", baseUrl, apiKey: "fixture" });
const request = (timeoutMs = 5000) => ({ system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], timeoutMs });
const ok = { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] };
const now = { "retry-after-ms": "0" };

test("rate limits, overload and 5xx before the stream starts are retried", async () => {
  const fixture = await startMockProvider([
    { status: 429, headers: now, body: { error: { message: "rate limited" } } },
    { status: 529, headers: now, body: { error: { message: "overloaded" } } },
    { status: 503, headers: now, body: { error: { message: "unavailable" } } },
    ok,
  ]);
  try {
    assert.equal((await provider(fixture.url).generate(request())).text, "ok");
    assert.equal(fixture.requests.length, 4);
  } finally { await fixture.close(); }
});

test("retries stop after three and client errors are never retried", async () => {
  const failing = { status: 500, headers: now, body: { error: { message: "boom" } } };
  const exhausted = await startMockProvider([failing, failing, failing, failing, ok]);
  try {
    await assert.rejects(provider(exhausted.url).generate(request()));
    assert.equal(exhausted.requests.length, 4);
  } finally { await exhausted.close(); }
  const invalid = await startMockProvider([{ status: 400, headers: now, body: { error: { message: "bad request" } } }, ok]);
  try {
    await assert.rejects(provider(invalid.url).generate(request()));
    assert.equal(invalid.requests.length, 1);
  } finally { await invalid.close(); }
});

test("the timeout bounds silence: a slow but steady stream finishes, a stalled one fails without retry", async () => {
  const frames = [..."abcdef"].map((letter) => openAiFrame({ content: letter })).concat(openAiFrame({}, "stop"), openAiDone);
  const steady = await startMockProvider([{ frames, frameDelayMs: 150 }]);
  try {
    assert.equal((await provider(steady.url).generate(request(600))).text, "abcdef");
  } finally { await steady.close(); }
  const stalled = await startMockProvider([{ frames: [openAiFrame({ content: "a" })], keepOpen: true }, ok]);
  try {
    await assert.rejects(provider(stalled.url).generate(request(300)), /timed out/);
    assert.equal(stalled.requests.length, 1);
  } finally { await stalled.close(); }
});

const gemini = (baseUrl: string) => createProvider({ agentName: "fixture", provider: "google", method: "google-generate-content",
  model: "fixture", baseUrl, apiKey: "fixture" });
const geminiText = (text: string, finishReason?: string) => googleFrame({ candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] });

test("Gemini: a steady stream longer than the timeout finishes, and a 429 waits for the body's retryDelay", async () => {
  const frames = [..."abcde"].map((letter) => geminiText(letter)).concat(geminiText("f", "STOP"));
  const steady = await startMockProvider([{ frames, frameDelayMs: 150 }]);
  try {
    assert.equal((await gemini(steady.url).generate(request(600))).text, "abcdef");
  } finally { await steady.close(); }
  const limited = await startMockProvider([
    { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.4s" }] } } },
    { frames: [geminiText("ok", "STOP")] },
  ]);
  try {
    const started = Date.now();
    assert.equal((await gemini(limited.url).generate(request())).text, "ok");
    const waited = Date.now() - started;
    assert.ok(waited >= 350 && waited < 700, `waited ${waited}ms`);
    assert.equal(limited.requests.length, 2);
  } finally { await limited.close(); }
});

test("429 terminal quota errors and x-should-retry headers control retryability", async () => {
  const quota = await startMockProvider([
    { status: 429, headers: now, body: { error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } } },
    ok,
  ]);
  try {
    await assert.rejects(provider(quota.url).generate(request()));
    assert.equal(quota.requests.length, 1);
  } finally { await quota.close(); }

  const noRetryHeader = await startMockProvider([
    { status: 429, headers: { ...now, "x-should-retry": "false" }, body: { error: { message: "Rate limit reached for requests per min (RPM)" } } },
    ok,
  ]);
  try {
    await assert.rejects(provider(noRetryHeader.url).generate(request()));
    assert.equal(noRetryHeader.requests.length, 1);
  } finally { await noRetryHeader.close(); }

  const forceRetryHeader = await startMockProvider([
    { status: 422, headers: { ...now, "x-should-retry": "true" }, body: { error: { message: "transient validation state" } } },
    ok,
  ]);
  try {
    assert.equal((await provider(forceRetryHeader.url).generate(request())).text, "ok");
    assert.equal(forceRetryHeader.requests.length, 2);
  } finally { await forceRetryHeader.close(); }

  assert.equal(isTerminalQuotaError({ status: 429, type: "billing_hard_limit_reached", message: "Billing hard limit has been reached" }), true);
  assert.equal(isTerminalQuotaError({ status: 429, message: "Your credit balance is too low to access the Anthropic API." }), true);
  assert.equal(isTerminalQuotaError({ status: 429, code: "rate_limit_exceeded", message: "Rate limit reached on tokens per min (TPM). Please try again in 2s." }), false);
});

test("pre-output SSE errors and premature stream closes retry across adapters without duplicate usage, while post-delta errors do not retry", async () => {
  const anthropicProvider = (baseUrl: string) => createProvider({
    agentName: "fixture", provider: "anthropic", method: "anthropic-messages", model: "fixture", baseUrl, apiKey: "fixture", maxOutputTokens: 128,
  });
  const anthropicStart = anthropicFrame("message_start", {
    message: { id: "m1", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 0 } },
  });
  const anthropicError = anthropicFrame("error", { error: { type: "overloaded_error", message: "Overloaded" } });
  const anthropicOk = [
    anthropicFrame("message_start", {
      message: { id: "m2", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } },
    }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "recovered" } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
    anthropicFrame("message_stop", {}),
  ];
  const anthropicPreOutput = await startMockProvider([
    { frames: [anthropicStart, anthropicError] },
    { frames: anthropicOk },
  ]);
  try {
    const usages: unknown[] = [];
    const turn = await anthropicProvider(anthropicPreOutput.url).generate({ ...request(2000), onUsage: (u) => usages.push(u) });
    assert.equal(turn.text, "recovered");
    assert.equal(anthropicPreOutput.requests.length, 2);
    assert.equal(usages.length, 1);
    assert.deepEqual(usages[0], { input_tokens: 30, output_tokens: 4 });
  } finally { await anthropicPreOutput.close(); }

  const responsesProvider = (baseUrl: string) => createProvider({
    agentName: "fixture", provider: "openai", method: "openai-responses", model: "fixture", baseUrl, apiKey: "fixture",
  });
  const responsesPreOutput = await startMockProvider([
    {
      frames: [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 1, response: { id: "r1", status: "in_progress", output: [] } })}\n\n`,
        `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: 2, response: { id: "r1", status: "failed", output: [], usage: { input_tokens: 11, output_tokens: 0 }, error: { code: "server_error", message: "Upstream error" } } })}\n\n`,
        openAiDone,
      ],
    },
    {
      frames: [
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "r2", object: "response", status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "responses-ok", annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 2 } } })}\n\n`,
        openAiDone,
      ],
    },
  ]);
  try {
    const usages: unknown[] = [];
    const turn = await responsesProvider(responsesPreOutput.url).generate({ ...request(2000), onUsage: (u) => usages.push(u) });
    assert.equal(turn.text, "responses-ok");
    assert.equal(responsesPreOutput.requests.length, 2);
    assert.equal(usages.length, 1);
    assert.deepEqual(usages[0], { input_tokens: 12, output_tokens: 2 });
  } finally { await responsesPreOutput.close(); }

  const chatPreOutputClose = await startMockProvider([
    { frames: [openAiFrame({ role: "assistant" }), openAiDone] },
    ok,
  ]);
  try {
    const turn = await provider(chatPreOutputClose.url).generate(request(2000));
    assert.equal(turn.text, "ok");
    assert.equal(chatPreOutputClose.requests.length, 2);
  } finally { await chatPreOutputClose.close(); }

  const anthropicPostDelta = await startMockProvider([
    {
      frames: [
        anthropicStart,
        anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
        anthropicError,
      ],
    },
    { frames: anthropicOk },
  ]);
  try {
    const deltas: string[] = [];
    await assert.rejects(anthropicProvider(anthropicPostDelta.url).generate({ ...request(2000), onTextDelta: (d) => deltas.push(d) }));
    assert.deepEqual(deltas, ["Hello"]);
    assert.equal(anthropicPostDelta.requests.length, 1);
  } finally { await anthropicPostDelta.close(); }
});

test("retryAfterMs and withProviderAbort preserve unclamped server delays, support all RFC 9110 HTTP-date formats, distinguish 429 RPM vs TPM reset buckets, reject negative strings, and fail fast when exceeding timeoutMs", async () => {
  const fixedNow = Date.parse("2026-11-02T14:00:00.000Z");
  assert.equal(retryAfterMs({ status: 429, headers: { "retry-after": "90" } }, fixedNow), 90_000);
  assert.equal(retryAfterMs({ status: 429, headers: { "retry-after-ms": "75000" } }, fixedNow), 75_000);
  assert.equal(retryAfterMs({ status: 503, headers: { "retry-after": "Mon, 02 Nov 2026 14:00:08 GMT" } }, fixedNow), 8_000);
  assert.equal(retryAfterMs({ status: 503, headers: { "retry-after": "Monday, 02-Nov-26 14:00:09 GMT" } }, fixedNow), 9_000);
  assert.equal(retryAfterMs({ status: 503, headers: { "retry-after": "Mon Nov  2 14:00:10 2026" } }, fixedNow), 10_000);
  assert.equal(parseDurationOrDateMs("2026-11-02T14:00:12.000Z", fixedNow), 12_000);
  assert.equal(parseDurationOrDateMs("2026-11-02T14:00:12+00:00", fixedNow), 12_000);
  assert.equal(parseDurationOrDateMs("2026-11-02T14:00:12", fixedNow), undefined);
  assert.equal(retryAfterMs({ status: 429, headers: { "retry-after": "-5" } }, fixedNow), undefined);
  assert.equal(parseDurationOrDateMs("-100ms", fixedNow), undefined);
  assert.equal(retryAfterMs({
    status: 503,
    headers: {
      "x-ratelimit-remaining-requests": "59",
      "x-ratelimit-remaining-tokens": "149984",
      "x-ratelimit-reset-requests": "1s",
      "x-ratelimit-reset-tokens": "6m0s",
    },
  }, fixedNow), undefined);
  assert.equal(retryAfterMs({
    status: 429,
    headers: {
      "x-ratelimit-remaining-requests": "59",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-requests": "1s",
      "x-ratelimit-reset-tokens": "1m30s",
    },
  }, fixedNow), 90_000);
  assert.equal(retryAfterMs({
    status: 429,
    headers: {
      "x-ratelimit-remaining-requests": "59",
      "x-ratelimit-remaining-tokens": "1000",
      "x-ratelimit-reset-requests": "1s",
      "x-ratelimit-reset-tokens": "45s",
    },
  }, fixedNow), 45_000);
  assert.equal(retryAfterMs({
    status: 429,
    headers: {
      "x-ratelimit-remaining-requests": "59",
      "x-ratelimit-reset-requests": "1s",
      "x-ratelimit-reset-tokens": "45s",
    },
  }, fixedNow), 45_000);
  assert.equal(retryAfterMs({
    status: 429,
    error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" },
    message: "429 rate_limit_error",
    headers: {
      "anthropic-ratelimit-requests-reset": "30s",
      "anthropic-ratelimit-tokens-reset": "2s",
    },
  }, fixedNow), 2_000);
  assert.equal(retryAfterMs({
    status: 429,
    message: "Rate limit reached for requests per min (RPM)",
    headers: {
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-remaining-tokens": "149984",
      "x-ratelimit-reset-requests": "2s",
      "x-ratelimit-reset-tokens": "6m0s",
    },
  }, fixedNow), 2_000);

  let failFastAttempts = 0;
  const failFastStart = Date.now();
  await assert.rejects(
    withProviderAbort({ timeoutMs: 90_000 }, async () => {
      failFastAttempts++;
      throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "120" } });
    }),
    /rate limited/,
  );
  const failFastElapsed = Date.now() - failFastStart;
  assert.equal(failFastAttempts, 1);
  assert.ok(failFastElapsed < 100, `expected fail-fast < 100ms, got ${failFastElapsed}ms`);

  let bucketAttempts = 0;
  const bucketStart = Date.now();
  const bucketRes = await withProviderAbort({ timeoutMs: 5_000 }, async () => {
    bucketAttempts++;
    if (bucketAttempts === 1) {
      throw Object.assign(new Error("tpm limit"), {
        status: 429,
        headers: {
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-tokens": "80ms",
          "x-ratelimit-remaining-requests": "10",
          "x-ratelimit-reset-requests": "10s",
        },
      });
    }
    return "recovered";
  });
  const bucketElapsed = Date.now() - bucketStart;
  assert.equal(bucketRes, "recovered");
  assert.equal(bucketAttempts, 2);
  assert.ok(bucketElapsed >= 60 && bucketElapsed < 1_000, `expected ~80ms wait, got ${bucketElapsed}ms`);
});

test("cycle-safe cause chain and AggregateError traversal retries nested socket and Undici codes under neutral outer errors", async () => {
  let aggAttempts = 0;
  const aggRes = await withProviderAbort({ timeoutMs: 2_000 }, async () => {
    aggAttempts++;
    if (aggAttempts === 1) {
      const inner = new AggregateError([
        new Error("first non-retryable"),
        Object.assign(new Error("second"), { code: "ECONNREFUSED" }),
      ]);
      throw Object.assign(new Error("outer wrapper", { cause: inner }), { headers: now });
    }
    return "agg-ok";
  });
  assert.equal(aggRes, "agg-ok");
  assert.equal(aggAttempts, 2);

  let deepAttempts = 0;
  const deepRes = await withProviderAbort({ timeoutMs: 2_000 }, async () => {
    deepAttempts++;
    if (deepAttempts === 1) {
      throw Object.assign(new Error("outer wrapper", { cause: { cause: { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } } } }), { headers: now });
    }
    return "deep-ok";
  });
  assert.equal(deepRes, "deep-ok");
  assert.equal(deepAttempts, 2);

  const cycle = new Error("loop") as Error & { cause?: unknown };
  cycle.cause = cycle;
  assert.equal(retryable(cycle), false);
  assert.equal(retryable(new ProviderError("incomplete_stream", "cut")), true);
  assert.equal(retryable(new ProviderError("invalid_stream", "bad")), false);
});
