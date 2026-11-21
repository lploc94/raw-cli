import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type AgentOptions } from "../src/agent.js";
import { CHECKPOINT_NO_TOOLS_GUARD, COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import { createProvider } from "../src/llm/client.js";
import { setRequestImageLimitsForTests } from "../src/llm/replay.js";
import type { ResolvedModelConfig, UserBlock } from "../src/llm/types.js";
import { imageBlock, makePng } from "./fixtures/images.js";
import { openAiDone, openAiFrame, startMockProvider, type MockResponse } from "./fixtures/mock-provider.js";

// A request may carry at most COUNT images (the provider's request allowance, set small for the test). Below it every image
// is sent and requests only append; crossing it compacts once, and only the last step's images survive the compaction.
const COUNT = 3;
const STEPS = 9;
const answer = (text: string): MockResponse => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const summary = answer("## Goal\nKeep going.");
type Body = { messages: Array<{ role: string; content: unknown }> };
const images = (body: Body) => (JSON.stringify(body.messages).match(/"type":"image_url"/g) ?? []).length;
const isSummary = (body: Body) => {
  const text = JSON.stringify(body.messages);
  return text.includes(JSON.stringify(COMPACT_SYSTEM_PROMPT).slice(1, 60)) || text.includes(JSON.stringify(CHECKPOINT_NO_TOOLS_GUARD).slice(1, 60));
};
const extends_ = (next: Body, previous: Body) =>
  JSON.stringify(next.messages.slice(0, previous.messages.length)) === JSON.stringify(previous.messages);
const turn = (step: number): UserBlock[] => [{ type: "text", text: `step ${step} ${"t".repeat(200)}` }, imageBlock(makePng(), "image/png", `s${step}.png`)];

async function run(responses: MockResponse[], compact: AgentOptions["compact"], steps = STEPS, input = turn) {
  const root = mkdtempSync(join(tmpdir(), "raw-image-allowance-"));
  const fixture = await startMockProvider(responses);
  setRequestImageLimitsForTests("openai-chat-completions", { request: 45 * 1024 * 1024, count: COUNT });
  const model: ResolvedModelConfig = { agentName: "eyes", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url,
    apiKey: "fixture", vision: true, contextWindow: 200000, maxOutputTokens: 1000 };
  const agent = createAgent({ cwd: root, provider: createProvider(model), system: "tiny", autoApprove: true, ...(compact ? { compact } : {}) });
  try {
    for (let step = 0; step < steps; step++) assert.equal((await agent.run(input(step))).status, "completed", `step ${step} completes`);
    return { bodies: fixture.requests.map((request) => request.body as Body), transcript: agent.transcript };
  } finally {
    await agent.close(); await fixture.close();
    setRequestImageLimitsForTests("openai-chat-completions", undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test("crossing the image allowance compacts once per crossing, below the token trigger, and only the last step's images stay", async () => {
  // Steps 3 and 6 each start with a summary request: steps 0-2 fill the allowance, the compaction at 3 leaves one image.
  const responses = Array.from({ length: STEPS }, (_, step) => [...step === 3 || step === 6 ? [summary] : [], answer(`answer ${step}`)]).flat();
  const { bodies, transcript } = await run(responses, { keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1000, triggerTokens: 100000 });
  assert.equal(bodies.length, responses.length, "every scripted response was used");
  for (const [index, body] of bodies.entries()) assert.ok(images(body) <= COUNT, `request ${index} carries ${images(body)} images, at most ${COUNT}`);
  const main = bodies.filter((body) => !isSummary(body));
  assert.equal(main.length, STEPS);
  assert.equal(bodies.filter(isSummary).length, 2, "one compaction per crossing, though tokens stay far below the trigger");
  assert.deepEqual(main.map(images), [1, 2, 3, 1, 2, 3, 1, 2, 3], "images per request: all below the allowance, the last step's after a compaction");
  const breaks = main.flatMap((body, step) => step > 0 && !extends_(body, main[step - 1]!) ? [step] : []);
  assert.deepEqual(breaks, [3, 6], "only the two requests after a compaction fail to extend the one before");
  assert.match(JSON.stringify(transcript), /Image removed at compaction|Raw compaction checkpoint/);
  assert.equal((JSON.stringify(transcript).match(/"type":"image"/g) ?? []).length, 3, "the stored context holds only images added since the last compaction");
});

test("without automatic compaction, images past the allowance are left out per request as before", async () => {
  const { bodies } = await run(Array.from({ length: 5 }, (_, step) => answer(`answer ${step}`)), undefined, 5);
  assert.deepEqual(bodies.map(images), [1, 2, 3, 3, 3], "the newest images are sent");
  assert.match(JSON.stringify(bodies[4]!.messages), /Image omitted from this request/);
});

test("a last step over the allowance on its own sends its newest images and completes without compacting", async () => {
  const crowded = (step: number): UserBlock[] => [{ type: "text", text: `step ${step}` },
    ...Array.from({ length: COUNT + 2 }, (_, index) => imageBlock(makePng(), "image/png", `s${step}-${index}.png`))];
  const { bodies } = await run([answer("one")], { keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 1000, triggerTokens: 100000 }, 1, crowded);
  assert.equal(bodies.length, 1, "no compaction request");
  assert.equal(images(bodies[0]!), COUNT);
  assert.match(JSON.stringify(bodies[0]!.messages), /Image omitted from this request/);
});
