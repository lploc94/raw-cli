import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAgent, type AgentOptions } from "../src/agent.js";
import { effectiveInputBudget } from "../src/llm/context.js";
import { effectiveOutputTokens } from "../src/llm/output.js";
import { collectFacts, COMPACT_SYSTEM_PROMPT, cutUserInput, LEGACY_LEDGER_NOTE, LEGACY_NOTE_SOURCE, renderLedger, RESUME_TEXT, SUMMARY_CUT_NOTICE, summarizeTranscript, textTokens, WORKING_STATE_BYTES } from "../src/compact.js";
import type { InteractionAdapter } from "../src/interactions/contract.js";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage, ProviderAdapter, ProviderRequest, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { openSessionStore, type SessionStore } from "../src/sessions/store.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import type { PanelDeclaration } from "../src/panels/contract.js";
import { createTestToolRegistry, type ToolRegistry } from "./fixtures/registry.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { compactionInput, isCompactionRequest } from "./fixtures/compaction.js";

/** Random lowercase hex of `bytes` bytes: distinct per call and never JSON-escaped, so byte counts are exact. */
const noise = (bytes: number) => randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes);
const distinct = (label: string, bytes = 32) => `${label}-${noise(bytes)}`;

function sessionStore() {
  const root = mkdtempSync(join(tmpdir(), "raw-compaction-context-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "compaction" }).id;
  return { root, store, id };
}

const stop = (text: string): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop" });
const calls = (...items: Array<[string, string, Record<string, unknown>]>): ProviderTurn =>
  ({ text: "", toolCalls: items.map(([id, name, args]) => ({ id, name, arguments: args })), finishReason: "tool_calls" });

/** A provider whose main requests follow `script`; summary requests answer with `checkpoint`. Requests are recorded. */
function scripted(model: Partial<ResolvedModelConfig>, script: ProviderTurn[], checkpoint: (request: ProviderRequest) => string = () => "## Goal\nKeep going.") {
  const main: Array<{ messages: ModelMessage[] }> = [];
  const summaries: Array<{ text: string; maxOutputTokens?: number | undefined }> = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", ...model },
    async generate(request) {
      if (isCompactionRequest(request)) {
        summaries.push({ text: compactionInput(request), maxOutputTokens: request.maxOutputTokens });
        return stop(checkpoint(request));
      }
      main.push({ messages: structuredClone(request.messages) as ModelMessage[] });
      return script.shift() ?? stop("done");
    } };
  return { provider, main, summaries };
}

/** Test tools: `probe` returns its `out` argument followed by `pad` bytes; `ask_user` is the bundled tool answered from `answers`. */
async function tools(answers: string[] = []) {
  const registry = createTestToolRegistry();
  registry.register({ name: "probe", description: "probe", inputSchema: { type: "object", properties: { out: { type: "string" }, pad: { type: "integer" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: `${String(args.out ?? "")}${"r".repeat(Number(args.pad ?? 0))}` }] }) });
  for (const tool of await loadBundledTools(["ask_user"])) registry.register(tool);
  const interactionAdapter: InteractionAdapter = async (request) => ({ requestId: request.identity.requestId, expectedRevision: request.revision,
    idempotencyKey: randomUUID(), response: "submit", answers: { q: answers.shift() ?? "" } });
  return { registry, interactionAdapter };
}
const ask = (id: string): [string, string, Record<string, unknown>] => [id, "ask_user", { questions: [{ id: "q", label: "Q", kind: "text" }] }];

function persisted(store: SessionStore, id: string, root: string, provider: ProviderAdapter, extra: Partial<AgentOptions> = {}) {
  return createAgent({ cwd: root, provider, system: "tiny", autoApprove: true, ...extra, persistence: { store, sessionId: id, surface: "cli" } });
}

const firstText = (messages: readonly ModelMessage[]) => messages[0]?.role === "user" && typeof messages[0].content === "string" ? messages[0].content : "";
const section = (checkpoint: string, name: string) => {
  const start = checkpoint.indexOf(`## ${name}`);
  const end = checkpoint.indexOf("\n\n## ", start + 3);
  return checkpoint.slice(checkpoint.indexOf("\n", start) + 1, end < 0 ? undefined : end);
};
const ledgerOf = (messages: readonly ModelMessage[]) => section(firstText(messages), "User messages (verbatim, oldest first)");
const sequences = (store: SessionStore, id: string) => new Map(store.recentUserInputs(id, 1000)
  .map((row) => [typeof row.input === "string" ? row.input : JSON.stringify(row.input), row.sequence]));
const ledgerRows = (store: SessionStore, id: string) => {
  const database = new DatabaseSync(store.path, { readOnly: true });
  try { return database.prepare("SELECT source, payload_json FROM compaction_ledger WHERE session_id = ? ORDER BY ordinal").all(id); }
  finally { database.close(); }
};
const steps = (messages: readonly ModelMessage[]) => {
  const result: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "tool" && result.at(-1)?.[0]?.role === "assistant") result.at(-1)!.push(message);
    else result.push([message]);
  }
  return result;
};

test("1: a mid-turn automatic compaction keeps both typed inputs, the last step verbatim and the resume text", async () => {
  const { root, store, id } = sessionStore();
  const first = distinct("first-input");
  const second = distinct("second-input");
  const script: ProviderTurn[] = [stop("ok")];
  for (let index = 0; index < 12; index++) script.push(calls([`call-${index}`, "probe", { out: distinct(`R${index}`), pad: 1500 }]));
  const { provider, main } = scripted({ contextWindow: 40000, maxOutputTokens: 1000 }, script);
  const { registry, interactionAdapter } = await tools();
  const agent = persisted(store, id, root, provider, { registry, interactionAdapter, whitelist: ["probe"],
    compact: { triggerTokens: 6000, keepRecentTurns: 2, keepRecentTokens: 1500, maxOutputTokens: 1000 } });
  try {
    assert.equal((await agent.run(first)).status, "completed");
    let before: ModelMessage[] | undefined;
    const statuses: string[] = [];
    assert.equal((await agent.run(second, (event) => {
      if (event.type === "compact_start" && !before) before = [...agent.transcript];
      if (event.type === "compact_end") statuses.push(event.result.status);
    })).status, "completed");
    // The turn may compact again as the probes refill the window; the first compaction is the one checked here.
    assert.ok(statuses.length >= 1 && statuses.every((status) => status === "compacted"), statuses.join());
    const next = main.find((request) => firstText(request.messages).startsWith("[Raw compaction checkpoint #1]"))!;
    assert.ok(next, "a request after the compaction starts with the checkpoint");
    const order = sequences(store, id);
    const ledger = ledgerOf(next.messages);
    assert.ok(ledger.includes(`[user, history #${order.get(first)}]\n${first}`));
    assert.ok(ledger.includes(`[user, history #${order.get(second)}]\n${second}`));
    assert.ok(ledger.indexOf(first) < ledger.indexOf(second));
    assert.ok(firstText(next.messages).endsWith(`## Resume\n${RESUME_TEXT}`));
    assert.doesNotMatch(JSON.stringify(next.messages), /\[Conversation summary\]/);
    // The step in progress at the compaction is sent unchanged, with its original call IDs.
    const last = steps(before!).at(-1)!;
    assert.equal(last[0]?.role, "assistant");
    const start = next.messages.findIndex((message) => JSON.stringify(message) === JSON.stringify(last[0]));
    assert.ok(start > 0);
    assert.deepEqual(next.messages.slice(start, start + last.length), last);
    assert.deepEqual(next.messages.slice(start + 1, start + last.length).map((message) => message.role === "tool" ? message.callId : ""),
      last[0]!.role === "assistant" ? last[0]!.toolCalls.map((call) => call.id) : []);
  } finally { await agent.close(); store.close(); }
});

