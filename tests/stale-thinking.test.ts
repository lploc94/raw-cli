import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type RunEvent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import type { ProviderAdapter, ResolvedModelConfig } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { anthropicFrame, startMockProvider, type MockResponse } from "./fixtures/mock-provider.js";

// Thinking signed before a rewrite (compaction, clearing) is bound to the old prefix. The first request after the rewrite asks
// Anthropic to drop what no longer matches (`thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, beta
// thinking-binding-controls-2026-08-01) and later requests no longer send what it dropped. Frames follow SDK 0.128's
// `BetaMessage.input_transformations` and `BetaThinkingDroppedInputTransformation`.

const BETA = "thinking-binding-controls-2026-08-01";
const noise = (bytes: number) => randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes);
type Body = { messages: Array<{ role: string; content: unknown }>; thinking?: Record<string, unknown> };

/** One streamed response: a signed thinking block, then text or a `probe` call; `transformations` goes on `message_start`. */
function reply(signature: string, body: { text?: string; call?: string }, transformations?: unknown): MockResponse {
  const blocks = [
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: `thought ${signature}` } }),
    anthropicFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    ...body.call !== undefined ? [
      anthropicFrame("content_block_start", { index: 1, content_block: { type: "tool_use", id: body.call, name: "probe", input: {} } }),
      anthropicFrame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ out: body.call }) } }),
      anthropicFrame("content_block_stop", { index: 1 }),
    ] : body.text === undefined ? [] : [
      anthropicFrame("content_block_start", { index: 1, content_block: { type: "text", text: body.text } }),
      anthropicFrame("content_block_stop", { index: 1 }),
    ],
  ];
  return { frames: [
    anthropicFrame("message_start", { message: { id: `m-${signature}`, type: "message", role: "assistant", content: [], model: "fixture",
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      ...(transformations !== undefined ? { input_transformations: transformations } : {}) } }),
    ...blocks,
    anthropicFrame("message_delta", { delta: { stop_reason: body.call !== undefined ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ] };
}

const summarizer: ProviderAdapter = { modelConfig: { agentName: "summarizer", provider: "ollama", method: "openai-chat-completions", model: "summarizer" },
  async generate() { return { text: "## Goal\nKeep going.", toolCalls: [], finishReason: "stop" }; } };

/**
 * Three runs before a compaction that keeps the last two (a tool step, then an answer): stored context after it is
 * [checkpoint, "first", sig-1 call, result, sig-2 answer, "second", sig-3 answer]; the checkpoint and "first" share one wire
 * user message, so wire index i of an assistant message is not its stored index.
 */
async function compacted(after: MockResponse[], model: Partial<ResolvedModelConfig> = {}, second = reply("sig-3", { text: "two" })) {
  const root = mkdtempSync(join(tmpdir(), "raw-stale-thinking-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const sessionId = store.createSession({ cwd: root, title: "stale thinking" }).id;
  const fixture = await startMockProvider([
    reply("sig-0", { text: `zero ${noise(4000)}` }),
    reply("sig-1", { call: "t1" }), reply("sig-2", { text: "one" }),
    second,
    ...after,
  ]);
  const config: ResolvedModelConfig = { agentName: "claude", provider: "anthropic", method: "anthropic-messages", model: "fixture",
    baseUrl: fixture.url, apiKey: "fixture", maxOutputTokens: 1000, request: { kind: "anthropic", thinking: { type: "adaptive" } }, ...model };
  const registry = createTestToolRegistry();
  registry.register({ name: "probe", description: "probe", inputSchema: { type: "object", properties: { out: { type: "string" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: `probed ${String(args.out)}` }] }) });
  const events: RunEvent[] = [];
  const open = () => createAgent({ cwd: root, provider: createProvider(config), system: "tiny", autoApprove: true, registry,
    persistence: { store, sessionId, surface: "cli" } });
  const agent = open();
  const close = async () => { await agent.close(); store.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); };
  try {
    await agent.run("zero");
    await agent.run("first");
    await agent.run("second");
    // The two kept runs fit in 500 tokens; the 4000-byte first answer does not.
    assert.equal((await agent.compact({ provider: summarizer, keepRecentTurns: 2, keepRecentTokens: 500 })).status, "compacted");
    const stored = JSON.stringify(agent.transcript);
    for (const signature of ["sig-1", "sig-2", "sig-3"]) assert.match(stored, new RegExp(signature), `the kept steps hold ${signature}`);
    assert.doesNotMatch(stored, /sig-0/, "the first run was summarized");
  } catch (error) { await close(); throw error; }
  const body = (index: number) => fixture.requests[index]!.body as Body;
  const beta = (index: number) => String(fixture.requests[index]!.headers["anthropic-beta"] ?? "");
  return { agent, open, store, fixture, body, beta, events, close, first: 4 };
}

// The open-call exception of the local removal is covered by tests/context-clearing.test.ts 4 and 5 (clearing mid-run).
const signatures = (body: Body) => [...JSON.stringify(body.messages).matchAll(/"signature":"(sig-\d)"/g)].map((match) => match[1]);

test("after a compaction exactly one request asks to drop stale thinking, and the blocks it dropped are never sent again", async () => {
  const dropped = [
    { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
    { type: "thinking_dropped", path: "messages.5.content.0", reason: "prefix_binding_mismatch" },
    { type: "thinking_mismatch_allowed", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
  ];
  const run = await compacted([reply("sig-4", { text: "three" }, dropped), reply("sig-5", { text: "four" }), reply("sig-6", { text: "five" })]);
  try {
    for (let index = 0; index < run.first; index++) {
      assert.equal(run.body(index).thinking?.block_binding, undefined, `ordinary request ${index} sends no binding`);
      assert.doesNotMatch(run.beta(index), new RegExp(BETA), `ordinary request ${index} sends no beta`);
    }
    await run.agent.run("third");
    const first = run.body(run.first);
    assert.deepEqual(first.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      "the binding joins the configured thinking object");
    assert.match(run.beta(run.first), new RegExp(BETA));
    assert.deepEqual(signatures(first), ["sig-1", "sig-2", "sig-3"]);
    await run.agent.run("fourth");
    const second = run.body(run.first + 1);
    assert.equal(second.thinking?.block_binding, undefined, "only the first request after the rewrite asks");
    assert.doesNotMatch(run.beta(run.first + 1), new RegExp(BETA));
    // Wire messages 1 and 5 are stored messages 2 and 6: sig-1 and sig-3. sig-2 was only reported as allowed.
    assert.deepEqual(signatures(second), ["sig-2", "sig-4"], "exactly the dropped blocks are gone");
    await run.agent.run("fifth");
    const third = run.body(run.first + 2);
    assert.deepEqual(third.messages.slice(0, second.messages.length - 1), second.messages.slice(0, -1),
      "the request after extends the one before (its last user message gains the reply)");
    assert.deepEqual(signatures(third), ["sig-2", "sig-4", "sig-5"]);
  } finally { await run.close(); }
});

test("an empty report drops nothing, and the next request extends the one that asked", async () => {
  const run = await compacted([reply("sig-4", { text: "three" }, []), reply("sig-5", { text: "four" })]);
  try {
    await run.agent.run("third");
    await run.agent.run("fourth");
    const asked = run.body(run.first);
    assert.notEqual(asked.thinking?.block_binding, undefined, "the first request after the compaction asked");
    const next = run.body(run.first + 1);
    assert.deepEqual(signatures(next), ["sig-1", "sig-2", "sig-3", "sig-4"]);
    assert.deepEqual(next.messages.slice(0, asked.messages.length - 1), asked.messages.slice(0, -1));
    assert.equal(next.thinking?.block_binding, undefined);
  } finally { await run.close(); }
});

test("without a report the stale thinking is removed locally, except that of a still-open tool call", async () => {
  // The response reports nothing, as when the beta is ignored; its tool call stays open in the next request.
  const run = await compacted([reply("sig-4", { call: "t2" }), reply("sig-5", { text: "done" }), reply("sig-6", { text: "later" })]);
  try {
    await run.agent.run("third");
    assert.deepEqual(signatures(run.body(run.first + 1)), ["sig-4"], "pre-compaction thinking is gone; the new step's is sent");
    assert.doesNotMatch(JSON.stringify(run.agent.transcript), /sig-[123]/, "and not kept to be sent later");
  } finally { await run.close(); }
});

test("a provider that refuses the binding is asked once without it, and the stale thinking is removed first", async () => {
  const refused: MockResponse = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "thinking.block_binding: Extra inputs are not permitted" } } };
  const run = await compacted([refused, reply("sig-4", { text: "three" }), reply("sig-5", { text: "four" })]);
  try {
    const warnings: string[] = [];
    const result = await run.agent.run("third", (event) => { if (event.type === "compact_warning") warnings.push(event.message); });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "three");
    assert.equal(run.body(run.first).thinking?.block_binding !== undefined, true, "the refused request asked");
    const retry = run.body(run.first + 1);
    assert.equal(retry.thinking?.block_binding, undefined, "the retry does not");
    assert.doesNotMatch(run.beta(run.first + 1), new RegExp(BETA));
    assert.deepEqual(signatures(retry), [], "and holds no stale thinking");
    assert.equal(warnings.length, 1, `one warning: ${warnings.join(" | ")}`);
    assert.match(warnings[0]!, /binding/);
    await run.agent.run("fourth");
    assert.deepEqual(signatures(run.body(run.first + 2)), ["sig-4"]);
  } finally { await run.close(); }
});

