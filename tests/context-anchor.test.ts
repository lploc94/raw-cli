import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type RunEvent } from "../src/agent.js";
import { estimateRequestTokens } from "../src/compact.js";
import { anchoredEstimate, parseAnchor } from "../src/context-anchor.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { measureSession } from "../src/sessions/metrics.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const usage = (input: number, output: number) => ({ prompt_tokens: input, completion_tokens: output });
const reply = (text: string, reported?: unknown): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop", ...(reported === undefined ? {} : { usage: reported }) });
const provider = (generate: (request: ProviderRequest) => Promise<ProviderTurn>, extra: Record<string, unknown> = {}): ProviderAdapter =>
  ({ modelConfig: { agentName: "t", provider: "ollama", method: "openai-chat-completions", model: "fixture", ...extra } as ProviderAdapter["modelConfig"], generate });
const raw = (agent: ReturnType<typeof createAgent>, system: string) => estimateRequestTokens(system, agent.transcript, agent.toolDefinitions);
const BIG_SYSTEM = "s".repeat(8000);

test("after a response the context size is what the provider reported, not the byte estimate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const agent = createAgent({ cwd, provider: provider(async () => reply("hello", usage(1000, 20))), system: BIG_SYSTEM, registry: createTestToolRegistry() });
  assert.ok(agent.estimatedContextTokens() >= 4000, "before any response only the estimate exists");
  assert.equal(agent.contextUsage().source, "estimate");
  await agent.run("hi");
  assert.equal(agent.estimatedContextTokens(), 1020, "input plus output tokens of the last response");
  assert.deepEqual(agent.contextUsage(), { tokens: 1020, source: "provider" });
});

test("content added after the response is estimated on top of the reported size", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  let seen = 0;
  const agent = createAgent({ cwd, system: BIG_SYSTEM, registry: createTestToolRegistry(), provider: provider(async () => {
    if (!seen) { seen = -1; return reply("first", usage(1000, 20)); }
    seen = agent.estimatedContextTokens();
    return reply("second", usage(1500, 10));
  }) });
  await agent.run("hi");
  await agent.run("m".repeat(4000));
  assert.ok(seen >= 1020 + 2000 && seen <= 1020 + 2100, `expected reported size plus about 2000 estimated tokens, got ${seen}`);
  assert.equal(agent.estimatedContextTokens(), 1510);
});

test("without provider usage the estimate is used unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const agent = createAgent({ cwd, provider: provider(async () => reply("hello")), system: BIG_SYSTEM, registry: createTestToolRegistry() });
  await agent.run("hi");
  assert.equal(agent.estimatedContextTokens(), raw(agent, BIG_SYSTEM));
  assert.equal(agent.contextUsage().source, "estimate");
});

test("a response whose usage lacks token counts leaves the previous reported size in place", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  let call = 0;
  const agent = createAgent({ cwd, system: BIG_SYSTEM, registry: createTestToolRegistry(), provider: provider(async () => reply("x", ++call === 1 ? usage(1000, 20) : {})) });
  await agent.run("one");
  await agent.run("two");
  const size = agent.estimatedContextTokens();
  assert.ok(size > 1020 && size < raw(agent, BIG_SYSTEM), `previous anchor plus the estimated growth, got ${size}`);
});

test("a usage report without output tokens is not a reported size", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const agent = createAgent({ cwd, provider: provider(async () => reply("ok", { prompt_tokens: 1000 })), system: BIG_SYSTEM, registry: createTestToolRegistry() });
  await agent.run("hi");
  assert.equal(agent.contextUsage().source, "estimate");
  assert.equal(agent.estimatedContextTokens(), raw(agent, BIG_SYSTEM));
  const zero = createAgent({ cwd, provider: provider(async () => reply("ok", usage(1000, 0))), system: BIG_SYSTEM, registry: createTestToolRegistry() });
  await zero.run("hi");
  assert.deepEqual(zero.contextUsage(), { tokens: 1000, source: "provider" }, "a reported zero is a real count");
});

test("what is added after the reported size is scaled by the calibration the provider's own counts demanded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  let seen = 0;
  let call = 0;
  const agent = createAgent({ cwd, system: BIG_SYSTEM, registry: createTestToolRegistry(), compact: { triggerTokens: 900_000, keepRecentTurns: 1, maxOutputTokens: 100 },
    provider: provider(async (request) => {
      if (++call === 1) return reply("first", usage(3 * estimateRequestTokens(request.system, request.messages, request.tools), 20));
      seen = agent.estimatedContextTokens();
      return reply("second", usage(50_000, 10));
    }, { contextWindow: 1_000_000, maxOutputTokens: 100 }) });
  await agent.run("hi");
  const anchored = agent.estimatedContextTokens();
  await agent.run("m".repeat(4000));
  assert.ok(seen >= anchored + 3 * 2000, `the 4000-byte addition (about 2000 estimated tokens) must be scaled by the calibration of about 3.3, got ${seen - anchored}`);
});

test("a changed image projection or replay boundary does not reuse the reported size", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const open = (id: string, extra: Record<string, unknown>) => createAgent({ cwd: root, system: BIG_SYSTEM, registry: createTestToolRegistry(),
    provider: provider(async () => reply("ok", usage(1000, 20)), extra), persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const images = store.createSession({ cwd: root, title: "images" }).id;
    const first = open(images, { vision: false });
    await first.run("hi");
    await first.close();
    const visual = open(images, { vision: true });
    assert.equal(visual.contextUsage().source, "estimate", "images are projected differently on a vision model");
    await visual.close();
    const replay = store.createSession({ cwd: root, title: "replay" }).id;
    const live = open(replay, {});
    await live.run("hi");
    assert.equal(live.contextUsage().source, "provider");
    live.setToolView(["read_file"]);
    assert.equal(live.contextUsage().source, "estimate", "a new tool view moves the replay boundary");
    await live.close();
  } finally { store.close(); }
});