test("2: the ledger keeps the newest inputs whole up to 20k tokens, cuts one with a pointer and renders oldest first", async () => {
  const { root, store, id } = sessionStore();
  const inputs = Array.from({ length: 30 }, (_, index) => distinct(`input${index}`, 600 + (index * 7919) % 3400));
  assert.ok(inputs.reduce((sum, input) => sum + input.length, 0) / 2 > 20000);
  const { provider } = scripted({}, []);
  const agent = persisted(store, id, root, provider, { registry: createTestToolRegistry() });
  try {
    for (const input of inputs) await agent.run(input);
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1000 })).status, "compacted");
    const order = sequences(store, id);
    const ledger = ledgerOf(agent.transcript);
    assert.ok(Buffer.byteLength(ledger) / 2 <= 20000 + 64, `ledger is ${Buffer.byteLength(ledger)} bytes`);
    const shown = inputs.map((input, index) => ({ index, at: ledger.indexOf(`[user, history #${order.get(input)}]\n`), whole: ledger.includes(`\n${input}\n`) || ledger.endsWith(`\n${input}`) }))
      .filter((item) => item.at >= 0);
    const cut = [...ledger.matchAll(/\[… cut; full text: history #(\d+)\]/g)];
    assert.equal(cut.length, 1, "exactly one entry is cut");
    const cutIndex = inputs.findIndex((input) => order.get(input) === Number(cut[0]![1]));
    assert.ok(cutIndex >= 0 && cutIndex < inputs.length - 1);
    // The newest are whole, the cut one is the oldest shown, nothing older appears, and the output is oldest first.
    assert.deepEqual(shown.map((item) => item.index), inputs.map((_, index) => index).filter((index) => index >= cutIndex));
    assert.ok(shown.every((item) => item.whole === (item.index !== cutIndex)));
    assert.deepEqual(shown.map((item) => item.at), [...shown.map((item) => item.at)].sort((a, b) => a - b));
  } finally { await agent.close(); store.close(); }

  // An ask_user answer newer than the request never displaces it: both are kept whole even above the cap.
  const fresh = sessionStore();
  const request = distinct("request", 24000);
  const answer = distinct("answer", 24000);
  const older = distinct("older", 2000);
  const { registry, interactionAdapter } = await tools([answer]);
  const { provider: asking } = scripted({}, [stop("ok"), calls(ask("ask-1")), stop("thanks")]);
  const second = persisted(fresh.store, fresh.id, fresh.root, asking, { registry, interactionAdapter });
  try {
    await second.run(older);
    await second.run(request);
    assert.equal((await second.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1000 })).status, "compacted");
    const ledger = ledgerOf(second.transcript);
    assert.ok(ledger.includes(`\n${request}\n`), "the request is whole");
    assert.ok(ledger.includes(`[ask_user answer ask-1]\n`) && ledger.includes(answer), "the answer is whole");
    assert.ok(ledger.indexOf(request) < ledger.indexOf(answer));
    assert.ok(!ledger.includes(older), "the older input has no room left under the cap");
  } finally { await second.close(); fresh.store.close(); }
});

