import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type AgentOptions } from "../src/agent.js";
import { COMPACT_SYSTEM_PROMPT, estimateRequestTokens, resultText, textTokens } from "../src/compact.js";
import { loadConfig } from "../src/config.js";
import { clearToolResults, CLEAR_MIN_FREED_TOKENS, namedByReminder } from "../src/context-clearing.js";
import type { InteractionAdapter } from "../src/interactions/contract.js";
import { createProvider } from "../src/llm/client.js";
import { effectiveInputBudget } from "../src/llm/context.js";
import { effectiveOutputTokens } from "../src/llm/output.js";
import type { ModelMessage, ProviderAdapter, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { storedAcpUpdates } from "../src/sessions/display.js";
import { openSessionStore } from "../src/sessions/store.js";
import { renderTerminalHistory } from "../src/terminal/history.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { setSpillTotalBytesForTests, SPILL_TOTAL_BYTES } from "../src/tools/spill.js";
import type { ToolResult } from "../src/tools/types.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { anthropicFrame, startMockProvider } from "./fixtures/mock-provider.js";

const noise = (bytes: number) => randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes);
const stop = (text: string): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop" });
const probe = (id: string, pad: number): ProviderTurn =>
  ({ text: "", toolCalls: [{ id, name: "probe", arguments: { out: id, pad } }], finishReason: "tool_calls" });