test("metrics say whether the size was reported or estimated", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const model = { agentName: "t", provider: "ollama", method: "openai-chat-completions", model: "fixture", contextWindow: 200_000, maxOutputTokens: 1000 } as never;
  const agent = createAgent({ cwd, provider: provider(async () => reply("ok", usage(900, 10))), system: BIG_SYSTEM, registry: createTestToolRegistry() });
  const measure = () => measureSession(agent, model, { startedAt: performance.now(), firstRequest: 0, startedTools: 0, failedTools: 0 }).context;
  assert.equal(measure().source, "estimate");
  await agent.run("hi");
  assert.deepEqual([measure().estimatedTokens, measure().source], [910, "provider"]);
});

test("auto compact is judged on the reported size, so a large tool schema no longer triggers it early", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const run = async (second: string) => {
    let call = 0;
    const agent = createAgent({ cwd, system: BIG_SYSTEM, registry: createTestToolRegistry(), compact: { triggerTokens: 5000, keepRecentTurns: 1, maxOutputTokens: 100 },
      provider: provider(async () => reply("ok", usage(1000 + 10 * ++call, 20)), { contextWindow: 20_000, maxOutputTokens: 100 }) });
    await agent.run("first");
    const events: string[] = [];
    await agent.run(second, (event: RunEvent) => events.push(event.type));
    return events;
  };
  assert.ok(!(await run("small follow-up")).includes("compact_start"), "the byte estimate alone (over 5000) must not start a compaction");
  assert.ok((await run("m".repeat(9000))).includes("compact_start"), "a large addition on top of the reported size still does");
});

test("compaction drops the reported size until the next response", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const agent = createAgent({ cwd, system: "tiny", registry: createTestToolRegistry(), compact: { keepRecentTurns: 1, maxOutputTokens: 100 },
    provider: provider(async (request) => request.system === "tiny" ? reply("answer ".repeat(200), usage(5000, 200)) : reply("Summary.", usage(60, 5))) });
  await agent.run("first");
  await agent.run("second");
  assert.equal(agent.estimatedContextTokens(), 5200);
  assert.equal((await agent.compact({ keepRecentTurns: 1 })).status, "compacted");
  assert.equal(agent.contextUsage().source, "estimate");
  assert.ok(agent.estimatedContextTokens() < 5200);
  assert.equal(agent.estimatedContextTokens(), Math.ceil(raw(agent, "tiny")));
});

test("clear forgets the reported size", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const agent = createAgent({ cwd, provider: provider(async () => reply("ok", usage(1000, 20))), system: BIG_SYSTEM, registry: createTestToolRegistry() });
  await agent.run("hi");
  agent.clear();
  assert.equal(agent.contextUsage().source, "estimate");
  assert.equal(agent.estimatedContextTokens(), raw(agent, BIG_SYSTEM));
});

test("the reported size survives a restart and is dropped when the system prompt or model changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-anchor-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "s" }).id;
  const open = (system: string, model = "fixture") => createAgent({ cwd: root, system, registry: createTestToolRegistry(),
    provider: provider(async () => reply("ok", usage(1000, 20)), { model }), persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const first = open(BIG_SYSTEM);
    await first.run("hi");
    await first.close();
    const same = open(BIG_SYSTEM);
    assert.deepEqual(same.contextUsage(), { tokens: 1020, source: "provider" });
    await same.close();
    const otherSystem = open(BIG_SYSTEM + " changed");
    assert.equal(otherSystem.contextUsage().source, "estimate");
    await otherSystem.close();
    const otherModel = open(BIG_SYSTEM, "another-model");
    assert.equal(otherModel.contextUsage().source, "estimate");
    await otherModel.close();
  } finally { store.close(); }
});

test("anchor parsing and arithmetic reject unusable or stale anchors", () => {
  const good = { tokens: 1020, base: 4000, messageCount: 2, signature: "sig" };
  assert.deepEqual(parseAnchor(structuredClone(good), 2), good);
  assert.deepEqual(parseAnchor(good, 5), good);
  for (const bad of [undefined, null, "x", 7, {}, { ...good, tokens: -1 }, { ...good, tokens: Number.NaN }, { ...good, base: 0 }, { ...good, messageCount: 1.5 },
    { ...good, signature: "" }, { ...good, messageCount: 9 }]) assert.equal(parseAnchor(bad, 2), undefined, JSON.stringify(bad));
  assert.deepEqual(anchoredEstimate(good, "sig", 2, 4000), { tokens: 1020, exact: true });
  assert.deepEqual(anchoredEstimate(good, "sig", 3, 4600), { tokens: 1620, exact: false });
  assert.deepEqual(anchoredEstimate(good, "sig", 3, 4600, 2.5), { tokens: 1020 + 1500, exact: false }, "the addition is scaled, the reported part is not");
  assert.deepEqual(anchoredEstimate(good, "sig", 3, 4601, 1.5), { tokens: 1020 + 902, exact: false }, "scaled additions round up");
  assert.deepEqual(anchoredEstimate(good, "sig", 2, 4000, 3), { tokens: 1020, exact: true });
  assert.equal(anchoredEstimate(good, "other", 2, 4000), undefined, "another prompt, tool set or model");
  assert.equal(anchoredEstimate(good, "sig", 1, 4000), undefined, "fewer messages than the anchor covers");
  assert.equal(anchoredEstimate(good, "sig", 2, 3999), undefined, "a smaller request than the anchored one means the context changed");
  assert.equal(anchoredEstimate(undefined, "sig", 2, 4000), undefined);
});
