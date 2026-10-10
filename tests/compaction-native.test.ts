import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type AgentOptions, type RunEvent } from "../src/agent.js";
import { ENCRYPTED_SUMMARY_NOTE, estimateRequestTokens, NATIVE_CHECKPOINT_BODY } from "../src/compact.js";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage, ProviderAdapter, ProviderRequest, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { openSessionStore, type SessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { anthropicFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { isCompactionRequest } from "./fixtures/compaction.js";

const noise = (bytes: number) => randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes);

function sessionStore() {
  const root = mkdtempSync(join(tmpdir(), "raw-compaction-native-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "native" }).id;
  return { root, store, id };
}

const NATIVE = { keepRecentTurns: 0, maxOutputTokens: 1000, strategy: "native" as const };
function persisted(store: SessionStore, id: string, root: string, provider: ProviderAdapter, extra: Partial<AgentOptions> = {}) {
  return createAgent({ cwd: root, provider, system: "tiny", autoApprove: true, registry: createTestToolRegistry(), compact: NATIVE, ...extra,
    persistence: { store, sessionId: id, surface: "cli" } });
}

const anthropicModel = (url: string): ResolvedModelConfig => ({ agentName: "claude", provider: "anthropic", method: "anthropic-messages",
  model: "claude-opus-5-5", baseUrl: url, apiKey: "fixture", maxOutputTokens: 1000 });
const responsesModel = (url: string): ResolvedModelConfig => ({ agentName: "gpt", provider: "openai", method: "openai-responses",
  model: "gpt-6-astra", baseUrl: url, apiKey: "fixture", maxOutputTokens: 1000 });

/** A streamed Anthropic answer: optional signed thinking, then text. */
function anthropicAnswer(text: string, signature?: string) {
  const blocks = signature ? [
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: `thought ${signature}` } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
    anthropicFrame("content_block_stop", { index: 0 }),
  ] : [];
  const at = blocks.length ? 1 : 0;
  return { frames: [
    anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    ...blocks,
    anthropicFrame("content_block_start", { index: at, content_block: { type: "text", text } }),
    anthropicFrame("content_block_stop", { index: at }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ] };
}

/** The non-streamed reply to an Anthropic compaction request. */
function anthropicCompaction(block: Record<string, unknown> | undefined, stopReason = "compaction") {
  return { body: { id: "msg_c", type: "message", role: "assistant", model: "claude-opus-5-5", content: block ? [block] : [], stop_reason: stopReason,
    stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0,
      iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }] } } };
}

const responsesEvent = (type: string, value: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 1, ...value })}\n\n`;
function responsesAnswer(text: string) {
  const message = { id: `msg_${noise(8)}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return { frames: [responsesEvent("response.completed", { response: { id: "r", object: "response", status: "completed", model: "gpt-6-astra",
    output: [message], usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }), "data: [DONE]\n\n"] };
}

type Body = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }>; input?: unknown[] };
const body = (request: { body: unknown }) => request.body as Body;

