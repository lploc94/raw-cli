import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { compactSession } from "../src/compact.js";
import { createProvider } from "../src/llm/client.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const fake = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter => ({
  profile: { name: "fake", provider: "ollama", model: "fixture" }, generate,
});
const agentOptions = (provider: ProviderAdapter, cwd: string) => ({ provider, cwd, system: "tiny", maxSteps: 5, autoApprove: true });

async function seededAgent() {
  const cwd = await mkdtemp(join(tmpdir(), "raw-compact-"));
  let mainCalls = 0;
  const main = fake(async (request) => {
    mainCalls++;
    if (mainCalls === 3) return { text: "", finishReason: "tool_calls", opaque: { reasoning_details: [{ data: "signed" }] }, toolCalls: [
      { id: "c", name: "read_file", arguments: { path: "missing" } },
      { id: "d", name: "read_file", arguments: { path: "also-missing" } },
    ] };
    return { text: `answer ${mainCalls} ${"x".repeat(350)}`, finishReason: "stop", toolCalls: [], usage: { prompt_tokens: mainCalls, completion_tokens: 1 } };
  });
  const agent = createAgent(agentOptions(main, cwd));
  await agent.run(`original task ${"A".repeat(900)}`);
  await agent.run(`decision: use local model ${"B".repeat(900)}`);
  await agent.run("recent tool turn");
  await agent.run("latest turn");
  return { agent, getMainCalls: () => mainCalls };
}

test("manual compact pins original task, retains two complete turns and one summary request without tools", async () => {
  const { agent, getMainCalls } = await seededAgent();
  const before = agent.transcript;
  const mainBefore = getMainCalls();
  let compactRequests = 0;
  const summarizer = fake(async (request) => {
    compactRequests++;
    assert.deepEqual(request.tools, []);
    assert.match(request.system, /summari/i);
    assert.doesNotMatch(request.system, /read_file|write_file|bash/);
    assert.match(JSON.stringify(request.messages), /decision: use local model/);
    return { text: "Objective: original task. Decision: local model. Changed files: none. Unresolved: missing file.", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 30 } };
  });
  const result = await compactSession(agent, { provider: summarizer, keepRecentTurns: 2, maxOutputTokens: 100 });
  assert.equal(result.status, "compacted");
  assert.equal(compactRequests, 1);
  assert.equal(getMainCalls(), mainBefore);
  assert.ok((result.afterBytes ?? Infinity) < (result.beforeBytes ?? 0));
  const after = agent.transcript;
  assert.equal(after[0]?.role, "user");
  assert.equal(after[0]?.role === "user" ? after[0].content : "", before[0]?.role === "user" ? before[0].content : "");
  assert.match(after[1]?.role === "user" ? after[1].content : "", /Conversation summary/);
  const retained = before.slice(before.findIndex((message) => message.role === "user" && message.content === "recent tool turn"));
  assert.deepEqual(after.slice(2), retained);
  assert.equal(after.filter((message) => message.role === "tool").length, 2);
  assert.match(JSON.stringify(after), /signed/);
  assert.equal((await agent.run("continue")).status, "completed");
});

test("next real SDK request after compact contains a valid retained parallel call/result batch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-compact-wire-"));
  const long = "x".repeat(900);
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ content: `old ${long}` }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: `old2 ${long}` }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"missing"}' } },
      { index: 1, id: "b", type: "function", function: { name: "read_file", arguments: '{"path":"also-missing"}' } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "recent answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "latest answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "after compact" }, "stop"), openAiDone] },
  ]);
  try {
    const agent = createAgent(agentOptions(createProvider({ name: "wire", provider: "openai", model: "fixture", baseUrl: fixture.url, apiKey: "key" }), cwd));
    await agent.run(`original ${long}`);
    await agent.run(`decision ${long}`);
    await agent.run("recent call batch");
    await agent.run("latest");
    const result = await compactSession(agent, { provider: fake(async () => ({ text: "Original objective and local model decision.", toolCalls: [], finishReason: "stop" })) });
    assert.equal(result.status, "compacted");
    assert.equal((await agent.run("continue")).text, "after compact");
    const messages = (fixture.requests[5]?.body as { messages: { role: string; content?: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }).messages;
    assert.match(JSON.stringify(messages), /Conversation summary/);
    const calls = messages.find((message) => message.role === "assistant" && message.tool_calls)?.tool_calls?.map((call) => call.id);
    const results = messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
    assert.deepEqual(calls, ["a", "b"]);
    assert.deepEqual(results, calls);
  } finally { await fixture.close(); }
});

