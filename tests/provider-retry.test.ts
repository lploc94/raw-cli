import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/llm/client.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

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