const STUB = /^\[Old tool result cleared: /;
const isStub = (message: ModelMessage | undefined) => message?.role === "tool" && STUB.test(resultText(message.result));

function sessionStore() {
  const root = mkdtempSync(join(tmpdir(), "raw-context-clearing-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "clearing" }).id;
  return { root, store, id };
}

/** Test tools: `probe` returns its `out` then `pad` bytes; `load_skill` stands in for the bundled one; `ask_user` is bundled. */
async function tools(answers: string[] = []) {
  const registry = createTestToolRegistry();
  registry.register({ name: "probe", description: "probe", inputSchema: { type: "object", properties: { out: { type: "string" }, pad: { type: "integer" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: `${String(args.out ?? "")}${"r".repeat(Number(args.pad ?? 0))}` }] }) });
  registry.register({ name: "load_skill", canonicalName: "builtin/load_skill", description: "skill", inputSchema: { type: "object", properties: {} },
    handler: async () => ({ isError: false, content: [{ type: "text", text: `skill body ${"s".repeat(6000)}` }] }) });
  for (const tool of await loadBundledTools(["ask_user"])) registry.register(tool);
  const interactionAdapter: InteractionAdapter = async (request) => ({ requestId: request.identity.requestId, expectedRevision: request.revision,
    idempotencyKey: randomUUID(), response: "submit", answers: { q: answers.shift() ?? "" } });
  return { registry, interactionAdapter };
}

/** `usageRatio`: each reply reports that share of the request's byte estimate as its input tokens. */
function scripted(model: Partial<ResolvedModelConfig>, script: ProviderTurn[], usageRatio?: number) {
  const main: ModelMessage[][] = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", ...model },
    async generate(request) {
      if (request.system === COMPACT_SYSTEM_PROMPT) return stop("## Goal\nunused");
      main.push(structuredClone(request.messages) as ModelMessage[]);
      const turn = script.shift() ?? stop("done");
      return usageRatio === undefined ? turn : { ...turn, usage: { completion_tokens: 10,
        prompt_tokens: Math.ceil(usageRatio * estimateRequestTokens(request.system, request.messages, request.tools ?? [])) } };
    } };
  return { provider, main };
}

const wide: Partial<ResolvedModelConfig> = { contextWindow: 200000, maxOutputTokens: 1000 };
const budgetOf = (model: Partial<ResolvedModelConfig>) =>
  effectiveInputBudget(model.contextWindow!, effectiveOutputTokens(model as ResolvedModelConfig));

/** One turn: an ask_user answer, a load_skill result, a small probe, then `probes` probe results of `pad` bytes. */
async function clearingRun(options: { model?: Partial<ResolvedModelConfig>; probes: number; pad: number; keepRecentTokens: number; clearTokens?: number | null;
  usageRatio?: number }) {
  const model = options.model ?? wide;
  const budget = budgetOf(model);
  const { root, store, id } = sessionStore();
  const answer = `answer-${noise(3000)}`;
  const { registry, interactionAdapter } = await tools([answer]);
  const script: ProviderTurn[] = [
    { text: "", toolCalls: [{ id: "ask-1", name: "ask_user", arguments: { questions: [{ id: "q", label: "Q", kind: "text" }] } }], finishReason: "tool_calls" },
    { text: "", toolCalls: [{ id: "skill-1", name: "load_skill", arguments: {} }], finishReason: "tool_calls" },
    probe("small", 1000),
    ...Array.from({ length: options.probes }, (_, index) => probe(`p${index}`, options.pad)),
  ];
  const { provider, main } = scripted(model, script, options.usageRatio);
  const clearTokens = options.clearTokens === undefined ? Math.floor(0.6 * budget) : options.clearTokens;
  const agentOptions: Partial<AgentOptions> = { registry, interactionAdapter, maxSteps: 100, whitelist: ["probe", "ask_user", "load_skill"],
    compact: { keepRecentTurns: 2, keepRecentTokens: options.keepRecentTokens, maxOutputTokens: 1000, triggerTokens: Math.floor(0.95 * budget),
      ...(clearTokens === null ? {} : { clearTokens }) } };
  const agent = createAgent({ cwd: root, provider, system: "tiny", autoApprove: true, ...agentOptions, persistence: { store, sessionId: id, surface: "cli" } });
  const result = await agent.run("go");
  return { root, store, id, agent, main, answer, budget, clearTokens, result, agentOptions, provider };
}

test("1: clearing starts at clear_tokens, clears the oldest eligible results until 45%, and spares the tail and exempt results", async () => {
  // Scenario A: a short tail, so the target is reached part way through the eligible results.
  {
    const run = await clearingRun({ probes: 15, pad: 16000, keepRecentTokens: 12000 });
    try {
      assert.equal(run.result.status, "completed");
      const records = run.store.getSessionHistory({ sessionId: run.id, limit: 100 }).items.filter((item) => item.kind === "context_clearing");
      assert.equal(records.length, 1);
      const payload = records[0]!.payload as { beforeTokens: number; afterTokens: number; freedTokens: number; results: Array<{ callId: string }> };
      assert.ok(payload.beforeTokens >= run.clearTokens!, `cleared at ${payload.beforeTokens}`);
      assert.ok(payload.afterTokens <= 0.45 * run.budget, `down to ${payload.afterTokens}`);
      assert.ok(payload.freedTokens >= CLEAR_MIN_FREED_TOKENS);
      const transcript = run.agent.transcript;
      const tool = (callId: string) => transcript.find((message) => message.role === "tool" && message.callId === callId);
      // Oldest first: a prefix of the large probe results is cleared, no more than the target needs.
      const cleared = Array.from({ length: 15 }, (_, index) => isStub(tool(`p${index}`)));
      const count = cleared.filter(Boolean).length;
      assert.ok(count > 0 && count < 15);
      assert.deepEqual(cleared, cleared.map((_value, index) => index < count));
      assert.deepEqual(payload.results.map((item) => item.callId), Array.from({ length: count }, (_, index) => `p${index}`));
      assert.ok(payload.beforeTokens - payload.freedTokens + 8000 > 0.45 * run.budget, "one fewer result would not have reached the target");
      for (const exempt of ["ask-1", "skill-1", "small"]) assert.ok(!isStub(tool(exempt)), exempt);
      assert.ok(resultText((tool("ask-1") as Extract<ModelMessage, { role: "tool" }>).result).includes(run.answer));
      // The next request is built from the cleared context.
      assert.ok(run.main.some((messages) => messages.some((message) => isStub(message))));
    } finally { await run.agent.close(); run.store.close(); }
  }
  // Scenario B: a long tail, so every eligible result before it is cleared and none inside it.
  {
    const run = await clearingRun({ probes: 15, pad: 16000, keepRecentTokens: 90000 });
    try {
      const transcript = run.agent.transcript;
      const tool = (callId: string) => transcript.find((message) => message.role === "tool" && message.callId === callId);
      const records = run.store.getSessionHistory({ sessionId: run.id, limit: 100 }).items.filter((item) => item.kind === "context_clearing");
      assert.equal(records.length, 1);
      const payload = records[0]!.payload as { results: Array<{ callId: string }>; afterTokens: number };
      const cleared = new Set(payload.results.map((item) => item.callId));
      assert.ok(payload.afterTokens > 0.45 * run.budget, "the tail kept the context above the target");
      const flags = Array.from({ length: 15 }, (_, index) => isStub(tool(`p${index}`)));
      const count = flags.filter(Boolean).length;
      assert.ok(count > 0 && count < 15);
      assert.deepEqual(flags, flags.map((_value, index) => index < count));
      assert.deepEqual([...cleared], Array.from({ length: count }, (_, index) => `p${index}`));
    } finally { await run.agent.close(); run.store.close(); }
  }
  // Scenario C: the provider reports fewer tokens than the byte estimate, so the threshold is crossed on a size anchored to
  // that report. The replacement drops the anchor, so the target is reached on the estimate the next request uses.
  {
    const run = await clearingRun({ probes: 26, pad: 16000, keepRecentTokens: 12000, usageRatio: 0.6 });
    try {
      const records = run.store.getSessionHistory({ sessionId: run.id, limit: 100 }).items.filter((item) => item.kind === "context_clearing");
      assert.ok(records.length >= 1);
      const payload = records[0]!.payload as { beforeTokens: number; afterTokens: number };
      assert.ok(payload.beforeTokens > 0.8 * run.budget, `measured at ${payload.beforeTokens} without the anchor`);
      assert.ok(payload.afterTokens <= 0.45 * run.budget, `down to ${payload.afterTokens}`);
    } finally { await run.agent.close(); run.store.close(); }
  }
});

test("2: clearing that would free less than the minimum changes nothing", async () => {
  // A 100k window: clearing from 60% to 45% frees about 14k tokens, under the 20k minimum.
  const run = await clearingRun({ model: { contextWindow: 100000, maxOutputTokens: 1000 }, probes: 24, pad: 4000, keepRecentTokens: 1000 });
  try {
    assert.equal(run.result.status, "completed");
    const transcript = run.agent.transcript;
    assert.ok(run.agent.estimatedContextTokens() >= run.clearTokens!, "the estimate crossed clear_tokens");
    assert.ok(!transcript.some((message) => isStub(message)));
    assert.equal(run.store.getSessionHistory({ sessionId: run.id, limit: 100 }).items.filter((item) => item.kind === "context_clearing").length, 0);
  } finally { await run.agent.close(); run.store.close(); }
});

test("3: a result is cleared only with a secured, byte-identical copy", () => {
  const directory = mkdtempSync(join(tmpdir(), "raw-clearing-copies-"));
  const call = (id: string): ModelMessage => ({ role: "assistant", text: "", toolCalls: [{ id, name: "probe", arguments: { out: id } }] });
  const result = (id: string, text: string, extra: Partial<ToolResult> = {}): ModelMessage =>
    ({ role: "tool", callId: id, name: "probe", result: { isError: false, content: [{ type: "text", text }], ...extra } });
  const valid = join(directory, "valid.log");
  const full = `full output ${noise(9000)}`;
  writeFileSync(valid, full);
  const mismatched = join(directory, "mismatched.log");
  writeFileSync(mismatched, "short");
  const unreadable = join(directory, "unreadable.log");
  writeFileSync(unreadable, full);
  chmodSync(unreadable, 0o000);
  const deleted = join(directory, "deleted.log");
  writeFileSync(deleted, full);
  rmSync(deleted);
  const texts = { plain: `plain ${noise(5000)}`, deleted: `deleted ${noise(5000)}`, mismatched: `mismatched ${noise(5000)}`, valid: `valid ${noise(5000)}`,
    capped: `capped ${noise(5000)}`, unreadable: `unreadable ${noise(5000)}`, folder: `folder ${noise(5000)}` };
  const messages: ModelMessage[] = [{ role: "user", content: "go" },
    call("plain"), result("plain", texts.plain),
    call("deleted"), result("deleted", texts.deleted, { fullOutputPath: deleted, truncated: true, observedBytes: Buffer.byteLength(full) }),
    call("mismatched"), result("mismatched", texts.mismatched, { fullOutputPath: mismatched, truncated: true, observedBytes: Buffer.byteLength(full) }),
    call("valid"), result("valid", texts.valid, { fullOutputPath: valid, truncated: true, observedBytes: Buffer.byteLength(full) }),
    call("capped"), result("capped", texts.capped, { fullOutputPath: valid, fullOutputCapped: true, truncated: true, observedBytes: Buffer.byteLength(full) }),
    call("unreadable"), result("unreadable", texts.unreadable, { fullOutputPath: unreadable, truncated: true, observedBytes: Buffer.byteLength(full) }),
    call("folder"), result("folder", texts.folder, { fullOutputPath: directory, truncated: true, observedBytes: statSync(directory).size }),
    { role: "assistant", text: "done", toolCalls: [] }];
  const options = { protectedFrom: messages.length, currentTokens: 1_000_000, targetTokens: 0, minFreedTokens: 0,
    messageTokens: (message: ModelMessage) => textTokens(JSON.stringify(message)) };
  const outcome = clearToolResults(messages, options)!;
  assert.equal(outcome.cleared.length, 7);
  const path = (callId: string) => outcome.cleared.find((item) => item.callId === callId)!.path;
  // A new copy holds exactly what the context held; a usable full output is named instead.
  for (const callId of ["plain", "deleted", "mismatched", "capped", "unreadable", "folder"] as const) {
    assert.notEqual(path(callId), valid);
    assert.equal(readFileSync(path(callId), "utf8"), texts[callId], callId);
  }
  assert.equal(path("deleted") === deleted, false);
  assert.equal(path("valid"), valid);
  assert.equal(readFileSync(path("valid"), "utf8"), full);
  // Stubs name the path, the size and the best-effort retention; assistant messages are untouched.
  const stub = outcome.messages.find((message) => message.role === "tool" && message.callId === "plain")!;
  assert.equal(resultText((stub as Extract<ModelMessage, { role: "tool" }>).result),
    `[Old tool result cleared: probe {"out":"plain"}, ${Buffer.byteLength(texts.plain)} bytes; full output: ${path("plain")} (saved copy, normally kept 7 days; may be removed earlier when saved outputs exceed their disk limit)]`);
  assert.deepEqual(outcome.messages.filter((message) => message.role !== "tool"), messages.filter((message) => message.role !== "tool"));
  assert.notEqual(path("unreadable"), unreadable);
  assert.notEqual(path("folder"), directory);
  // Without room for a copy, nothing is cleared.
  setSpillTotalBytesForTests(1000);
  try {
    assert.equal(clearToolResults(messages.slice(0, 3).concat(messages.at(-1)!), options), undefined);
  } finally { setSpillTotalBytesForTests(SPILL_TOTAL_BYTES); }
});

test("3b: a panel reminder protects a result it names by call ID, saved full output, or a batch row's saved output", () => {
  const tool = (callId: string, extra: Partial<ToolResult> = {}, rows?: unknown[]): Extract<ModelMessage, { role: "tool" }> => ({ role: "tool", callId, name: "probe",
    result: { isError: false, content: rows ? [{ type: "json", value: { results: rows } }] : [{ type: "text", text: "x" }], ...extra } });
  const reminders = ["[Raw panel state]\nCurrent state of Notes: see call-7 and /tmp/raw/top.log and /tmp/raw/row-2.log"];
  assert.equal(namedByReminder(tool("call-7"), reminders), true);
  assert.equal(namedByReminder(tool("other", { fullOutputPath: "/tmp/raw/top.log" }), reminders), true);
  assert.equal(namedByReminder(tool("other", {}, [{ full_output: "/tmp/raw/row-1.log" }, { full_output: "/tmp/raw/row-2.log" }]), reminders), true);
  assert.equal(namedByReminder(tool("other", { fullOutputPath: "/tmp/raw/else.log" }, [{ full_output: "/tmp/raw/row-1.log" }]), reminders), false);
  assert.equal(namedByReminder(tool("call-7"), []), false);
});

test("3c: the cleared context is measured whole, so a request that admits more once text shrinks clears further", () => {
  const call = (id: string): ModelMessage => ({ role: "assistant", text: "", toolCalls: [{ id, name: "probe", arguments: { out: id } }] });
  const result = (id: string): ModelMessage => ({ role: "tool", callId: id, name: "probe", result: { isError: false, content: [{ type: "text", text: `${id} ${noise(5000)}` }] } });
  const messages: ModelMessage[] = [{ role: "user", content: "go" }, ...["a", "b", "c", "d"].flatMap((id) => [call(id), result(id)]),
    { role: "assistant", text: "done", toolCalls: [] }];
  const messageTokens = (message: ModelMessage) => textTokens(JSON.stringify(message));
  // Stands in for image admission: once the first result is a stub, the request admits an image worth 1000 tokens.
  const measure = (list: readonly ModelMessage[]) => list.reduce((sum, message) => sum + messageTokens(message), 0) + (isStub(list[2]) ? 1000 : 0);
  const current = measure(messages);
  // Per message, clearing the first two results reaches the target exactly.
  const base = { protectedFrom: messages.length - 1, currentTokens: current, minFreedTokens: 0, messageTokens };
  const first = clearToolResults(messages, { ...base, targetTokens: current - 1 })!.freedTokens;
  const target = current - clearToolResults(messages, { ...base, targetTokens: current - first - 1 })!.freedTokens;
  const options = { ...base, targetTokens: target, measure };
  const outcome = clearToolResults(messages, options)!;
  assert.deepEqual(outcome.cleared.map((item) => item.callId), ["a", "b", "c"], "the third result makes up for the admitted image");
  assert.equal(outcome.freedTokens, current - measure(outcome.messages));
  assert.ok(measure(outcome.messages) <= target);
  // The minimum is checked on the measured size too.
  const all = clearToolResults(messages, { ...options, targetTokens: 0 })!;
  assert.equal(all.cleared.length, 4);
  assert.equal(clearToolResults(messages, { ...options, targetTokens: 0, minFreedTokens: all.freedTokens + 1 }), undefined);
});

/** Anthropic SSE frames for one response: a signed thinking block, then text or tool calls. */
function anthropicMessage(index: number, signature: string, body: { text?: string; calls?: Array<{ id: string; pad: number }> }) {
  const blocks: string[] = [
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: `thought ${signature}` } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
    anthropicFrame("content_block_stop", { index: 0 }),
  ];
  if (body.text !== undefined) blocks.push(anthropicFrame("content_block_start", { index: 1, content_block: { type: "text", text: body.text } }), anthropicFrame("content_block_stop", { index: 1 }));
  for (const [offset, call] of (body.calls ?? []).entries()) {
    blocks.push(anthropicFrame("content_block_start", { index: 1 + offset, content_block: { type: "tool_use", id: call.id, name: "probe", input: {} } }),
      anthropicFrame("content_block_delta", { index: 1 + offset, delta: { type: "input_json_delta", partial_json: JSON.stringify({ out: call.id, pad: call.pad }) } }),
      anthropicFrame("content_block_stop", { index: 1 + offset }));
  }
  return { frames: [
    anthropicFrame("message_start", { message: { id: `m${index}`, type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    ...blocks,
    anthropicFrame("message_delta", { delta: { stop_reason: body.calls ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ] };
}

/**
 * Four thinking steps: a parallel batch of two 41 KB results, then three single 41 KB results. Before the fifth request the
 * estimate passes clear_tokens, and clearing the first result of the batch alone reaches the 45% target.
 */
async function anthropicClearing(rejectAfterClearing: boolean) {
  const { root, store, id } = sessionStore();
  const { registry } = await tools();
  const steps = [
    anthropicMessage(1, "sig-1", { calls: [{ id: "b1", pad: 41000 }, { id: "b2", pad: 41000 }] }),
    anthropicMessage(2, "sig-2", { calls: [{ id: "c3", pad: 41000 }] }),
    anthropicMessage(3, "sig-3", { calls: [{ id: "c4", pad: 41000 }] }),
    anthropicMessage(4, "sig-4", { calls: [{ id: "c5", pad: 41000 }] }),
    ...(rejectAfterClearing ? [{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block" } } }] : []),
    anthropicMessage(5, "sig-5", { text: "done" }),
    anthropicMessage(6, "sig-6", { calls: [{ id: "n1", pad: 10 }] }),
    anthropicMessage(7, "sig-7", { text: "later" }),
  ];
  const fixture = await startMockProvider(steps);
  const model: ResolvedModelConfig = { agentName: "claude", provider: "anthropic", method: "anthropic-messages", model: "fixture", baseUrl: fixture.url,
    apiKey: "fixture", maxOutputTokens: 1000, contextWindow: 200000 };
  const budget = budgetOf(model);
  const options: Partial<AgentOptions> = { registry, maxSteps: 20, whitelist: ["probe"],
    compact: { keepRecentTurns: 2, keepRecentTokens: 1000, maxOutputTokens: 1000, triggerTokens: Math.floor(0.95 * budget), clearTokens: 100000 } };
  const agent = createAgent({ cwd: root, provider: createProvider(model), system: "tiny", autoApprove: true, ...options, persistence: { store, sessionId: id, surface: "cli" } });
  return { root, store, id, agent, fixture, model, options };
}

const assistants = (messages: readonly ModelMessage[]) => messages.filter((message) => message.role === "assistant");

test("4: a reasoning rejection after clearing retries with history projected, and a restart keeps the boundary", async () => {
  const run = await anthropicClearing(true);
  try {
    const result = await run.agent.run("go");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
    const transcript = run.agent.transcript;
    assert.ok(isStub(transcript.find((message) => message.role === "tool" && message.callId === "b1")), "the first result of the batch is cleared");
    assert.ok(!isStub(transcript.find((message) => message.role === "tool" && message.callId === "b2")), "its sibling is not");
    const rejected = JSON.stringify(run.fixture.requests[4]!.body);
    assert.match(rejected, /sig-1/, "the request after clearing replayed reasoning natively");
    assert.match(rejected, /Old tool result cleared: probe/);
    const retry = JSON.stringify(run.fixture.requests[5]!.body);
    assert.doesNotMatch(retry, /"signature"|sig-1|sig-4/, "the retry projects every earlier message");
    await run.agent.close();
    const owner = run.store.claimSession(run.id);
    const saved = run.store.readAgentState(run.id, owner);
    run.store.releaseSession(run.id, owner);
    assert.equal(saved.replayBefore, transcript.length - 1, "the boundary covers the messages the rejected request was built from");
    const resumed = createAgent({ cwd: run.root, provider: createProvider(run.model), system: "tiny", autoApprove: true, ...run.options,
      persistence: { store: run.store, sessionId: run.id, surface: "cli" } });
    try {
      assert.equal((await resumed.run("again")).text, "later");
      const first = JSON.stringify(run.fixture.requests[6]!.body);
      assert.doesNotMatch(first, /sig-1|sig-4/, "a restart keeps the projection");
      const next = JSON.stringify(run.fixture.requests[7]!.body);
      assert.match(next, /sig-6/, "new steps replay natively");
    } finally { await resumed.close(); }
  } finally { await run.agent.close(); run.store.close(); await run.fixture.close(); }
});

test("5: reasoning around cleared results is kept unchanged, sent natively, and survives a restart", async () => {
  // Anthropic, end to end: the provider accepts the request after clearing.
  {
    const run = await anthropicClearing(false);
    try {
      const result = await run.agent.run("go");
      assert.equal(result.text, "done");
      const transcript = run.agent.transcript;
      assert.ok(isStub(transcript.find((message) => message.role === "tool" && message.callId === "b1")));
      const sent = JSON.stringify(run.fixture.requests[4]!.body);
      for (const signature of ["sig-1", "sig-2", "sig-3", "sig-4"]) assert.match(sent, new RegExp(signature), signature);
      const reasoning = assistants(transcript).slice(0, 4);
      await run.agent.close();
      const resumed = createAgent({ cwd: run.root, provider: createProvider(run.model), system: "tiny", autoApprove: true, ...run.options,
        persistence: { store: run.store, sessionId: run.id, surface: "cli" } });
      try {
        assert.deepEqual(assistants(resumed.transcript).slice(0, 4), reasoning, "a restart keeps the assistant messages");
        await resumed.run("again");
        assert.match(JSON.stringify(run.fixture.requests[5]!.body), /sig-1/, "and they are still sent natively");
      } finally { await resumed.close(); }
    } finally { await run.agent.close(); run.store.close(); await run.fixture.close(); }
  }
  // Responses reasoning items: deep-equal before and after clearing and after a restart, and sent unchanged.
  {
    const { root, store, id } = sessionStore();
    const { registry } = await tools();
    const model = { method: "openai-responses" as const, provider: "openai", ...wide };
    const budget = budgetOf(model);
    const opaque = (callId: string) => [{ type: "reasoning", id: `rs_${callId}`, summary: [], encrypted_content: `enc-${callId}-${noise(16)}` },
      { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "probe", arguments: JSON.stringify({ out: callId, pad: 41000 }) }];
    const step = (callId: string): ProviderTurn => ({ text: "", finishReason: "tool_calls", opaque: opaque(callId),
      toolCalls: [{ id: callId, name: "probe", arguments: { out: callId, pad: 41000 } }] });
    const { provider, main } = scripted(model, ["r1", "r2", "r3", "r4", "r5"].map(step));
    const options: Partial<AgentOptions> = { registry, maxSteps: 20, whitelist: ["probe"],
      compact: { keepRecentTurns: 2, keepRecentTokens: 1000, maxOutputTokens: 1000, triggerTokens: Math.floor(0.95 * budget), clearTokens: 100000 } };
    const agent = createAgent({ cwd: root, provider, system: "tiny", autoApprove: true, ...options, persistence: { store, sessionId: id, surface: "cli" } });
    try {
      await agent.run("go");
      const transcript = agent.transcript;
      assert.ok(isStub(transcript.find((message) => message.role === "tool" && message.callId === "r1")));
      const reasoning = assistants(transcript).filter((message) => message.role === "assistant" && message.opaque !== undefined);
      assert.equal(reasoning.length, 5);
      const sent = main.find((messages) => messages.some((message) => isStub(message)))!;
      assert.deepEqual(assistants(sent).filter((message) => message.role === "assistant" && message.opaque !== undefined), reasoning.slice(0, assistants(sent).length));
      await agent.close();
      const resumed = createAgent({ cwd: root, provider, system: "tiny", autoApprove: true, ...options, persistence: { store, sessionId: id, surface: "cli" } });
      try {
        assert.deepEqual(assistants(resumed.transcript).filter((message) => message.role === "assistant" && message.opaque !== undefined), reasoning);
      } finally { await resumed.close(); }
    } finally { await agent.close(); store.close(); }
  }
});

test("6: clearing is durable and leaves visible history unchanged", async () => {
  const run = await clearingRun({ probes: 15, pad: 16000, keepRecentTokens: 12000 });
  const history = run.store.getSessionHistory({ sessionId: run.id, limit: 100 }).items;
  const stubs = run.agent.transcript.filter((message) => isStub(message)).map((message) => message.role === "tool" ? message.callId : "");
  assert.ok(stubs.length > 0);
  await run.agent.close();
  // The copies are saved outputs in the working state, so they outlive the stubs that name them.
  const owner = run.store.claimSession(run.id);
  const outputs = run.store.readAgentState(run.id, owner).ledger?.facts.outputs ?? [];
  run.store.releaseSession(run.id, owner);
  const paths = (history.find((entry) => entry.kind === "context_clearing")!.payload as { results: Array<{ path: string }> }).results.map((item) => item.path);
  for (const path of paths) assert.ok(outputs.includes(path), path);
  const resumed = createAgent({ cwd: run.root, provider: run.provider, system: "tiny", autoApprove: true, ...run.agentOptions,
    persistence: { store: run.store, sessionId: run.id, surface: "cli" } });
  try {
    assert.deepEqual(resumed.transcript.filter((message) => isStub(message)).map((message) => message.role === "tool" ? message.callId : ""), stubs);
    // Tool result previews in history still show the original output.
    for (const callId of stubs) {
      const item = history.find((entry) => entry.kind === "tool_result" && JSON.stringify(entry.payload).includes(`"${callId}"`));
      assert.ok(item, callId);
      assert.doesNotMatch(JSON.stringify(item.payload), /Old tool result cleared/);
      assert.match(JSON.stringify(item.payload), new RegExp(callId));
    }
    assert.deepEqual(run.store.getSessionHistory({ sessionId: run.id, limit: 100 }).items, history);
    // Surfaces learn of the clearing only through its visible item.
    const record = history.find((entry) => entry.kind === "context_clearing")!;
    assert.match(renderTerminalHistory(record), new RegExp(`cleared ${stubs.length} old tool results to saved copies`));
    assert.match(JSON.stringify(storedAcpUpdates(record)), new RegExp(`Cleared ${stubs.length} old tool results`));
  } finally { await resumed.close(); run.store.close(); }
});

test("7: compact.clear_tokens defaults to 60% of the input budget, false disables it, and invalid values are rejected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raw-clear-config-"));
  const path = join(directory, "config.json");
  const load = async (context: number | undefined, compact: Record<string, unknown>) => {
    writeFileSync(path, JSON.stringify({ default_agent: "p",
      models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture", max_output_tokens: 1000,
        ...(context === undefined ? {} : { context_window_tokens: context }) } },
      agents: { p: { model: "m", tools: { use: ["builtin/read_file"] }, compact } } }));
    return (await loadConfig({ configPath: path, env: {}, requireModel: true })).compact.clearTokens;
  };
  // 200k context, 1000 output reserve, 10k margin: 60% of 189000.
  assert.equal(await load(200000, {}), 113400);
  assert.equal(await load(undefined, {}), undefined);
  assert.equal(await load(200000, { clear_tokens: false }), undefined);
  assert.equal(await load(200000, { clear_tokens: 90000 }), 90000);
  for (const value of [0, -1, 1.5, "x", true, null]) await assert.rejects(load(200000, { clear_tokens: value }), /clear_tokens/, String(value));
  await assert.rejects(load(undefined, { clear_tokens: 90000 }), /clear_tokens|context_window_tokens/);
  // With clearing off, a run past 60% leaves every result in place.
  const run = await clearingRun({ probes: 15, pad: 16000, keepRecentTokens: 12000, clearTokens: null });
  try { assert.ok(!run.agent.transcript.some((message) => isStub(message))); }
  finally { await run.agent.close(); run.store.close(); }
});