test("noop, failure, empty/oversize/nonshrinking summary and abort roll back byte-identically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-compact-noop-"));
  let calls = 0;
  const agent = createAgent(agentOptions(fake(async () => ({ text: "short", toolCalls: [], finishReason: "stop" })), cwd));
  await agent.run("only turn");
  const beforeNoop = JSON.stringify(agent.transcript);
  const never = fake(async () => { calls++; return { text: "unused", toolCalls: [], finishReason: "stop" }; });
  assert.equal((await compactSession(agent, { provider: never })).status, "noop");
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(agent.transcript), beforeNoop);

  const scenarios: Array<{ provider: ProviderAdapter; status?: string; rejects?: boolean }> = [
    { provider: fake(async () => { throw new Error("context length exceeded"); }), rejects: true },
    { provider: fake(async () => ({ text: "", toolCalls: [], finishReason: "stop" })), rejects: true },
    { provider: fake(async () => ({ text: "too many tokens", toolCalls: [], finishReason: "stop", usage: { completion_tokens: 999 } })), rejects: true },
    { provider: fake(async () => ({ text: "Z".repeat(10000), toolCalls: [], finishReason: "stop" })), status: "not_smaller" },
  ];
  for (const scenario of scenarios) {
    const seeded = await seededAgent();
    const before = JSON.stringify(seeded.agent.transcript);
    if (scenario.rejects) await assert.rejects(compactSession(seeded.agent, { provider: scenario.provider, maxOutputTokens: 50 }));
    else assert.equal((await compactSession(seeded.agent, { provider: scenario.provider })).status, scenario.status);
    assert.equal(JSON.stringify(seeded.agent.transcript), before);
  }

  const seeded = await seededAgent();
  const before = JSON.stringify(seeded.agent.transcript);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = fake((request) => new Promise((_resolve, reject) => {
    entered(); request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const pending = compactSession(seeded.agent, { provider: waiting });
  await ready;
  seeded.agent.abort();
  assert.equal((await pending).status, "cancelled");
  assert.equal(JSON.stringify(seeded.agent.transcript), before);
  assert.equal(seeded.agent.state, "idle");
});

test("clear is explicit, idle-only and retains cumulative usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-clear-"));
  let requests = 0;
  const agent = createAgent(agentOptions(fake(async () => { requests++; return { text: "ok", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 1 } }; }), cwd));
  await agent.run("task");
  agent.clear();
  assert.deepEqual(agent.transcript, []);
  assert.deepEqual(agent.usageRecords, [{ prompt_tokens: 1 }]);
  assert.equal(requests, 1);
});

test("second compact carries the previous summary as data and pins original task once", async () => {
  const { agent } = await seededAgent();
  assert.equal((await compactSession(agent, { provider: fake(async () => ({ text: "First summary of original objective and decision.", toolCalls: [], finishReason: "stop" })) })).status, "compacted");
  await agent.run("new fifth turn");
  let input = "";
  const result = await compactSession(agent, { provider: fake(async (request) => {
    input = JSON.stringify(request.messages);
    return { text: "Second summary with previous decisions and completed work.", toolCalls: [], finishReason: "stop" };
  }) });
  assert.equal(result.status, "compacted");
  assert.match(input, /First summary/);
  const transcript = agent.transcript;
  assert.equal(transcript.filter((message) => message.role === "user" && message.content.startsWith("original task")).length, 1);
  assert.match(transcript[1]?.role === "user" ? transcript[1].content : "", /Second summary/);
  assert.doesNotMatch(JSON.stringify(transcript), /First summary/);
});

