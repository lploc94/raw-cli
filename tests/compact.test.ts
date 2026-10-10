import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { CHECKPOINT_MERGE_PREFIX, CHECKPOINT_NO_TOOLS_GUARD, COMPACT_SYSTEM_PROMPT, CompactionOverheadError, checkpointPrompt, checkpointWords,
  compactSession, estimateRequestTokens, renderTranscript, summarizeTranscript } from "../src/compact.js";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage, ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const fake = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter => ({
  modelConfig: { agentName: "fake", provider: "ollama", method: "openai-chat-completions", model: "fixture" }, generate,
});
// A short verbatim tail, so these small sessions still have steps to summarize; keep_recent_turns then keeps two turns.
const agentOptions = (provider: ProviderAdapter, cwd: string) => ({ provider, cwd, system: "tiny", maxSteps: 5, autoApprove: true,
  compact: { keepRecentTurns: 2, keepRecentTokens: 1, maxOutputTokens: 16384 } });

async function seededAgent() {
  const cwd = await mkdtemp(join(tmpdir(), "raw-compact-"));
  let mainCalls = 0;
  const main = fake(async (request) => {
    mainCalls++;
    if (mainCalls === 3) return { text: "", finishReason: "tool_calls", opaque: { reasoning_details: [{ data: "signed" }] }, toolCalls: [
      { id: "c", name: "read_file", arguments: { files: [{ path: "missing" }] } },
      { id: "d", name: "read_file", arguments: { files: [{ path: "also-missing" }] } },
    ] };
    return { text: `answer ${mainCalls} ${"x".repeat(2000)}`, finishReason: "stop", toolCalls: [], usage: { prompt_tokens: mainCalls, completion_tokens: 1 } };
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
  const checkpoint = after[0]?.role === "user" && typeof after[0].content === "string" ? after[0].content : "";
  assert.ok(checkpoint.startsWith("[Raw compaction checkpoint #1]"));
  // The user's messages that left the context are kept verbatim; the retained turns follow unchanged.
  for (const input of [`original task ${"A".repeat(900)}`, `decision: use local model ${"B".repeat(900)}`]) assert.ok(checkpoint.includes(`${input}\n`));
  assert.ok(!checkpoint.includes("x".repeat(2000)));
  const retained = before.slice(before.findIndex((message) => message.role === "user" && message.content === "recent tool turn"));
  assert.deepEqual(after.slice(1), retained);
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
      { index: 0, id: "a", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":"missing"}]}' } },
      { index: 1, id: "b", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":"also-missing"}]}' } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "recent answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "latest answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "after compact" }, "stop"), openAiDone] },
  ]);
  try {
    const agent = createAgent(agentOptions(createProvider({ agentName: "wire", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "key" }), cwd));
    await agent.run(`original ${long}`);
    await agent.run(`decision ${long}`);
    await agent.run("recent call batch");
    await agent.run("latest");
    const result = await compactSession(agent, { provider: fake(async () => ({ text: "Original objective and local model decision.", toolCalls: [], finishReason: "stop" })) });
    assert.equal(result.status, "compacted");
    assert.equal((await agent.run("continue")).text, "after compact");
    const messages = (fixture.requests[5]?.body as { messages: { role: string; content?: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }).messages;
    assert.match(JSON.stringify(messages), /Raw compaction checkpoint #1/);
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
  const checkpoints = transcript.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Raw compaction checkpoint #"));
  assert.equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0]?.role === "user" ? String(checkpoints[0].content) : "";
  assert.ok(checkpoint.startsWith("[Raw compaction checkpoint #2]") && checkpoint.includes("## Checkpoint\nSecond summary"));
  assert.equal(checkpoint.split(`original task ${"A".repeat(900)}`).length - 1, 1);
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

test("repeated user text keeps each typed input as its own ledger entry across compactions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-compact-repeat-"));
  const main = fake(async () => ({ text: "old answer ".repeat(80), toolCalls: [], finishReason: "stop" }));
  const agent = createAgent(agentOptions(main, cwd));
  for (const input of ["original", "middle", "original", "last"]) await agent.run(input);
  const summary = fake(async () => ({ text: "short summary", toolCalls: [], finishReason: "stop" }));
  assert.equal((await compactSession(agent, { provider: summary })).status, "compacted");
  await agent.run("continue");
  assert.equal((await compactSession(agent, { provider: summary })).status, "compacted");
  const messages = agent.transcript;
  const checkpoint = messages[0]?.role === "user" && typeof messages[0].content === "string" ? messages[0].content : "";
  const ledger = checkpoint.slice(checkpoint.indexOf("## User messages"), checkpoint.indexOf("## Working state"));
  assert.deepEqual([...ledger.matchAll(/\[user\]\n(\w+)/g)].map((match) => match[1]), ["original", "middle", "original", "last", "continue"]);
  assert.equal(messages.filter((message) => message.role === "user" && message.content === "original").length, 0);
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

test("a summary cut at the output limit is retried once with twice the budget, then kept with a note", async () => {
  const truncated = (text: string) => ({ frames: [
    openAiFrame({ content: text }, "length"),
    `data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: {
      prompt_tokens: 800, completion_tokens: 512, prompt_tokens_details: { cached_tokens: 200 },
    } })}\n\n`,
    openAiDone,
  ] });
  const fixture = await startMockProvider([truncated("partial summary"), truncated("longer partial summary")]);
  try {
    const { agent } = await seededAgent();
    const prior = agent.stats();
    const provider = createProvider({ agentName: "summary", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "key" });
    const result = await compactSession(agent, { provider, maxOutputTokens: 512 });
    assert.equal(result.status, "compacted");
    assert.deepEqual(fixture.requests.map((request) => (request.body as { max_completion_tokens: number }).max_completion_tokens), [512, 1024]);
    assert.ok(JSON.stringify(agent.transcript).includes("longer partial summary\\n[Summary cut off at the output token limit.]"));
    const stats = agent.stats();
    assert.equal(stats.requests, prior.requests + 2);
    assert.equal(stats.inputTokensKnown, prior.inputTokensKnown + 1600);
    assert.equal(stats.outputTokensKnown, prior.outputTokensKnown + 1024);
    assert.equal(stats.cacheReadTokensKnown, prior.cacheReadTokensKnown + 400);
  } finally { await fixture.close(); }
});

test("Google thought tokens count toward measurable compact output budget", async () => {
  const { agent } = await seededAgent();
  const before = JSON.stringify(agent.transcript);
  const google: ProviderAdapter = {
    modelConfig: { agentName: "google", provider: "google", method: "google-generate-content", model: "fixture" },
    generate: async () => ({ text: "summary", toolCalls: [], finishReason: "STOP", usage: {
      promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 500, totalTokenCount: 620,
    } }),
  };
  await assert.rejects(compactSession(agent, { provider: google, maxOutputTokens: 512 }));
  assert.equal(JSON.stringify(agent.transcript), before);
});

const turn = (text: string): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop" });
const userText = (request: ProviderRequest) => {
  const content = request.messages[0]?.role === "user" ? request.messages[0].content : "";
  return typeof content === "string" ? content : "";
};

test("checkpoint prompt follows design §7.2: guard first, conditional merge block, computed length rule, instructions last", () => {
  assert.equal(checkpointWords(16384), 4000);
  assert.equal(checkpointWords(2000), 1200);
  assert.equal(checkpointWords(100), 60);
  const plain = checkpointPrompt({ words: checkpointWords(16384) });
  assert.ok(plain.startsWith(CHECKPOINT_NO_TOOLS_GUARD));
  assert.ok(plain.includes("Use up to about 4000 words."));
  assert.ok(!plain.includes("{WORDS}"));
  assert.ok(!plain.includes(CHECKPOINT_MERGE_PREFIX) && !plain.includes("<prior-checkpoint>\n"));
  assert.ok(!plain.includes("Additional instructions from the agent configuration:"));
  assert.ok(plain.includes("13. The last 3 actions and their results") && plain.endsWith("up to the end of the plan."));
  const prior = `prior-${Math.random()}`;
  const instructions = `keep-${Math.random()}`;
  const merged = checkpointPrompt({ words: checkpointWords(2000), prior, instructions });
  const order = [CHECKPOINT_NO_TOOLS_GUARD, `<prior-checkpoint>\n${prior}\n</prior-checkpoint>`, CHECKPOINT_MERGE_PREFIX,
    "You are checkpointing your own working memory.", "Use up to about 1200 words.", "## Goal", "## Next actions",
    `Additional instructions from the agent configuration:\n${instructions}`].map((part) => merged.indexOf(part));
  assert.ok(order.every((index) => index >= 0), `missing part: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(merged.endsWith(instructions));
  // A blank instruction adds nothing.
  assert.equal(checkpointPrompt({ words: 60, instructions: "  " }), checkpointPrompt({ words: 60 }));
});

test("transcript rendering keeps readable reasoning, drops unreadable opaque data, and cuts large results to a saved copy", async () => {
  const head = `HEAD-${"h".repeat(200)}`;
  const tail = `${"t".repeat(200)}-TAIL`;
  const big = head + "m".repeat(10_000) + tail;
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: Buffer.alloc(30, 1).toString("base64"), name: "shot.png" }] },
    { role: "assistant", text: "anthropic step", toolCalls: [], opaque: [
      { type: "thinking", thinking: "READABLE-ANTHROPIC", signature: "SECRET-ANTHROPIC-SIG" },
      { type: "redacted_thinking", data: "SECRET-REDACTED" }, { type: "text", text: "anthropic step" }] },
    { role: "assistant", text: "responses step", toolCalls: [], opaque: [
      { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "READABLE-RESPONSES" }], encrypted_content: "SECRET-ENCRYPTED" }] },
    { role: "assistant", text: "google step", toolCalls: [], opaque: [
      { text: "READABLE-GOOGLE", thought: true, thoughtSignature: "SECRET-GOOGLE-SIG" }, { text: "google step" }] },
    { role: "assistant", text: "openrouter step", toolCalls: [], opaque: { reasoning_details: [
      { type: "reasoning.text", text: "READABLE-OPENROUTER", signature: "SECRET-OPENROUTER-SIG" },
      { type: "reasoning.summary", summary: "READABLE-OR-SUMMARY" }, { type: "reasoning.encrypted", data: "SECRET-OPENROUTER-DATA" }] } },
    { role: "assistant", text: "deepseek step", toolCalls: [], opaque: { reasoning_content: "READABLE-DEEPSEEK" } },
    { role: "assistant", text: "unknown step", toolCalls: [], opaque: { mystery: "SECRET-UNKNOWN-OBJECT" } },
    { role: "assistant", text: "", toolCalls: [{ id: "w", name: "write_file", arguments: { path: "big.txt", content: `WSTART${"w".repeat(9000)}WEND` } }] },
    { role: "tool", callId: "w", name: "write_file", result: { isError: false, content: [{ type: "text", text: "wrote big.txt" }] } },
    { role: "assistant", text: "", toolCalls: [{ id: "a", name: "bash", arguments: { command: "make" } }, { id: "b", name: "bash", arguments: { command: "make test" } }],
      opaque: [{ type: "mystery", payload: "SECRET-UNKNOWN-ARRAY" }] },
    { role: "tool", callId: "a", name: "bash", result: { isError: false, content: [{ type: "text", text: big }], fullOutputPath: "/saved/full.log" } },
    { role: "tool", callId: "b", name: "bash", result: { isError: true, content: [{ type: "text", text: big }] } },
  ];
  const saved: string[] = [];
  const text = renderTranscript(messages, { saveCopy: (copy) => { saved.push(copy); return "/spill/copy.log"; } });
  for (const readable of ["READABLE-ANTHROPIC", "READABLE-RESPONSES", "READABLE-GOOGLE", "READABLE-OPENROUTER", "READABLE-OR-SUMMARY", "READABLE-DEEPSEEK"]) {
    assert.ok(text.includes(`REASONING:\n${readable}`), readable);
  }
  for (const secret of ["SECRET-ANTHROPIC-SIG", "SECRET-REDACTED", "SECRET-ENCRYPTED", "SECRET-GOOGLE-SIG", "SECRET-OPENROUTER-SIG",
    "SECRET-OPENROUTER-DATA", "SECRET-UNKNOWN-OBJECT", "SECRET-UNKNOWN-ARRAY"]) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('USER:\nlook\n[Image: image/png, 30 bytes, "shot.png"]'));
  assert.ok(!text.includes(Buffer.alloc(30, 1).toString("base64")));
  assert.match(text, /TOOL CALL write_file\(\{"path":"big.txt","content":"WSTART[^]*…\[\d+ bytes omitted\]…[^]*WEND"\}\)/);
  assert.ok(!text.includes("w".repeat(5000)));
  assert.ok(text.includes('TOOL CALL bash({"command":"make"})') && text.includes('TOOL CALL bash({"command":"make test"})'));
  assert.equal(text.split("HEAD-").length - 1, 2);
  assert.equal(text.split("-TAIL").length - 1, 2);
  assert.ok(!text.includes("m".repeat(5000)));
  assert.match(text, /TOOL RESULT bash:\nHEAD-[^]*…\[\d+ bytes omitted; full output: \/saved\/full\.log\]…[^]*-TAIL/);
  assert.match(text, /TOOL RESULT bash \(error\):\nHEAD-[^]*…\[\d+ bytes omitted; full output: \/spill\/copy\.log\]…[^]*-TAIL/);
  assert.deepEqual(saved, [big]);
  // A failed save says so instead of naming a path.
  const failed = renderTranscript(messages.slice(-1), { saveCopy: () => { throw new Error("disk full"); } });
  assert.match(failed, /bytes omitted; full output: unavailable\]/);
  // The default saver is the spill store, and its copy is the complete rendered result.
  const spilled = /full output: ([^\]]+)\]/.exec(renderTranscript(messages.slice(-1)))?.[1];
  assert.ok(spilled && spilled !== "unavailable");
  assert.equal(await readFile(spilled, "utf8"), big);
});

test("a single turn larger than the summarizer context compacts in step chunks without splitting calls from results", async () => {
  const contextWindow = 9000;
  const messages: ModelMessage[] = [{ role: "user", content: "one long task" }];
  for (let step = 0; step < 40; step++) {
    messages.push({ role: "assistant", text: `step ${step}`, toolCalls: [
      { id: `c${step}a`, name: "read_file", arguments: { path: `file-${step}-a` } },
      { id: `c${step}b`, name: "read_file", arguments: { path: `file-${step}-b` } }] });
    for (const side of ["a", "b"]) messages.push({ role: "tool", callId: `c${step}${side}`, name: "read_file",
      result: { isError: false, content: [{ type: "text", text: `RESULT-${step}-${side} ${"r".repeat(200 + (step * 97 + (side === "a" ? 0 : 451)) % 1300)}` }] } });
  }
  const requests: ProviderRequest[] = [];
  const provider = fake(async (request) => { requests.push(request); return turn(`checkpoint ${requests.length}`); });
  (provider.modelConfig as { contextWindow?: number }).contextWindow = contextWindow;
  const work = await summarizeTranscript(messages, provider,
    { maxOutputTokens: 1500, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
  assert.equal(work.status, "summarized");
  assert.ok(requests.length >= 3, `requests: ${requests.length}`);
  const margin = Math.max(64, Math.ceil(contextWindow * 0.05));
  for (const [index, request] of requests.entries()) {
    assert.ok(estimateRequestTokens(request.system, request.messages, request.tools) + request.maxOutputTokens! + margin <= contextWindow);
    const content = userText(request);
    for (let step = 0; step < 40; step++) for (const side of ["a", "b"]) {
      assert.equal(content.includes(`RESULT-${step}-${side} `), content.includes(`TOOL CALL read_file({"path":"file-${step}-${side}"})`), `step ${step}${side}`);
    }
    if (index > 0) assert.ok(content.includes(`<prior-checkpoint>\ncheckpoint ${index}\n</prior-checkpoint>`));
    else assert.ok(!content.includes("<prior-checkpoint>"));
  }
  for (let step = 0; step < 40; step++) assert.equal(requests.filter((request) => userText(request).includes(`RESULT-${step}-a `)).length, 1);
  assert.equal(work.status === "summarized" && work.summary, `checkpoint ${requests.length}`);
});

test("summarizer overhead lowers the output budget, and throws CompactionOverheadError when even that does not fit", async () => {
  const contextWindow = 9000;
  const margin = Math.max(64, Math.ceil(contextWindow * 0.05));
  const base = estimateRequestTokens(COMPACT_SYSTEM_PROMPT, [{ role: "user", content: checkpointPrompt({ words: 1229, prior: "" }) }], []);
  const run = async (priorTokens: number) => {
    const previousSummary = "p".repeat(priorTokens * 2);
    const requests: ProviderRequest[] = [];
    const provider = fake(async (request) => { requests.push(request); return turn("merged checkpoint"); });
    (provider.modelConfig as { contextWindow?: number }).contextWindow = contextWindow;
    const messages: ModelMessage[] = [{ role: "user", content: "task" }, { role: "user", content: `[Conversation summary]\n${previousSummary}` },
      { role: "user", content: "next" }, { role: "assistant", text: "done", toolCalls: [] }];
    const work = await summarizeTranscript(messages.slice(2), provider,
      { prior: previousSummary, maxOutputTokens: 2048, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
    return { work, requests };
  };
  // Room for about 1,500 output tokens: the configured 2,048 does not fit, the lowered budget does.
  const { work, requests } = await run(contextWindow - margin - base - 1500 - 60);
  assert.equal(work.status, "summarized");
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.maxOutputTokens! < 2048 && requests[0]!.maxOutputTokens! >= 1024, `budget ${requests[0]!.maxOutputTokens}`);
  assert.equal(requests[0]!.maxOutputTokensAssumed, true);
  assert.ok(userText(requests[0]!).includes(`Use up to about ${checkpointWords(requests[0]!.maxOutputTokens!)} words.`));
  await assert.rejects(run(contextWindow - margin - base - 500), CompactionOverheadError);
});

test("the <analysis> notes never reach the stored checkpoint, and notes alone are an empty summary", async () => {
  const kept = await seededAgent();
  const result = await compactSession(kept.agent, { provider: fake(async () => turn("<analysis>\n1. secret-notes\n</analysis>\n## Goal\nfinish the task")) });
  assert.equal(result.status, "compacted");
  const stored = JSON.stringify(kept.agent.transcript);
  assert.ok(stored.includes("## Goal\\nfinish the task") && !stored.includes("secret-notes") && !stored.includes("<analysis>"));
  for (const output of ["<analysis>only notes</analysis>", "<analysis>notes cut off at the limit"]) {
    const seeded = await seededAgent();
    const before = JSON.stringify(seeded.agent.transcript);
    await assert.rejects(compactSession(seeded.agent, { provider: fake(async () => turn(output)) }), /empty summary/);
    assert.equal(JSON.stringify(seeded.agent.transcript), before);
  }
});

test("a step too large for a chunk is cut to fit, and becomes a one-line record when even that does not fit", async () => {
  const contextWindow = 9000;
  const compactStep = async (calls: number) => {
    const messages: ModelMessage[] = [{ role: "user", content: "task" }, { role: "assistant", text: "batch", toolCalls:
      Array.from({ length: calls }, (_, index) => ({ id: `c${index}`, name: "grep", arguments: { pattern: `p${index}` } })) }];
    for (let index = 0; index < calls; index++) messages.push({ role: "tool", callId: `c${index}`, name: "grep",
      result: { isError: false, content: [{ type: "text", text: `START-${index} ${"g".repeat(3000)} END-${index}` }], fullOutputPath: `/saved/${index}.log` } });
    const requests: ProviderRequest[] = [];
    const provider = fake(async (request) => { requests.push(request); return turn(`checkpoint ${requests.length}`); });
    (provider.modelConfig as { contextWindow?: number }).contextWindow = contextWindow;
    const work = await summarizeTranscript(messages, provider,
      { maxOutputTokens: 1024, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
    assert.equal(work.status, "summarized");
    return requests.map(userText);
  };
  const cut = (await compactStep(4)).join("\n");
  assert.ok(cut.includes("START-3") && cut.includes("END-3") && cut.includes("full output: /saved/3.log") && !cut.includes("g".repeat(2500)));
  const oneLine = (await compactStep(60)).join("\n");
  assert.match(oneLine, /\[Step shortened to fit the summarizer: ASSISTANT 5 bytes of text; TOOL CALL grep\(\{"pattern":"p0"\}\)/);
  assert.ok(oneLine.includes("TOOL RESULT grep: 3016 bytes, full output: /saved/59.log"));
});

test("review fixes: thinking-budget floor, user text that looks like a summary, and one-line records name saved copies", async () => {
  const contextWindow = 9000;
  const margin = Math.max(64, Math.ceil(contextWindow * 0.05));
  const base = estimateRequestTokens(COMPACT_SYSTEM_PROMPT, [{ role: "user", content: checkpointPrompt({ words: 1229, prior: "" }) }], []);
  // A lowered budget never goes below a manual Anthropic thinking budget: it stays above it or the compaction fails.
  const lowered = async (roomTokens: number) => {
    const previousSummary = "p".repeat((contextWindow - margin - base - roomTokens - 60) * 2);
    const requests: ProviderRequest[] = [];
    const provider: ProviderAdapter = { modelConfig: { agentName: "claude", provider: "anthropic", method: "anthropic-messages", model: "fixture",
      contextWindow, request: { kind: "anthropic", thinking: { type: "enabled", budgetTokens: 1800 } } },
    generate: async (request) => { requests.push(request); return turn("merged"); } };
    const messages: ModelMessage[] = [{ role: "user", content: "task" }, { role: "user", content: `[Conversation summary]\n${previousSummary}` },
      { role: "user", content: "next" }, { role: "assistant", text: "done", toolCalls: [] }];
    await summarizeTranscript(messages.slice(2), provider,
      { prior: previousSummary, maxOutputTokens: 2048, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
    return requests;
  };
  const fitting = await lowered(1950);
  assert.ok(fitting[0]!.maxOutputTokens! > 1800 && fitting[0]!.maxOutputTokens! < 2048, `budget ${fitting[0]!.maxOutputTokens}`);
  await assert.rejects(lowered(1500), CompactionOverheadError);

  // The prior checkpoint is merged as <prior-checkpoint>; a user message with the old summary's opening stays a user message.
  const requests: ProviderRequest[] = [];
  const provider = fake(async (request) => { requests.push(request); return turn("merged"); });
  const echoed = `[Conversation summary]\nuser-pasted-${Math.random()}`;
  await summarizeTranscript([{ role: "user", content: echoed }, { role: "assistant", text: "noted", toolCalls: [] }], provider,
  { prior: "old summary", maxOutputTokens: 1000, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test" });
  const sent = userText(requests[0]!);
  assert.ok(sent.includes(`USER:\n${echoed}`));
  assert.equal(sent.split("old summary").length - 1, 1);
  assert.ok(sent.includes("<prior-checkpoint>\nold summary\n</prior-checkpoint>"));

  // Small results omitted by a one-line record get saved copies first, so the record still says where to re-read them.
  const step: ModelMessage[] = [{ role: "user", content: "task" }, { role: "assistant", text: "batch", toolCalls:
    Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, name: "stat", arguments: { index } })) }];
  for (let index = 0; index < 60; index++) step.push({ role: "tool", callId: `s${index}`, name: "stat",
    result: { isError: false, content: [{ type: "text", text: `SMALL-${index} ${"s".repeat(190)}` }] } });
  const copies: string[] = [];
  const oneLine: ProviderRequest[] = [];
  const small = fake(async (request) => { oneLine.push(request); return turn("checkpoint"); });
  (small.modelConfig as { contextWindow?: number }).contextWindow = contextWindow;
  await summarizeTranscript(step, small, { maxOutputTokens: 1024, timeoutMs: 1000,
    signal: new AbortController().signal, cacheKey: "test", saveCopy: (text: string) => { copies.push(text); return `/copies/${copies.length}`; } });
  const record = oneLine.map(userText).join("\n");
  assert.match(record, /\[Step shortened to fit the summarizer: /);
  assert.equal(copies.length, 60);
  assert.ok(copies.every((text, index) => text.startsWith(`SMALL-${index} `)));
  assert.ok(record.includes("TOOL RESULT stat: 198 bytes, full output: /copies/1;") && record.includes("full output: /copies/60]"));
});

test("a one-line record whose saved paths are longer than sized is never sent over budget", async () => {
  const contextWindow = 9000;
  for (let results = 20; results <= 45; results++) {
    const step: ModelMessage[] = [{ role: "user", content: "task" }, { role: "assistant", text: "batch", toolCalls:
      Array.from({ length: results }, (_, index) => ({ id: `s${index}`, name: "stat", arguments: { index } })) }];
    for (let index = 0; index < results; index++) step.push({ role: "tool", callId: `s${index}`, name: "stat",
      result: { isError: false, content: [{ type: "text", text: `R-${index} ${"s".repeat(3000)}` }] } });
    const requests: ProviderRequest[] = [];
    const provider = fake(async (request) => { requests.push(request); return turn("checkpoint"); });
    (provider.modelConfig as { contextWindow?: number }).contextWindow = contextWindow;
    let saved = 0;
    const work = summarizeTranscript(step, provider, { maxOutputTokens: 1024,
      timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "test", saveCopy: () => `/ü${saved++}/${"ü".repeat(300)}` });
    const margin = Math.max(64, Math.ceil(contextWindow * 0.05));
    try { await work; } catch (error) { assert.ok(error instanceof CompactionOverheadError, String(error)); }
    for (const request of requests) {
      assert.ok(estimateRequestTokens(request.system, request.messages, request.tools) + request.maxOutputTokens! + margin <= contextWindow);
    }
  }
});