for (const [name, model] of [
  ["a third-party service on the Anthropic method", { provider: "gateway" }],
  ["Anthropic without configured thinking", { request: { kind: "anthropic" as const } }],
] as const) {
  test(`${name} gets no binding; the stale thinking is removed locally`, async () => {
    const run = await compacted([reply("sig-4", { text: "three" }), reply("sig-5", { text: "four" })], model);
    try {
      await run.agent.run("third");
      const first = run.body(run.first);
      assert.equal(first.thinking?.block_binding, undefined);
      assert.doesNotMatch(run.beta(run.first), new RegExp(BETA));
      assert.deepEqual(signatures(first), [], "no thinking from before the compaction is sent");
      await run.agent.run("fourth");
      assert.deepEqual(signatures(run.body(run.first + 1)), ["sig-4"]);
    } finally { await run.close(); }
  });
}

test("a restart between the compaction and the next request keeps the boundary", async () => {
  const dropped = [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }];
  const run = await compacted([reply("sig-4", { text: "three" }, dropped), reply("sig-5", { text: "four" })]);
  try {
    await run.agent.close();
    const resumed = run.open();
    try {
      await resumed.run("third");
      assert.equal(run.body(run.first).thinking?.block_binding !== undefined, true, "the resumed session asks");
      await resumed.run("fourth");
      assert.deepEqual(signatures(run.body(run.first + 1)), ["sig-2", "sig-3", "sig-4"]);
    } finally { await resumed.close(); }
  } finally { await run.close(); }
});

for (const [name, model, transformations] of [
  ["the API drops it", {}, [{ type: "thinking_dropped", path: "messages.5.content.0", reason: "prefix_binding_mismatch" }]],
  ["Raw removes it", { provider: "gateway" }, undefined],
] as const) {
  test(`an answer that was only thinking keeps a text block when ${name}, so no assistant message is sent empty`, async () => {
    // "second" is answered with signed thinking and no text: removing the thinking must not leave `content: []`.
    const run = await compacted([reply("sig-4", { text: "three" }, transformations), reply("sig-5", { text: "four" })], model, reply("sig-3", {}));
    try {
      await run.agent.run("third");
      await run.agent.run("fourth");
      const sent = run.body(run.first + 1);
      assert.doesNotMatch(JSON.stringify(sent.messages), /sig-3/, "the stale thinking is gone");
      for (const [index, message] of sent.messages.entries()) {
        assert.ok(!Array.isArray(message.content) || message.content.length > 0, `message ${index} (${message.role}) has content`);
      }
    } finally { await run.close(); }
  });
}