test("3: the ledger and an ask_user answer survive a restart, the checkpoint number increments, and /clear empties the rows", async () => {
  const { root, store, id } = sessionStore();
  const inputs = [distinct("one"), distinct("two"), distinct("three"), distinct("four")];
  const answer = distinct("answer");
  const { registry, interactionAdapter } = await tools([answer]);
  const { provider } = scripted({}, [stop(`a1 ${noise(2000)}`), calls(ask("ask-1")), stop(`a2 ${noise(2000)}`), stop(`a3 ${noise(2000)}`)]);
  const first = persisted(store, id, root, provider, { registry, interactionAdapter });
  await first.run(inputs[0]!);
  await first.run(inputs[1]!);
  await first.run(inputs[2]!);
  assert.equal((await first.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
  await first.close();
  const owner = store.claimSession(id);
  const saved = store.readAgentState(id, owner);
  store.releaseSession(id, owner);
  assert.equal(saved.ledger?.compactions, 1);
  assert.ok(saved.ledger?.entries.some((entry) => entry.source === "answer:ask-1" && entry.content.includes(answer)));
  const resumed = persisted(store, id, root, scripted({}, [stop(`a4 ${noise(2000)}`), stop(`a5 ${noise(2000)}`)]).provider, { registry, interactionAdapter });
  try {
    await resumed.run(inputs[3]!);
    await resumed.run(distinct("five"));
    assert.equal((await resumed.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const transcript = resumed.transcript;
    assert.ok(firstText(transcript).startsWith("[Raw compaction checkpoint #2]"));
    assert.equal(transcript.filter((message) => message.role === "user" && typeof message.content === "string"
      && message.content.startsWith("[Raw compaction checkpoint #")).length, 1);
    const ledger = ledgerOf(transcript);
    for (const input of inputs) assert.ok(ledger.includes(input), `ledger keeps ${input}`);
    assert.ok(ledger.includes(`[ask_user answer ask-1]\n`) && ledger.includes(answer));
    assert.ok(ledgerRows(store, id).length > 0);
    resumed.clear();
    assert.equal(ledgerRows(store, id).length, 0);
  } finally { await resumed.close(); store.close(); }
});

test("4: an old-layout session upgrades from history only when the boundary is unambiguous", async () => {
  // Unique: the original task matches exactly one history row, so every typed input since it joins the ledger.
  {
    const { root, store, id } = sessionStore();
    const [task, middle, latest] = [distinct("task"), distinct("middle"), distinct("latest")];
    const { provider, summaries } = scripted({}, [stop(`r1 ${noise(4000)}`), stop(`r2 ${noise(4000)}`), stop(`r3 ${noise(4000)}`), stop("r4")]);
    const writer = persisted(store, id, root, provider, { registry: createTestToolRegistry() });
    for (const input of [task, middle, latest]) await writer.run(input);
    await writer.close();
    // The old layout, written through the store: pinned task, summary message, then the retained turn.
    const owner = store.claimSession(id);
    const state = store.readAgentState(id, owner);
    const tail = state.messages.slice(state.messages.findIndex((message) => message.role === "user" && message.content === latest));
    store.replaceAgentContext(id, owner, [{ role: "user", content: task }, { role: "user", content: "[Conversation summary]\nOLD SUMMARY" }, ...tail],
      { summaryText: "OLD SUMMARY", replayBefore: 0, anchor: null });
    store.releaseSession(id, owner);
    const agent = persisted(store, id, root, provider, { registry: createTestToolRegistry() });
    try {
      await agent.run(distinct("after"));
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
      const ledger = ledgerOf(agent.transcript);
      const order = sequences(store, id);
      for (const input of [task, middle, latest]) assert.ok(ledger.includes(`[user, history #${order.get(input)}]\n${input}`), input);
      assert.ok(!ledger.includes(LEGACY_LEDGER_NOTE));
      assert.ok(summaries.at(-1)!.text.includes("<prior-checkpoint>\nOLD SUMMARY\n</prior-checkpoint>"));
      assert.doesNotMatch(JSON.stringify(agent.transcript), /\[Conversation summary\]/);
    } finally { await agent.close(); store.close(); }
  }
  // Ambiguous: the task's wording appears before and after a /clear, so history is not used.
  {
    const { root, store, id } = sessionStore();
    const [task, cleared, middle, latest] = [distinct("task"), distinct("pre-clear"), distinct("middle"), distinct("latest")];
    const { provider } = scripted({}, Array.from({ length: 5 }, () => stop(`r ${noise(4000)}`)));
    const writer = persisted(store, id, root, provider, { registry: createTestToolRegistry() });
    await writer.run(task);
    await writer.run(cleared);
    writer.clear();
    for (const input of [task, middle, latest]) await writer.run(input);
    await writer.close();
    const owner = store.claimSession(id);
    const state = store.readAgentState(id, owner);
    const tail = state.messages.slice(state.messages.findIndex((message) => message.role === "user" && message.content === latest));
    store.replaceAgentContext(id, owner, [{ role: "user", content: task }, { role: "user", content: "[Conversation summary]\nOLD SUMMARY" }, ...tail],
      { summaryText: "OLD SUMMARY", replayBefore: 0, anchor: null });
    store.releaseSession(id, owner);
    const agent = persisted(store, id, root, scripted({}, [stop("r")]).provider, { registry: createTestToolRegistry() });
    try {
      const after = distinct("after");
      await agent.run(after);
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
      const ledger = ledgerOf(agent.transcript);
      assert.ok(ledger.includes(`[user, original task]\n${task}`));
      assert.ok(ledger.includes(LEGACY_LEDGER_NOTE));
      assert.ok(ledger.includes(latest) && ledger.includes(after), "inputs still in the active context are kept");
      assert.ok(!ledger.includes(cleared), "no input from before /clear");
      assert.ok(!ledger.includes(middle), "history is not used when the boundary is ambiguous");
    } finally { await agent.close(); store.close(); }
  }
});

test("5: no tail selection leaves a tool result without its call, for every adapter", async () => {
  const build = async (keepRecentTokens: number) => {
    const script: ProviderTurn[] = [];
    for (let turn = 0; turn < 4; turn++) {
      script.push(calls(...Array.from({ length: 3 }, (_, index): [string, string, Record<string, unknown>] => [`t${turn}c${index}`, "probe", { out: distinct("c"), pad: 300 + 200 * index }])));
      script.push(calls([`t${turn}single`, "probe", { out: distinct("s"), pad: 700 }]));
      script.push(stop(`answer ${turn}`));
    }
    const { provider } = scripted({}, script);
    const { registry, interactionAdapter } = await tools();
    const agent = createAgent({ provider, registry, interactionAdapter, system: "tiny", autoApprove: true });
    for (let turn = 0; turn < 4; turn++) await agent.run(`turn ${turn}`);
    const result = await agent.compact({ keepRecentTurns: 0, keepRecentTokens, maxOutputTokens: 1000 });
    return { status: result.status, messages: agent.transcript };
  };
  const paired = (messages: readonly ModelMessage[]) => {
    for (const [index, message] of messages.entries()) {
      if (message.role !== "assistant" || !message.toolCalls.length) continue;
      const results = messages.slice(index + 1, index + 1 + message.toolCalls.length);
      assert.deepEqual(results.map((item) => item.role === "tool" ? item.callId : undefined), message.toolCalls.map((call) => call.id));
    }
    const known = new Set(messages.flatMap((message) => message.role === "assistant" ? message.toolCalls.map((call) => call.id) : []));
    assert.ok(messages.every((message) => message.role !== "tool" || known.has(message.callId)));
  };
  const tails: ModelMessage[][] = [];
  for (const keep of [1, 150, 300, 450, 600, 900, 1200, 2000]) {
    const { status, messages } = await build(keep);
    assert.equal(status, "compacted");
    paired(messages);
    tails.push([...messages]);
  }
  assert.ok(new Set(tails.map((messages) => messages.length)).size >= 3, `the sweep produced several different tails: ${tails.map((messages) => messages.length)}`);
  const anthropicOk = [
    anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ];
  const responsesOk = [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
    response: { id: "r", object: "response", status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: null } })}\n\n`, "data: [DONE]\n\n"];
  const cases: Array<{ method: ResolvedModelConfig["method"]; provider: string; frames: string[]; pairs: (body: Record<string, unknown>) => { calls: string[]; results: string[] } }> = [
    { method: "openai-chat-completions", provider: "openai", frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone], pairs: (body) => {
      const messages = body.messages as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
      return { calls: messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
        results: messages.flatMap((message) => message.role === "tool" ? [message.tool_call_id!] : []) };
    } },
    { method: "openai-responses", provider: "openai", frames: responsesOk, pairs: (body) => {
      const input = body.input as Array<{ type?: string; call_id?: string }>;
      return { calls: input.flatMap((item) => item.type === "function_call" ? [item.call_id!] : []),
        results: input.flatMap((item) => item.type === "function_call_output" ? [item.call_id!] : []) };
    } },
    { method: "anthropic-messages", provider: "anthropic", frames: anthropicOk, pairs: (body) => {
      const blocks = (body.messages as Array<{ content: unknown }>).flatMap((message) => Array.isArray(message.content) ? message.content as Array<{ type: string; id?: string; tool_use_id?: string }> : []);
      return { calls: blocks.flatMap((block) => block.type === "tool_use" ? [block.id!] : []),
        results: blocks.flatMap((block) => block.type === "tool_result" ? [block.tool_use_id!] : []) };
    } },
    { method: "google-generate-content", provider: "google", frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })], pairs: (body) => {
      const parts = (body.contents as Array<{ parts: Array<{ functionCall?: { id?: string; name: string }; functionResponse?: { id?: string; name: string } }> }>).flatMap((content) => content.parts);
      return { calls: parts.flatMap((part) => part.functionCall ? [part.functionCall.id ?? part.functionCall.name] : []),
        results: parts.flatMap((part) => part.functionResponse ? [part.functionResponse.id ?? part.functionResponse.name] : []) };
    } },
  ];
  for (const item of cases) {
    for (const messages of [tails[0]!, tails[3]!, tails.at(-1)!]) {
      const mock = await startMockProvider([{ frames: item.frames }]);
      try {
        const result = await createProvider({ agentName: "wire", provider: item.provider, method: item.method, model: "fixture", baseUrl: mock.url,
          apiKey: "fixture", maxOutputTokens: 128 }).generate({ system: "tiny", messages: [...messages, { role: "user", content: "next" }], tools: [], timeoutMs: 2000 });
        assert.equal(result.text, "ok");
        const { calls: sent, results } = item.pairs(mock.requests[0]!.body as Record<string, unknown>);
        assert.deepEqual([...results].sort(), [...sent].sort(), `${item.method}: every call has its result and no result is orphaned`);
      } finally { await mock.close(); }
    }
  }
});

test("6: allocation keeps mandatory parts whole above the target, then shortens the checkpoint, then goes mechanical, then cuts with pointers", async () => {
  // contextWindow 40000 with a 1000-token output reserve: an input budget of 37000 and a soft target of 18500.
  const run = async (sizes: { older: number; request: number; answer?: number; result: number }, maxOutputTokens = 2000) => {
    const { root, store, id } = sessionStore();
    const older = distinct("older", sizes.older);
    const request = distinct("request", sizes.request);
    const answer = sizes.answer === undefined ? undefined : distinct("answer", sizes.answer);
    const marker = distinct("RESULT");
    const result = `${marker}${"r".repeat(sizes.result)}`;
    const { registry, interactionAdapter } = await tools(answer === undefined ? [] : [answer]);
    const { provider, summaries } = scripted({ contextWindow: 40000, maxOutputTokens: 1000 },
      [stop(`ok ${noise(6000)}`), ...(answer === undefined ? [] : [calls(ask("ask-1"))]), calls(["probe-1", "probe", { out: marker, pad: sizes.result }]), calls(["unused", "probe", {}])]);
    // The step limit ends the turn right after the probe step, so that step is the last one when compaction runs.
    const agent = persisted(store, id, root, provider, { registry, interactionAdapter, whitelist: ["probe", "ask_user"], maxSteps: answer === undefined ? 2 : 3 });
    try {
      await agent.run(older);
      assert.equal((await agent.run(request)).status, "max_steps");
      assert.equal(steps(agent.transcript).at(-1)?.[0]?.role, "assistant");
      const compacted = await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 30000, maxOutputTokens });
      const order = sequences(store, id);
      return { compacted, transcript: agent.transcript, summaries, older, request, answer, result, sequence: order.get(request)! };
    } finally { await agent.close(); store.close(); }
  };
  // Above the target, within the budget: mandatory parts whole, optional parts omitted.
  {
    const outcome = await run({ older: 2000, request: 16000, result: 16000 });
    assert.equal(outcome.compacted.status, "compacted");
    const checkpoint = firstText(outcome.transcript);
    assert.equal(section(checkpoint, "Working state"), "(omitted to fit the context)");
    const ledger = ledgerOf(outcome.transcript);
    assert.ok(ledger.includes(`\n${outcome.request}`) && !ledger.includes(outcome.older));
    assert.equal(outcome.summaries.at(-1)!.maxOutputTokens, 2000);
    assert.ok(JSON.stringify(outcome.transcript.at(-1)).includes(outcome.result), "the last step is whole");
  }
  // Above the budget: the checkpoint's output budget is lowered first.
  {
    const outcome = await run({ older: 200, request: 46000, result: 16000 });
    assert.equal(outcome.compacted.status, "compacted");
    const budget = outcome.summaries.at(-1)!.maxOutputTokens!;
    assert.ok(budget < 2000 && budget >= 1024, `checkpoint budget ${budget}`);
  }
  // Then the mechanical note replaces it, without a summary request.
  {
    const outcome = await run({ older: 200, request: 50000, result: 16000 });
    assert.equal(outcome.compacted.status, "compacted");
    assert.equal(outcome.summaries.length, 0);
    assert.match(section(firstText(outcome.transcript), "Checkpoint"), /^\[Checkpoint unavailable: no room left in the context for a new checkpoint;/);
  }
  // Then the last step's results and the turn's answer are cut before the request.
  {
    const outcome = await run({ older: 200, request: 60000, answer: 16000, result: 16000 });
    assert.equal(outcome.compacted.status, "compacted");
    const ledger = ledgerOf(outcome.transcript);
    assert.ok(ledger.includes(`\n${outcome.request}`), "the request stays whole while its answer can be cut");
    assert.ok(ledger.includes("[… cut; full text: ask_user answer ask-1]") && !ledger.includes(outcome.answer!));
    const last = JSON.stringify(outcome.transcript.at(-1));
    assert.ok(!last.includes(outcome.result) && last.includes("bytes omitted; full output: "));
  }
  // And finally the request itself, naming its history entry.
  {
    const outcome = await run({ older: 200, request: 80000, answer: 16000, result: 16000 });
    assert.equal(outcome.compacted.status, "compacted");
    const ledger = ledgerOf(outcome.transcript);
    assert.ok(ledger.includes(`[… cut; full text: history #${outcome.sequence}]`) && !ledger.includes(outcome.request));
  }
});

test("7: a reasoning rejection after compaction retries once with history projected, and the boundary is persisted", async () => {
  const { root, store, id } = sessionStore();
  const message = (index: number, blocks: string[]) => [
    anthropicFrame("message_start", { message: { id: `m${index}`, type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    ...blocks, anthropicFrame("message_delta", { delta: { stop_reason: blocks.some((block) => block.includes("tool_use")) ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ];
  const thinking = (index: number, signature: string) => [
    anthropicFrame("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }),
    anthropicFrame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: `thought ${signature}` } }),
    anthropicFrame("content_block_delta", { index, delta: { type: "signature_delta", signature } }),
    anthropicFrame("content_block_stop", { index }),
  ];
  const text = (index: number, value: string) => [
    anthropicFrame("content_block_start", { index, content_block: { type: "text", text: value } }),
    anthropicFrame("content_block_stop", { index }),
  ];
  const fixture = await startMockProvider([
    { frames: message(1, [...thinking(0, "sig-1"), ...text(1, `first answer ${noise(3000)}`)]) },
    { frames: message(2, [...thinking(0, "sig-2"), ...text(1, `second answer ${noise(3000)}`)]) },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages.2.content.0: Invalid `signature` in `thinking` block" } } },
    { frames: message(3, text(0, "recovered")) },
    { frames: message(4, text(0, "later")) },
  ]);
  const model: ResolvedModelConfig = { agentName: "claude", provider: "anthropic", method: "anthropic-messages", model: "fixture", baseUrl: fixture.url, apiKey: "fixture", maxOutputTokens: 1000 };
  const summarizer = scripted({}, []).provider;
  const agent = persisted(store, id, root, createProvider(model), { registry: createTestToolRegistry() });
  try {
    await agent.run("first");
    await agent.run("second");
    assert.equal((await agent.compact({ provider: summarizer, keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.match(JSON.stringify(agent.transcript), /sig-2/, "the retained step keeps its signed thinking");
    const result = await agent.run("third");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "recovered");
    assert.equal(fixture.requests.length, 4);
    assert.match(JSON.stringify(fixture.requests[2]!.body), /sig-2/, "the rejected request replayed the reasoning natively");
    const retry = fixture.requests[3]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.doesNotMatch(JSON.stringify(retry), /"thinking"|sig-2|signature/, "the retry projects every earlier message to text");
    assert.equal(retry.messages.at(-1)?.role, "user");
    const length = agent.transcript.length;
    await agent.close();
    const owner = store.claimSession(id);
    const saved = store.readAgentState(id, owner);
    store.releaseSession(id, owner);
    assert.equal(saved.replayBefore, length - 1, "the boundary covers every message the rejected request was built from");
  } finally { await agent.close(); }
  const resumed = persisted(store, id, root, createProvider(model), { registry: createTestToolRegistry() });
  try {
    assert.equal((await resumed.run("fourth")).text, "later");
    assert.doesNotMatch(JSON.stringify(fixture.requests[4]!.body), /sig-2|signature/, "a restart keeps the raised boundary");
  } finally { await resumed.close(); store.close(); await fixture.close(); }

  // Any other client error is not retried.
  const other = await startMockProvider([
    { frames: message(1, text(0, `one ${noise(3000)}`)) }, { frames: message(2, text(0, `two ${noise(3000)}`)) },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "max_tokens is too large" } } },
  ]);
  const plain = createAgent({ provider: createProvider({ ...model, baseUrl: other.url }), registry: createTestToolRegistry(), system: "tiny" });
  try {
    await plain.run("one");
    await plain.run("two");
    assert.equal((await plain.compact({ provider: summarizer, keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.equal((await plain.run("three")).status, "error");
    assert.equal(other.requests.length, 3);
  } finally { await plain.close(); await other.close(); }
});

test("8: panel and skill reminders follow the checkpoint, and a second compaction replaces them", async () => {
  const { root, store, id } = sessionStore();
  const declaration: PanelDeclaration = { id: "notes", title: "NOTES", icon: "list-checks", open: "never", context: "summary", acp_plan: false, actions: [] };
  const registry: ToolRegistry = createTestToolRegistry();
  registry.register({ name: "notes", description: "notes", inputSchema: { type: "object", properties: { text: { type: "string" } } }, panels: [declaration],
    handler: async (args) => ({ isError: false, content: [{ type: "panel", panel: "notes", op: "replace", document: { blocks: [{ id: "m", kind: "markdown", text: String(args.text) }] } } as never] }) });
  const body = "SKILL_BODY_".repeat(200);
  registry.register({ name: "load_skill", description: "Load skill", inputSchema: { type: "object", properties: { name: { type: "string" } } },
    handler: async () => ({ isError: false, content: [{ type: "text", text: body }] }) });
  const { provider } = scripted({}, [calls(["skill", "load_skill", { name: "example" }], ["n1", "notes", { text: "first notes" }]), stop(`a ${noise(2000)}`),
    stop(`b ${noise(2000)}`), calls(["n2", "notes", { text: "second notes" }]), stop(`c ${noise(2000)}`), stop(`d ${noise(2000)}`)]);
  const agent = persisted(store, id, root, provider, { registry, whitelist: ["notes", "load_skill"],
    selectedSkills: [{ id: "agent/example", version: "1.0.0", name: "example", description: "Example", markdown: body }] });
  const reminders = (messages: readonly ModelMessage[]) => messages.flatMap((message, index) => message.role === "user" && typeof message.content === "string"
    && (message.content.startsWith("[Raw panel state]\n") || message.content.startsWith("[Raw skill reload notice]")) ? [{ index, text: message.content }] : []);
  try {
    await agent.run("one");
    await agent.run("two");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    let transcript = agent.transcript;
    let found = reminders(transcript);
    assert.deepEqual(found.map((item) => item.text.slice(0, 18)), ["[Raw skill reload ", "[Raw panel state]\n"]);
    assert.ok(found.every((item) => item.index > 0), "reminders follow the checkpoint");
    assert.equal(found.at(-1)!.index, transcript.length - 1);
    assert.match(found[1]!.text, /first notes/);
    await agent.run("three");
    await agent.run("four");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    transcript = agent.transcript;
    found = reminders(transcript);
    assert.equal(found.filter((item) => item.text.startsWith("[Raw panel state]")).length, 1, "the panel reminder is replaced, not stacked");
    assert.match(found.find((item) => item.text.startsWith("[Raw panel state]"))!.text, /second notes/);
    assert.ok(found.filter((item) => item.text.startsWith("[Raw skill reload notice]")).length <= 1);
    assert.ok(firstText(transcript).startsWith("[Raw compaction checkpoint #2]"));
  } finally { await agent.close(); store.close(); }
});

test("9: working-state facts survive later compactions and a restart, even while the block is omitted", async () => {
  const { root, store, id } = sessionStore();
  const saved = join(root, "saved-output.log");
  writeFileSync(saved, "full output");
  const file = `written-${noise(8)}.txt`;
  const { registry, interactionAdapter } = await tools();
  registry.register({ name: "fetch", description: "fetch", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "head … tail" }], fullOutputPath: saved }) });
  const first = persisted(store, id, root, scripted({ contextWindow: 60000, maxOutputTokens: 1000 }, [
    calls(["w", "write_file", { operations: [{ path: file, mode: "overwrite", content: "hello" }] }], ["f", "fetch", {}]), stop(`a ${noise(6000)}`),
    stop(`b ${noise(6000)}`),
  ]).provider, { registry, interactionAdapter });
  await first.run("write it");
  await first.run("next");
  assert.equal((await first.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
  assert.match(section(firstText(first.transcript), "Working state"), new RegExp(`${file} \\(write_file overwrite\\)`));
  await first.close();
  // A context so tight that the block is omitted: the facts stay stored.
  const tight = persisted(store, id, root, scripted({ contextWindow: 16000, maxOutputTokens: 1000 }, [stop(`c ${noise(6000)}`), stop(`d ${noise(6000)}`)]).provider,
    { registry, interactionAdapter });
  try {
    await tight.run(distinct("big", 9000));
    await tight.run("more");
    assert.equal((await tight.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1024 })).status, "compacted");
    assert.equal(section(firstText(tight.transcript), "Working state"), "(omitted to fit the context)");
  } finally { await tight.close(); }
  const owner = store.claimSession(id);
  const state = store.readAgentState(id, owner);
  store.releaseSession(id, owner);
  assert.deepEqual(state.ledger?.facts.written, [{ path: file, tool: "write_file overwrite" }]);
  assert.deepEqual(state.ledger?.facts.outputs, [saved]);
  assert.equal(state.ledger?.compactions, 2);
  // With room again, after the first steps are long gone, the block lists them.
  const roomy = persisted(store, id, root, scripted({ contextWindow: 60000, maxOutputTokens: 1000 }, [stop(`e ${noise(6000)}`), stop(`f ${noise(6000)}`)]).provider,
    { registry, interactionAdapter });
  try {
    await roomy.run("again");
    await roomy.run("last");
    assert.equal((await roomy.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const working = section(firstText(roomy.transcript), "Working state");
    assert.ok(firstText(roomy.transcript).startsWith("[Raw compaction checkpoint #3]"));
    assert.ok(working.includes(`${file} (write_file overwrite)`) && working.includes(saved) && Buffer.byteLength(working) <= WORKING_STATE_BYTES);
    assert.doesNotMatch(JSON.stringify(roomy.transcript.slice(1)), new RegExp(file), "the step that wrote the file is gone");
  } finally { await roomy.close(); store.close(); }
});

test("10: retained native reasoning is replayed unchanged through compaction and restart", async () => {
  const anthropicOpaque = [{ type: "thinking", thinking: "private chain", signature: `sig-${noise(16)}` }, { type: "redacted_thinking", data: `redacted-${noise(16)}` },
    { type: "tool_use", id: "a-call", name: "probe", input: { out: "x" } }];
  const responsesOpaque = [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: `enc-${noise(24)}` },
    { type: "function_call", id: "fc_1", call_id: "r-call", name: "probe", arguments: "{\"out\":\"x\"}" }];
  for (const [method, opaque, callId] of [["anthropic-messages", anthropicOpaque, "a-call"], ["openai-responses", responsesOpaque, "r-call"]] as const) {
    const { root, store, id } = sessionStore();
    const { registry, interactionAdapter } = await tools();
    const step: ProviderTurn = { text: "", toolCalls: [{ id: callId, name: "probe", arguments: { out: "x" } }], finishReason: "tool_calls", opaque: structuredClone(opaque) };
    const first = scripted({ method, provider: method === "anthropic-messages" ? "anthropic" : "openai" }, [stop(`a ${noise(3000)}`), step]);
    const agent = persisted(store, id, root, first.provider, { registry, interactionAdapter });
    const retained = () => agent.transcript.find((message) => message.role === "assistant" && message.toolCalls[0]?.id === callId);
    await agent.run("one");
    const pending = agent.run("two");
    await pending;
    const before = structuredClone(retained());
    assert.deepEqual(before?.role === "assistant" ? before.opaque : undefined, opaque);
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 300 })).status, "compacted");
    assert.deepEqual(retained(), before, "replacement keeps the step, its signatures and encrypted content");
    await agent.close();
    const second = scripted({ method, provider: method === "anthropic-messages" ? "anthropic" : "openai" }, [stop("done")]);
    const resumed = persisted(store, id, root, second.provider, { registry, interactionAdapter });
    try {
      assert.deepEqual(resumed.transcript.find((message) => message.role === "assistant" && message.toolCalls[0]?.id === callId), before, "a restart keeps it");
      await resumed.run("three");
      const sent = second.main[0]!.messages.find((message) => message.role === "assistant" && message.toolCalls[0]?.id === callId);
      assert.deepEqual(sent, before, "the next request sends it unchanged");
    } finally { await resumed.close(); store.close(); }
  }
});

test("R1: replay-projected steps keep their roles in the ledger, the facts and the stored tail", async () => {
  const { root, store, id } = sessionStore();
  const inputs = [distinct("one"), distinct("two"), distinct("three")];
  const answer = distinct("answer");
  const { registry, interactionAdapter } = await tools([answer]);
  const { provider, main } = scripted({}, [calls(ask("ask-1")), stop(`a1 ${noise(2000)}`),
    calls(["probe-1", "probe", { out: "PROBED", pad: 2000 }]), stop(`a2 ${noise(2000)}`), stop(`a3 ${noise(2000)}`), stop("a4")]);
  const agent = persisted(store, id, root, provider, { registry, interactionAdapter });
  try {
    await agent.run(inputs[0]!);
    await agent.run(inputs[1]!);
    await agent.run(inputs[2]!);
    // A changed tool view projects every earlier step to portable text for later requests.
    agent.setToolView(["probe"]);
    assert.equal((await agent.compact({ keepRecentTurns: 2, keepRecentTokens: 1 })).status, "compacted");
    const ledger = ledgerOf(agent.transcript);
    assert.ok(ledger.includes(`[ask_user answer ask-1]\n`) && ledger.includes(answer));
    assert.doesNotMatch(ledger, /\[Historical tool (result|call)/);
    // The retained steps are stored as they were, and still projected when sent.
    assert.ok(agent.transcript.some((message) => message.role === "tool" && message.callId === "probe-1"));
    assert.ok(!agent.transcript.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Historical")));
    await agent.run(distinct("four"));
    assert.match(JSON.stringify(main.at(-1)!.messages), /\[Historical tool result: probe, call probe-1/);
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const second = ledgerOf(agent.transcript);
    assert.doesNotMatch(second, /\[Historical tool (result|call)/);
    assert.equal(second.split(`[ask_user answer ask-1]`).length, 2, "the answer appears once");
    for (const input of inputs) assert.ok(second.includes(`\n${input}`));
  } finally { await agent.close(); store.close(); }
});

test("R2: an ask_user answer in the last step stays whole, and one the context must cut keeps its full text for later", async () => {
  // A small answer stays whole even when the tail budget is one token.
  {
    const { root, store, id } = sessionStore();
    const answer = distinct("answer", 4000);
    const { registry, interactionAdapter } = await tools([answer]);
    const { provider } = scripted({}, [stop(`ok ${noise(3000)}`), calls(ask("ask-1")), calls(["unused", "probe", {}])]);
    const agent = persisted(store, id, root, provider, { registry, interactionAdapter, maxSteps: 2 });
    try {
      await agent.run(distinct("older"));
      assert.equal((await agent.run(distinct("request"))).status, "max_steps");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
      assert.ok(JSON.stringify(agent.transcript.at(-1)).includes(answer));
    } finally { await agent.close(); store.close(); }
  }
  // An answer larger than the whole input budget is cut in the tail; the ledger keeps its full text when it leaves.
  {
    const { root, store, id } = sessionStore();
    const answer = distinct("huge", 30000);
    const { registry, interactionAdapter } = await tools([answer]);
    const { provider } = scripted({ contextWindow: 12000, maxOutputTokens: 1000 },
      [stop(`ok ${noise(3000)}`), calls(ask("ask-1")), calls(["unused", "probe", {}]), stop(`b ${noise(2000)}`)]);
    const agent = persisted(store, id, root, provider, { registry, interactionAdapter, whitelist: ["probe", "ask_user"], maxSteps: 2 });
    try {
      await agent.run(distinct("older"));
      assert.equal((await agent.run(distinct("request"))).status, "max_steps");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
      const tail = JSON.stringify(agent.transcript.at(-1));
      assert.ok(!tail.includes(answer), "the tail copy is cut");
      const state = ledgerRows(store, id).find((row) => row.source === "working_state")!;
      assert.ok((JSON.parse(String(state.payload_json)) as { retained: Array<{ content: string }> }).retained[0]!.content.includes(answer));
      await agent.run(distinct("next"));
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1024 })).status, "compacted");
      const row = ledgerRows(store, id).find((item) => item.source === "answer:ask-1")!;
      assert.ok((JSON.parse(String(row.payload_json)) as { content: string }).content.includes(answer), "the stored entry is the full answer");
    } finally { await agent.close(); store.close(); }
  }
});

test("R3: typed inputs that look like host notes stay in the ledger", async () => {
  const { root, store, id } = sessionStore();
  const inputs = [`[Conversation summary] ${distinct("a")}`, `[Raw compaction checkpoint #9] ${distinct("b")}`, `[Raw skill reload notice] ${distinct("c")}`];
  const { provider } = scripted({}, inputs.map(() => stop(`ok ${noise(2000)}`)));
  const agent = persisted(store, id, root, provider, { registry: createTestToolRegistry() });
  try {
    for (const input of inputs) await agent.run(input);
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const ledger = ledgerOf(agent.transcript);
    const order = sequences(store, id);
    for (const input of inputs) assert.ok(ledger.includes(`[user, history #${order.get(input)}]\n${input}`), input);
  } finally { await agent.close(); store.close(); }
});

test("R4/R7: the ledger fits its budget under calibration and always keeps the legacy coverage line", () => {
  const tokens = (text: string) => textTokens(text, 1.5);
  const entries = [1, 2, 3].map((n) => ({ source: `history:${n}`, content: noise(4000) }));
  const rendered = renderLedger(entries, { pinned: new Set(), budgetTokens: 3000, tokens });
  assert.ok(rendered.tokens <= 3000, `ledger is ${rendered.tokens} tokens`);
  assert.match(rendered.text, /\[… cut; full text: history #3\]/);
  // The coverage line survives pinned entries that use the whole budget, and an overflowing newer entry.
  const legacy = [{ source: "original_task", content: "task" }, { source: LEGACY_NOTE_SOURCE, content: LEGACY_LEDGER_NOTE }, ...entries];
  for (const pinned of [new Set(["history:3"]), new Set<string>()]) {
    const text = renderLedger(legacy, { pinned, budgetTokens: 100, tokens }).text;
    assert.ok(text.includes(LEGACY_LEDGER_NOTE), [...pinned].join());
  }
});

test("R5: a reasoning retry armed by a compaction survives the runtime being recreated", async () => {
  const { root, store, id } = sessionStore();
  const message = (index: number, value: string) => [
    anthropicFrame("message_start", { message: { id: `m${index}`, type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "thought" } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: `sig-${index}` } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("content_block_start", { index: 1, content_block: { type: "text", text: value } }),
    anthropicFrame("content_block_stop", { index: 1 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ];
  const fixture = await startMockProvider([
    { frames: message(1, `one ${noise(3000)}`) }, { frames: message(2, `two ${noise(3000)}`) },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Invalid `signature` in `thinking` block" } } },
    { frames: message(3, "recovered") },
  ]);
  const model: ResolvedModelConfig = { agentName: "claude", provider: "anthropic", method: "anthropic-messages", model: "fixture", baseUrl: fixture.url, apiKey: "fixture", maxOutputTokens: 1000 };
  const first = persisted(store, id, root, createProvider(model), { registry: createTestToolRegistry() });
  await first.run("first");
  await first.run("second");
  assert.equal((await first.compact({ provider: scripted({}, []).provider, keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
  await first.close();
  const second = persisted(store, id, root, createProvider(model), { registry: createTestToolRegistry() });
  try {
    assert.equal((await second.run("third")).text, "recovered");
    assert.equal(fixture.requests.length, 4);
    const state = ledgerRows(store, id).find((row) => row.source === "working_state")!;
    assert.equal((JSON.parse(String(state.payload_json)) as { retryArmed?: boolean }).retryArmed, undefined, "the retry is consumed");
  } finally { await second.close(); store.close(); await fixture.close(); }
});

test("R6: working state lists only completed writes, from operations and patches", () => {
  const call = (id: string, args: Record<string, unknown>): ModelMessage => ({ role: "assistant", text: "", toolCalls: [{ id, name: "write_file", arguments: args }] });
  const result = (id: string, rows: unknown[], isError: boolean): ModelMessage => ({ role: "tool", callId: id, name: "write_file",
    result: { isError, content: [{ type: "json", value: { results: rows } }] } });
  const facts = collectFacts([
    call("w1", { operations: [{ path: "ok.txt", mode: "replace" }, { path: "denied.txt", mode: "replace" }] }),
    result("w1", [{ index: 0, path: "ok.txt", mode: "replace", status: "ok" }, { index: 1, path: "denied.txt", mode: "replace", status: "error", error: "denied" }], true),
    call("w2", { patch: "*** Begin Patch" }),
    result("w2", [{ index: 0, path: "old.ts", destination: "new.ts", mode: "patch", status: "ok" },
      { index: 1, path: "skipped.ts", mode: "patch", status: "skipped" }], true),
  ]);
  assert.deepEqual(facts.written, [{ path: "ok.txt", tool: "write_file replace" }, { path: "new.ts", tool: "write_file patch" }]);
});

test("R8: a summary retry never doubles past the room the new context has", async () => {
  const requests: number[] = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", maxOutputTokens: 100000 },
    async generate(request) { requests.push(request.maxOutputTokens!); return { text: "## Goal\ncut", toolCalls: [], finishReason: "length", truncated: true }; } };
  const messages: ModelMessage[] = [{ role: "user", content: "task" }, { role: "assistant", text: noise(2000), toolCalls: [] }];
  const options = { maxOutputTokens: 2000, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "k" };
  await summarizeTranscript(messages, provider, options);
  assert.deepEqual(requests, [2000, 4000]);
  requests.length = 0;
  await summarizeTranscript(messages, provider, { ...options, maxRetryOutputTokens: 2000 });
  assert.deepEqual(requests, [2000]);
  requests.length = 0;
  await summarizeTranscript(messages, provider, { ...options, maxRetryOutputTokens: 3000 });
  assert.deepEqual(requests, [2000, 3000]);
});

test("R9: writes in a last step whose result is cut stay in the working state after later compactions", async () => {
  const { root, store, id } = sessionStore();
  const registry = createTestToolRegistry();
  const files = Array.from({ length: 16 }, (_, index) => `written-${index}-${noise(24)}.txt`);
  const { provider } = scripted({}, [stop(`ok ${noise(3000)}`),
    calls(["write-1", "write_file", { operations: files.map((path) => ({ path, mode: "overwrite", content: "x" })) }]), calls(["unused", "write_file", {}]),
    stop(`b ${noise(3000)}`)]);
  const agent = persisted(store, id, root, provider, { registry, maxSteps: 2 });
  try {
    await agent.run(distinct("older"));
    assert.equal((await agent.run(distinct("request"))).status, "max_steps");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const tail = JSON.stringify(agent.transcript.at(-1));
    assert.ok(tail.includes("bytes omitted") && !tail.includes(files[8]!), "the write result is cut in the tail");
    await agent.run(distinct("next"));
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const state = section(firstText(agent.transcript), "Working state");
    for (const file of files) assert.ok(state.includes(file), file);
  } finally { await agent.close(); store.close(); }
});

test("R10: a multipart request is cut like a text one, keeping its other blocks", () => {
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" as const };
  const large = noise(6000);
  const small = noise(200);
  const cut = cutUserInput([{ type: "text", text: large }, image, { type: "text", text: small }], 1000, "history #7");
  assert.ok(Array.isArray(cut));
  const texts = (cut as Array<{ type: string; text?: string }>).map((block) => block.text);
  assert.deepEqual((cut as unknown[])[1], image);
  assert.equal(texts[2], small, "the smaller text block is untouched");
  assert.match(texts[0]!, /\[… cut; full text: history #7\]/);
  assert.ok(Buffer.byteLength(texts[0]!) + Buffer.byteLength(small) <= 1000 + 64);
});

test("R11: the checkpoint reserve covers the note a cut summary adds", async () => {
  // A summary that fills its whole reserve and stops at the output limit still leaves the next request within the input budget.
  const { root, store, id } = sessionStore();
  const { registry } = await tools();
  const model: ResolvedModelConfig = { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", contextWindow: 40000, maxOutputTokens: 1000 };
  const budget = effectiveInputBudget(40000, effectiveOutputTokens(model));
  const summaries: number[] = [];
  const provider: ProviderAdapter = { modelConfig: model,
    async generate(request) {
      if (isCompactionRequest(request)) {
        summaries.push(request.maxOutputTokens!);
        return { text: `## Goal\n${"w".repeat(4 * request.maxOutputTokens! - 8)}`, toolCalls: [], finishReason: "length", truncated: true };
      }
      return stop(`ok ${noise(3000)}`);
    } };
  const agent = persisted(store, id, root, provider, { registry, whitelist: ["probe"] });
  try {
    for (let index = 0; index < 4; index++) await agent.run(distinct(`older${index}`, 2000));
    await agent.run(distinct("request", 62000));
    const outcome = await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 2000 });
    assert.equal(outcome.status, "compacted");
    assert.ok(summaries[0]! < 2000, `the checkpoint budget is lowered: ${summaries.join()}`);
    assert.ok(summaries.every((value) => value <= summaries[0]!), `no retry grows it: ${summaries.join()}`);
    assert.ok(firstText(agent.transcript).includes(SUMMARY_CUT_NOTICE.trim()));
    const after = agent.estimatedContextTokens();
    assert.ok(after <= budget, `next request ~${after} tokens, budget ${budget}`);
  } finally { await agent.close(); store.close(); }
});

test("R12: a checkpoint larger than its estimate is cut to the input budget, and the compaction record keeps it whole", async () => {
  const { root, store, id } = sessionStore();
  const { registry } = await tools();
  const model: ResolvedModelConfig = { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", contextWindow: 40000, maxOutputTokens: 1000 };
  const budget = effectiveInputBudget(40000, effectiveOutputTokens(model));
  const head = distinct("HEAD");
  const end = distinct("NEXT");
  let checkpoint = "";
  const provider: ProviderAdapter = { modelConfig: model,
    async generate(request) {
      if (isCompactionRequest(request)) {
        // Within the output limit by the provider's count, yet three times the bytes the estimate allowed.
        checkpoint = `## Goal\n${head}\n${"w".repeat(12 * request.maxOutputTokens!)}\n## Next actions\n${end}`;
        return stop(checkpoint);
      }
      return stop(`ok ${noise(3000)}`);
    } };
  const agent = persisted(store, id, root, provider, { registry, whitelist: ["probe"] });
  try {
    for (let index = 0; index < 4; index++) await agent.run(distinct(`older${index}`, 2000));
    await agent.run(distinct("request", 62000));
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 2000 })).status, "compacted");
    const placed = section(firstText(agent.transcript), "Checkpoint");
    assert.ok(placed.includes(head) && placed.includes(end) && placed.includes("[… cut; full text: the compaction record in the session history]"));
    assert.ok(agent.estimatedContextTokens() <= budget, `next request ~${agent.estimatedContextTokens()} tokens, budget ${budget}`);
    const record = store.getSessionHistory({ sessionId: id, limit: 100 }).items.findLast((item) => item.kind === "compaction");
    assert.equal(record?.payload.summary, checkpoint.trim());
  } finally { await agent.close(); store.close(); }
});