test("busy compaction rejects run/config mutation and late summarizer output cannot swap transcript", async () => {
  const { agent } = await seededAgent();
  const before = JSON.stringify(agent.transcript);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let complete!: (turn: ProviderTurn) => void;
  const pendingSummary = new Promise<ProviderTurn>((resolve) => { complete = resolve; });
  const pending = compactSession(agent, { provider: fake(async () => { entered(); return pendingSummary; }) });
  await ready;
  await assert.rejects(agent.run("blocked"), /busy/);
  assert.throws(() => agent.clear(), /busy/);
  assert.throws(() => agent.setMaxOutputBytes(32), /busy/);
  agent.abort();
  assert.equal((await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort did not settle")), 150))])).status, "cancelled");
  complete({ text: "late summary", toolCalls: [], finishReason: "stop" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(agent.transcript), before);
});

test("repeated user text does not replace the identity of the pinned original task", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-compact-repeat-"));
  const main = fake(async () => ({ text: "old answer ".repeat(80), toolCalls: [], finishReason: "stop" }));
  const agent = createAgent(agentOptions(main, cwd));
  for (const input of ["original", "middle", "original", "last"]) await agent.run(input);
  const summary = fake(async () => ({ text: "short summary", toolCalls: [], finishReason: "stop" }));
  assert.equal((await compactSession(agent, { provider: summary })).status, "compacted");
  await agent.run("continue");
  assert.equal((await compactSession(agent, { provider: summary })).status, "compacted");
  const messages = agent.transcript;
  assert.equal(messages[0]?.role === "user" ? messages[0].content : "", "original");
  assert.equal(messages.filter((message) => message.role === "user" && message.content === "original").length, 1);
});

test("unknown-usage requests remain in coverage and rejected summary usage remains billable", async () => {
  const { agent } = await seededAgent();
  const prior = agent.stats().requests;
  const noUsage = fake(async () => ({ text: "summary", toolCalls: [], finishReason: "stop" }));
  assert.equal((await compactSession(agent, { provider: noUsage })).status, "compacted");
  assert.equal(agent.stats().requests, prior + 1);
  assert.equal(agent.stats().cacheRatioCoverage, 0);
  await agent.run("new turn without usage? main fixture reports usage");
  const before = JSON.stringify(agent.transcript);
  const rejected = fake(async () => ({ text: "", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 800, completion_tokens: 500 } }));
  await assert.rejects(compactSession(agent, { provider: rejected }));
  assert.equal(JSON.stringify(agent.transcript), before);
  assert.equal(agent.stats().requests, prior + 3);
  assert.ok(agent.stats().inputTokensKnown >= 800);
  assert.ok(agent.stats().outputTokensKnown >= 500);

  const cwd = await mkdtemp(join(tmpdir(), "raw-usage-missing-"));
  const missing = createAgent(agentOptions(fake(async () => ({ text: "answer", toolCalls: [], finishReason: "stop" })), cwd));
  await missing.run("one");
  await missing.run("two");
  assert.equal(missing.stats().requests, 2);
  assert.equal(missing.stats().inputCoverage, 0);
});

test("real SDK truncated compaction keeps reported usage while rolling back transcript", async () => {
  const fixture = await startMockProvider([{ frames: [
    openAiFrame({ content: "partial summary" }, "length"),
    `data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: {
      prompt_tokens: 800, completion_tokens: 512, prompt_tokens_details: { cached_tokens: 200 },
    } })}\n\n`,
    openAiDone,
  ] }]);
  try {
    const { agent } = await seededAgent();
    const before = JSON.stringify(agent.transcript);
    const prior = agent.stats();
    const provider = createProvider({ name: "summary", provider: "openai", model: "fixture", baseUrl: fixture.url, apiKey: "key" });
    await assert.rejects(compactSession(agent, { provider }), /length/);
    assert.equal(JSON.stringify(agent.transcript), before);
    assert.equal(fixture.requests.length, 1);
    const stats = agent.stats();
    assert.equal(stats.requests, prior.requests + 1);
    assert.equal(stats.inputTokensKnown, prior.inputTokensKnown + 800);
    assert.equal(stats.outputTokensKnown, prior.outputTokensKnown + 512);
    assert.equal(stats.cacheReadTokensKnown, prior.cacheReadTokensKnown + 200);
  } finally { await fixture.close(); }
});

test("Google thought tokens count toward measurable compact output budget", async () => {
  const { agent } = await seededAgent();
  const before = JSON.stringify(agent.transcript);
  const google: ProviderAdapter = {
    profile: { name: "google", provider: "google", model: "fixture" },
    generate: async () => ({ text: "summary", toolCalls: [], finishReason: "STOP", usage: {
      promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 500, totalTokenCount: 620,
    } }),
  };
  await assert.rejects(compactSession(agent, { provider: google, maxOutputTokens: 512 }));
  assert.equal(JSON.stringify(agent.transcript), before);
});