test("1: Anthropic native compaction sends the documented request, stores the signed block first and replays it unchanged after a restart", async (t) => {
  const { root, store, id } = sessionStore();
  const block = { type: "compaction", content: `Summary ${noise(40)}`, encrypted_content: `enc-${noise(64)}`, signature: `sig-${noise(48)}` };
  const blockJson = JSON.stringify(block);
  const second = { type: "compaction", content: `Second summary ${noise(40)}`, signature: `sig-${noise(48)}` };
  const fixture = await startMockProvider([
    anthropicAnswer(`first answer ${noise(3000)}`),
    anthropicAnswer(`second answer ${noise(3000)}`, `think-${noise(12)}`),
    anthropicCompaction(block),
    anthropicAnswer(`third answer ${noise(3000)}`),
    anthropicCompaction(second),
    anthropicAnswer("fourth answer"),
  ]);
  t.after(() => fixture.close());
  const events: RunEvent[] = [];
  const agent = persisted(store, id, root, createProvider(anthropicModel(fixture.url)), { compact: { ...NATIVE, instructions: "Keep the release date." } });
  try {
    await agent.run("first");
    await agent.run("second");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
    const request = fixture.requests[2]!;
    assert.match(request.url, /^\/v1\/messages/);
    assert.match(String(request.headers["anthropic-beta"]), /\bcompact-2026-09-04\b/);
    const sent = body(request);
    const compaction = sent.compaction as { type: string; instructions: string };
    assert.equal(compaction.type, "summarize");
    assert.match(compaction.instructions, /## Next actions/);
    assert.match(compaction.instructions, /Keep the release date\./, "compact.instructions are appended");
    assert.doesNotMatch(compaction.instructions, /<analysis>/, "the signed summary cannot have an analysis section stripped");
    assert.equal(sent.stream, undefined);
    for (const key of ["tool_choice", "stop_sequences", "context_management"]) assert.equal(sent[key], undefined, key);
    assert.equal(sent.max_tokens, 1000);
    // Exactly the messages of the request that produced the kept step, with the same system prompt and tools.
    const producer = body(fixture.requests[1]!);
    assert.deepEqual(sent.messages, producer.messages);
    assert.deepEqual(sent.system, producer.system);
    assert.deepEqual(sent.tools, producer.tools);

    const transcript = agent.transcript;
    assert.deepEqual(transcript[0], { role: "assistant", text: block.content, toolCalls: [], opaque: [block] });
    assert.equal(transcript[1]?.role, "assistant", "the kept step follows the block directly");
    assert.match(JSON.stringify(transcript[1]), /think-/);
    assert.ok(transcript[2]?.role === "user" && typeof transcript[2].content === "string"
      && transcript[2].content.startsWith("[Raw compaction checkpoint #1]") && transcript[2].content.includes(NATIVE_CHECKPOINT_BODY)
      && transcript[2].content.includes("first") && transcript[2].content.includes("second"), "the host message with the ledger comes after the tail");
    const end = events.find((event) => event.type === "compact_end");
    assert.equal(end?.type === "compact_end" ? end.details?.strategy : undefined, "native");
    assert.equal(events.some((event) => event.type === "compact_warning"), false);
    assert.ok(agent.usageRecords.some((raw) => JSON.stringify(raw) === JSON.stringify({ type: "compaction", input_tokens: 144, output_tokens: 276,
      cache_read_input_tokens: 100, cache_creation_input_tokens: 0 })), "the compaction iteration's usage is recorded");

    await agent.run("third");
    const next = fixture.requests[3]!;
    assert.match(String(next.headers["anthropic-beta"]), /\bcompact-2026-09-04\b/, "a request carrying the block sends the beta");
    assert.equal(JSON.stringify((body(next).messages![0]!.content as unknown[])[0]), blockJson);
    assert.equal(body(next).messages![0]!.role, "assistant");

    // Compacting again sends the block, the kept step and the earlier host message exactly as the last request did.
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    assert.deepEqual(body(fixture.requests[4]!).messages, body(next).messages);
    assert.deepEqual(agent.transcript[0], { role: "assistant", text: second.content, toolCalls: [], opaque: [second] });
    assert.equal(agent.transcript.filter((message) => typeof (message as { content?: unknown }).content === "string"
      && String((message as { content: string }).content).startsWith("[Raw compaction checkpoint #")).length, 1, "the earlier host message is replaced");
  } finally { await agent.close(); }
  const resumed = persisted(store, id, root, createProvider(anthropicModel(fixture.url)));
  try {
    await resumed.run("fourth");
    const after = body(fixture.requests[5]!);
    assert.equal(JSON.stringify((after.messages![0]!.content as unknown[])[0]), JSON.stringify(second), "byte-for-byte after a restart");
    assert.equal(after.messages!.filter((message) => JSON.stringify(message.content).includes("\"compaction\"")).length, 1, "exactly one block");
  } finally { await resumed.close(); store.close(); }
});

test("2: Responses native compaction stores every returned item, sends them first and unchanged, also after a restart", async (t) => {
  const { root, store, id } = sessionStore();
  const output = [
    { id: "msg_u1", type: "message", role: "user", status: "completed", content: [{ type: "input_text", text: "first" }] },
    { id: "msg_u2", type: "message", role: "user", status: "completed", content: [{ type: "input_text", text: "second" }] },
    { id: `cmp_${noise(8)}`, type: "compaction", encrypted_content: `enc-${noise(80)}`, created_by: "server" },
  ];
  const fixture = await startMockProvider([
    responsesAnswer(`first answer ${noise(3000)}`),
    responsesAnswer(`second answer ${noise(3000)}`),
    { body: { id: "rc", created_at: 1, object: "response.compaction", output, usage: { input_tokens: 300, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } },
    responsesAnswer("third answer"),
    responsesAnswer("fourth answer"),
  ]);
  t.after(() => fixture.close());
  const agent = persisted(store, id, root, createProvider(responsesModel(fixture.url)));
  try {
    await agent.run("first");
    await agent.run("second");
    assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    const request = fixture.requests[2]!;
    assert.equal(request.url, "/responses/compact");
    const sent = body(request);
    assert.equal(sent.model, "gpt-6-astra");
    assert.equal(sent.instructions, "tiny");
    assert.equal(sent.tools, undefined);
    assert.deepEqual(sent.input, body(fixture.requests[1]!).input, "the input of the request that produced the kept step");
    const transcript = agent.transcript;
    assert.deepEqual(transcript[0], { role: "assistant", text: ENCRYPTED_SUMMARY_NOTE, toolCalls: [], opaque: output });
    // Only the items are sent, so the portable text adds nothing to the estimate.
    assert.equal(estimateRequestTokens("tiny", [{ ...transcript[0]!, text: "x".repeat(20000) } as ModelMessage], []),
      estimateRequestTokens("tiny", [transcript[0]!], []));
    await agent.run("third");
    assert.equal(JSON.stringify(body(fixture.requests[3]!).input!.slice(0, output.length)), JSON.stringify(output));
  } finally { await agent.close(); }
  const resumed = persisted(store, id, root, createProvider(responsesModel(fixture.url)));
  try {
    await resumed.run("fourth");
    const input = body(fixture.requests[4]!).input!;
    assert.equal(JSON.stringify(input.slice(0, output.length)), JSON.stringify(output), "byte-for-byte after a restart");
    assert.ok(input.slice(output.length).every((item) => (item as { type?: string }).type !== "compaction"));
  } finally { await resumed.close(); store.close(); }
});

test("3: after a native compaction, a resume on another provider sends the summary as portable user text", async (t) => {
  // Anthropic -> Responses: the readable summary leads as user input; no compaction item reaches the other API.
  {
    const { root, store, id } = sessionStore();
    const block = { type: "compaction", content: `Summary ${noise(40)}`, signature: `sig-${noise(48)}` };
    const anthropic = await startMockProvider([anthropicAnswer(`a ${noise(3000)}`), anthropicAnswer(`b ${noise(3000)}`), anthropicCompaction(block)]);
    t.after(() => anthropic.close());
    const responses = await startMockProvider([responsesAnswer("switched")]);
    t.after(() => responses.close());
    const agent = persisted(store, id, root, createProvider(anthropicModel(anthropic.url)));
    try {
      await agent.run("first");
      await agent.run("second");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    } finally { await agent.close(); }
    const resumed = persisted(store, id, root, createProvider(responsesModel(responses.url)));
    try {
      assert.equal((await resumed.run("third")).status, "completed");
      const input = body(responses.requests[0]!).input as Array<{ role?: string; type?: string; content?: unknown }>;
      assert.deepEqual(input[0], { role: "user", content: `[Earlier conversation summary]\n${block.content}` });
      assert.doesNotMatch(JSON.stringify(input), /"compaction"|sig-/);
    } finally { await resumed.close(); store.close(); }
  }
  // Responses -> Anthropic: the encrypted item becomes its note; the Anthropic request is valid and needs no beta.
  {
    const { root, store, id } = sessionStore();
    const output = [{ id: "cmp_1", type: "compaction", encrypted_content: `enc-${noise(80)}` }];
    const responses = await startMockProvider([responsesAnswer(`a ${noise(3000)}`), responsesAnswer(`b ${noise(3000)}`),
      { body: { id: "rc", created_at: 1, object: "response.compaction", output, usage: { input_tokens: 1, output_tokens: 1 } } }]);
    t.after(() => responses.close());
    const anthropic = await startMockProvider([anthropicAnswer("switched")]);
    t.after(() => anthropic.close());
    const agent = persisted(store, id, root, createProvider(responsesModel(responses.url)));
    try {
      await agent.run("first");
      await agent.run("second");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
    } finally { await agent.close(); }
    const resumed = persisted(store, id, root, createProvider(anthropicModel(anthropic.url)));
    try {
      assert.equal((await resumed.run("third")).status, "completed");
      const request = anthropic.requests[0]!;
      const messages = body(request).messages!;
      assert.deepEqual(messages[0], { role: "user", content: `[Earlier conversation summary]\n${ENCRYPTED_SUMMARY_NOTE}` });
      assert.doesNotMatch(JSON.stringify(messages), /"compaction"|enc-/);
      assert.doesNotMatch(String(request.headers["anthropic-beta"] ?? ""), /compact/);
    } finally { await resumed.close(); store.close(); }
  }
});

/** A fake provider: main requests answer from `script`, checkpoint requests with a fixed checkpoint; `compact` is optional. */
function fake(model: Partial<ResolvedModelConfig>, script: ProviderTurn[], compact?: ProviderAdapter["compact"]) {
  const summaries: ProviderRequest[] = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", ...model },
    async generate(request) {
      if (isCompactionRequest(request)) { summaries.push(request); return { text: "## Goal\nKeep going.", toolCalls: [], finishReason: "stop" }; }
      return script.shift() ?? { text: `answer ${noise(3000)}`, toolCalls: [], finishReason: "stop" };
    }, ...(compact ? { compact } : {}) };
  return { provider, summaries };
}
const warnings = (events: readonly RunEvent[]) => events.flatMap((event) => event.type === "compact_warning" ? [event.message] : []);

test("4: an adapter without native compaction, a native error and a broken kept-thinking boundary each fall back to a checkpoint with a warning", async (t) => {
  // No native API: a checkpoint, warned once per session.
  {
    const { root, store, id } = sessionStore();
    const { provider, summaries } = fake({}, []);
    const agent = persisted(store, id, root, provider);
    const events: RunEvent[] = [];
    try {
      for (const input of ["one", "two", "three", "four"]) {
        await agent.run(input);
        if (input === "two" || input === "four") assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
      }
      assert.equal(summaries.length, 2);
      assert.deepEqual(warnings(events), ["Provider-native compaction not used: the openai-chat-completions API has no native compaction; using checkpoint compaction."]);
      assert.ok(agent.transcript[0]?.role === "user" && String(agent.transcript[0].content).startsWith("[Raw compaction checkpoint #2]"));
      await agent.close();
      // A host creates an agent per operation; the next one on the same session does not warn again, another session does.
      for (const [sessionId, expected] of [[id, 1], [store.createSession({ cwd: root, title: "other" }).id, 2]] as const) {
        const next = persisted(store, sessionId, root, provider);
        try {
          await next.run("five");
          await next.run("six");
          assert.equal((await next.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
        } finally { await next.close(); }
        assert.equal(warnings(events).length, expected);
      }
    } finally { await agent.close(); store.close(); }
  }
  // Without persistence the session is the agent itself; a tool-view change in between does not warn again.
  {
    const { provider } = fake({}, []);
    const agent = createAgent({ cwd: tmpdir(), provider, system: "tiny", autoApprove: true, registry: createTestToolRegistry(), compact: NATIVE });
    const events: RunEvent[] = [];
    try {
      for (const input of ["one", "two", "three", "four"]) {
        await agent.run(input);
        if (input === "two" || input === "four") assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
        if (input === "two") assert.equal(agent.setToolView(["read_file"]), 2);
      }
      assert.equal(warnings(events).length, 1);
    } finally { await agent.close(); }
  }
  // A permanent request error (HTTP 400) falls back and turns native off; a missing summary only falls back.
  for (const [failure, permanent] of [[{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "compaction is not supported" } } }, true],
    [anthropicCompaction(undefined, "refusal"), false]] as const) {
    const { root, store, id } = sessionStore();
    const checkpoint = anthropicAnswer("## Goal\nKeep going.");
    const fixture = await startMockProvider([anthropicAnswer(`a ${noise(3000)}`), anthropicAnswer(`b ${noise(3000)}`), failure, checkpoint,
      anthropicAnswer(`c ${noise(3000)}`), ...(permanent ? [] : [failure]), checkpoint,
      ...(permanent ? [anthropicAnswer(`d ${noise(3000)}`), anthropicAnswer(`e ${noise(3000)}`), checkpoint] : [])]);
    t.after(() => fixture.close());
    const agent = persisted(store, id, root, createProvider(anthropicModel(fixture.url)));
    const events: RunEvent[] = [];
    try {
      await agent.run("first");
      await agent.run("second");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
      assert.match(warnings(events)[0] ?? "", /the provider request failed/);
      assert.ok(agent.transcript[0]?.role === "user" && String(agent.transcript[0].content).includes("Keep going."), "the checkpoint strategy ran");
      await agent.run("third");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
      const compactions = fixture.requests.filter((request) => (request.body as Body).compaction !== undefined).length;
      assert.equal(compactions, permanent ? 1 : 2, permanent ? "native is off after a permanent error" : "a missing summary is retried next time");
      assert.equal(fixture.requests.length, permanent ? 6 : 7);
      if (permanent) {
        assert.match(warnings(events)[1] ?? "", /failed earlier in this process/);
        // Native stays off for this model in the rest of the process, also for another agent and session.
        const other = persisted(store, store.createSession({ cwd: root, title: "other" }).id, root, createProvider(anthropicModel(fixture.url)));
        const otherEvents: RunEvent[] = [];
        try {
          await other.run("fourth");
          await other.run("fifth");
          assert.equal((await other.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => otherEvents.push(event))).status, "compacted");
        } finally { await other.close(); }
        assert.equal(fixture.requests.filter((request) => (request.body as Body).compaction !== undefined).length, 1);
        assert.equal(fixture.requests.length, 9);
        assert.match(warnings(otherEvents)[0] ?? "", /failed earlier in this process/);
      }
    } finally { await agent.close(); store.close(); }
  }
  // Thinking in the tail that would not directly follow the summarized messages: no native request.
  {
    const { root, store, id } = sessionStore();
    const block = { type: "compaction", content: `Summary ${noise(40)}`, signature: `sig-${noise(48)}` };
    const fixture = await startMockProvider([anthropicAnswer(`a ${noise(3000)}`), anthropicAnswer(`b ${noise(3000)}`, "sig-b"), anthropicCompaction(block),
      anthropicAnswer(`c ${noise(3000)}`, "sig-c"), anthropicAnswer("## Goal\nKeep going.")]);
    t.after(() => fixture.close());
    const agent = persisted(store, id, root, createProvider(anthropicModel(fixture.url)));
    const events: RunEvent[] = [];
    try {
      await agent.run("first");
      await agent.run("second");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted");
      await agent.run("third");
      // Keeping every step after the block keeps the earlier host message inside the tail range, so it would be dropped.
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 100000 }, (event) => events.push(event))).status, "compacted");
      assert.match(warnings(events)[0] ?? "", /merge into the summarized messages|host note inside the recent steps/);
      assert.equal(fixture.requests.filter((request) => (request.body as Body).compaction !== undefined).length, 1);
    } finally { await agent.close(); store.close(); }
  }
});

