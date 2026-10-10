import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/client.js";
import { googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

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