test("5: without a strategy, or with \"checkpoint\", native compaction is never asked for and requests match", async () => {
  const runs: Array<{ requests: string; transcript: ModelMessage[]; warnings: string[] }> = [];
  // The working state names the cwd, so both runs share one.
  const cwd = mkdtempSync(join(tmpdir(), "raw-native-default-"));
  for (const strategy of [undefined, "checkpoint"] as const) {
    let calls = 0;
    const { provider, summaries } = fake({ provider: "anthropic", method: "anthropic-messages" }, [], async () => { calls++; throw new Error("unexpected"); });
    const main: ProviderRequest[] = [];
    const generate = provider.generate.bind(provider);
    provider.generate = async (request) => { if (!isCompactionRequest(request)) main.push(request); return generate(request); };
    const agent = createAgent({ cwd, provider, system: "tiny", registry: createTestToolRegistry(),
      compact: { keepRecentTurns: 0, maxOutputTokens: 1000, ...(strategy ? { strategy } : {}) } });
    const events: RunEvent[] = [];
    try {
      await agent.run("one");
      await agent.run("two");
      assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 }, (event) => events.push(event))).status, "compacted");
      await agent.run("three");
    } finally { await agent.close(); }
    assert.equal(calls, 0);
    const strip = (request: ProviderRequest) => ({ system: request.system, tools: request.tools, messages: request.messages, toolChoice: request.toolChoice,
      maxOutputTokens: request.maxOutputTokens });
    runs.push({ requests: JSON.stringify([...main, ...summaries].map(strip)).replace(/answer [0-9a-f]+/g, "answer"),
      transcript: agent.transcript.map((message) => JSON.parse(JSON.stringify(message).replace(/answer [0-9a-f]+/g, "answer")) as ModelMessage),
      warnings: warnings(events) });
  }
  assert.equal(runs[0]!.requests, runs[1]!.requests);
  assert.deepEqual(runs[0]!.transcript, runs[1]!.transcript);
  assert.deepEqual(runs[0]!.warnings, []);
  assert.deepEqual(runs[1]!.warnings, []);
  assert.ok(runs[0]!.transcript[0]?.role === "user", "the checkpoint message leads, as before");
});

test("6: compact.strategy accepts \"checkpoint\" and \"native\" and rejects anything else", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "raw-native-config-")), "config.json");
  const load = async (compact: Record<string, unknown>) => {
    writeFileSync(path, JSON.stringify({ default_agent: "p", models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
      agents: { p: { model: "m", tools: { use: ["builtin/read_file"] }, compact } } }));
    return (await loadConfig({ configPath: path, env: {}, requireModel: true })).compact.strategy;
  };
  assert.equal(await load({ strategy: "native" }), "native");
  assert.equal(await load({ strategy: "checkpoint" }), undefined);
  assert.equal(await load({}), undefined);
  for (const invalid of ["server", 1, null]) await assert.rejects(load({ strategy: invalid }), /compact\.strategy must be "checkpoint" or "native"/);
});
