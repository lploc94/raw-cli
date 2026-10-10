import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { estimateRequestTokens, performCompaction, USER_IMAGE_TOKEN_ESTIMATE } from "../src/compact.js";
import { nativeUserContent } from "../src/llm/content.js";
import { createProvider } from "../src/llm/client.js";
import { projectImageLimits, projectVisionMessages, requestImageLimits } from "../src/llm/replay.js";
import { renderUserInput, type ModelMessage, type ProviderAdapter, type ProviderRequest, type ProviderTurn, type UserBlock } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { storedAcpUpdates } from "../src/sessions/display.js";
import { projectHistoryItem } from "../src/sessions/view.js";
import { renderTerminalHistory } from "../src/terminal/history.js";
import { ToolRegistry } from "./fixtures/registry.js";
import { imageBlock, jpegFixture, makePng, makePngOfSize } from "./fixtures/images.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const png = makePng();
const jpeg = jpegFixture();
const mixed = (): UserBlock[] => [{ type: "text", text: "before" }, imageBlock(png, "image/png", "a.png"), { type: "text", text: "between" },
  imageBlock(jpeg, "image/jpeg"), { type: "text", text: "after" }];
const chatFrames = [openAiFrame({ content: "done" }, "stop"), openAiDone];
const scenarios = [
  { method: "openai-chat-completions", provider: "openai", frames: chatFrames },
  { method: "openai-responses", provider: "openai", frames: [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
    response: { id: "r", object: "response", status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "done", annotations: [] }] }], usage: null } })}\n\n`, "data: [DONE]\n\n"] },
  { method: "anthropic-messages", provider: "anthropic", frames: [
    anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "done" } }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame("message_stop", {}),
  ] },
  { method: "google-generate-content", provider: "google", frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] })] },
] as const;
const wireContent = (method: string, body: any): any[] =>
  method === "openai-chat-completions" ? body.messages[1].content : method === "openai-responses" ? body.input[0].content
    : method === "anthropic-messages" ? body.messages[0].content : body.contents[0].parts;

const b64 = { png: png.toString("base64"), jpeg: jpeg.toString("base64") };
const expectedParts: Record<string, unknown[]> = {
  "openai-chat-completions": [{ type: "text", text: "before" }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64.png}` } },
    { type: "text", text: "between" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64.jpeg}` } }, { type: "text", text: "after" }],
  "openai-responses": [{ type: "input_text", text: "before" }, { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${b64.png}` },
    { type: "input_text", text: "between" }, { type: "input_image", detail: "auto", image_url: `data:image/jpeg;base64,${b64.jpeg}` }, { type: "input_text", text: "after" }],
  "anthropic-messages": [{ type: "text", text: "before" }, { type: "image", source: { type: "base64", media_type: "image/png", data: b64.png } },
    { type: "text", text: "between" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64.jpeg } }, { type: "text", text: "after" }],
  "google-generate-content": [{ text: "before" }, { inlineData: { mimeType: "image/png", data: b64.png } },
    { text: "between" }, { inlineData: { mimeType: "image/jpeg", data: b64.jpeg } }, { text: "after" }],
};

test("every adapter sends user images natively, in original block order, with unchanged text-only shape", async () => {
  for (const scenario of scenarios) {
    const fixture = await startMockProvider([{ frames: [...scenario.frames] }, { frames: [...scenario.frames] }, { frames: [...scenario.frames] }]);
    try {
      const adapter = createProvider({ agentName: "f", provider: scenario.provider, method: scenario.method, model: "fixture",
        baseUrl: fixture.url, apiKey: "fixture", vision: true });
      const send = (content: string | UserBlock[]) => adapter.generate({ system: "s", messages: [{ role: "user", content }], tools: [], timeoutMs: 2000 });
      await send(mixed());
      assert.deepEqual(wireContent(scenario.method, fixture.requests[0]?.body), expectedParts[scenario.method], scenario.method);
      // Text-only turns keep the previous wire shape: text blocks flatten into the same body as a plain string.
      await send("ab");
      await send([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
      assert.deepEqual(fixture.requests[2]?.body, fixture.requests[1]?.body, scenario.method);
      const plain = wireContent(scenario.method, fixture.requests[1]?.body);
      if (scenario.method === "google-generate-content") assert.deepEqual(plain, [{ text: "ab" }]);
      else assert.equal(plain, "ab");
    } finally { await fixture.close(); }
  }
});

test("invalid, mistyped, truncated and oversize user images fail before any request", async () => {
  const cases: Array<[string, UserBlock[]]> = [
    ["base64", [{ type: "image", data: "not base64!!", mimeType: "image/png" }]],
    ["type", [{ type: "image", data: png.toString("base64"), mimeType: "image/gif" as never }]],
    ["declared type", [imageBlock(png, "image/jpeg")]],
    ["truncated", [imageBlock(png.subarray(0, 24))]],
    ["not an image", [imageBlock(Buffer.from("GIF89a hello world"))]],
    ["aggregate", [0, 1, 2].map(() => imageBlock(makePngOfSize(6 * 1024 * 1024)))],
  ];
  const fixture = await startMockProvider([{ frames: chatFrames }]);
  try {
    const adapter = createProvider({ agentName: "f", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "fixture", vision: true });
    for (const [name, content] of cases) {
      assert.throws(() => nativeUserContent(content), /image|16 MiB/, name);
      await assert.rejects(adapter.generate({ system: "s", messages: [{ role: "user", content }], tools: [], timeoutMs: 2000 }), /image|16 MiB/, name);
    }
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(nativeUserContent("plain"), [{ type: "text", text: "plain" }]);
  } finally { await fixture.close(); }
});

const stub = (vision: boolean, seen: unknown[] = [], window?: { contextWindow: number; maxOutputTokens: number }): ProviderAdapter => ({
  modelConfig: { agentName: "t", provider: "ollama", method: "openai-chat-completions", model: "fixture", vision, ...window },
  async generate(request): Promise<ProviderTurn> {
    const { signal: _signal, onUsage: _onUsage, onTextDelta: _onTextDelta, onReasoningDelta: _onReasoningDelta, ...wire } = request;
    seen.push(structuredClone(wire));
    return { text: "ok", toolCalls: [], finishReason: "stop" };
  },
});
const lastUser = (request: unknown) => JSON.stringify((request as ProviderRequest | undefined)?.messages.filter((message) => message.role === "user"));

test("non-vision models get text placeholders while stored context keeps the image; vision models get it natively", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-user-images-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "s" }).id;
  try {
    const flat: unknown[] = [];
    const first = createAgent({ cwd: root, provider: stub(false, flat), registry: new ToolRegistry(), system: "s",
      persistence: { store, sessionId: id, surface: "web" } });
    assert.equal((await first.run([{ type: "text", text: "look" }, imageBlock(png, "image/png", "shot.png")])).status, "completed");
    assert.match(lastUser(flat[0]), /Image omitted: image\/png, \d+ bytes, \\"shot.png\\"/);
    assert.match(lastUser(flat[0]), /earlier assistant messages/);
    assert.doesNotMatch(lastUser(flat[0]), new RegExp(png.toString("base64").slice(0, 60)));
    assert.equal(JSON.stringify(first.transcript[0]).includes(png.toString("base64")), true);
    await first.close();
    const vision: unknown[] = [];
    const second = createAgent({ cwd: root, provider: stub(true, vision), registry: new ToolRegistry(), system: "s",
      persistence: { store, sessionId: id, surface: "web" } });
    assert.equal((await second.run("what was in it?")).status, "completed");
    assert.ok(lastUser(vision[0]).includes(png.toString("base64")));
    assert.doesNotMatch(lastUser(vision[0]), /Image omitted/);
    await second.close();
    const back: unknown[] = [];
    const third = createAgent({ cwd: root, provider: stub(false, back), registry: new ToolRegistry(), system: "s",
      persistence: { store, sessionId: id, surface: "web" } });
    assert.equal((await third.run("and now?")).status, "completed");
    assert.match(lastUser(back[0]), /Image omitted/);
    assert.doesNotMatch(lastUser(back[0]), new RegExp(png.toString("base64").slice(0, 60)));
    assert.ok(JSON.stringify(third.transcript).includes(png.toString("base64")));
    await third.close();
  } finally { store.close(); }
});

test("an invalid or oversize image turn never enters the context and sends no request", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-user-images-bad-"));
  const seen: unknown[] = [];
  const agent = createAgent({ cwd: root, provider: stub(true, seen), registry: new ToolRegistry(), system: "s" });
  const big = makePngOfSize(6 * 1024 * 1024);
  const result = await agent.run([{ type: "text", text: "x" }, imageBlock(big), imageBlock(big), imageBlock(big)]);
  assert.equal(result.status, "error");
  assert.equal(result.status === "error" ? result.code : "", "unsupported_content");
  assert.equal(agent.transcript.length, 0);
  assert.equal(seen.length, 0);
  assert.equal((await agent.run("still works")).status, "completed");
  assert.equal(seen.length, 1);
  await agent.close();
});

test("images are budgeted as a fixed estimate, not as base64 text, so auto-compaction does not misfire", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-user-images-budget-"));
  const big = makePngOfSize(5 * 1024 * 1024);
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }, imageBlock(big)] }];
  const estimate = estimateRequestTokens("s", messages, []);
  assert.ok(estimate >= USER_IMAGE_TOKEN_ESTIMATE && estimate < USER_IMAGE_TOKEN_ESTIMATE + 200, String(estimate));
  const textOnly = estimateRequestTokens("s", [{ role: "user", content: "hi" }], []);
  assert.equal(estimateRequestTokens("s", [{ role: "user", content: [{ type: "text", text: "hi" }] }], []) - textOnly < 20, true);
  const seen: unknown[] = [];
  const provider = stub(true, seen, { contextWindow: 20000, maxOutputTokens: 200 });
  const agent = createAgent({ cwd: root, provider, registry: new ToolRegistry(), system: "s",
    compact: { triggerTokens: 8000, keepRecentTurns: 1, maxOutputTokens: 200 } });
  const result = await agent.run([{ type: "text", text: "describe" }, imageBlock(big)]);
  assert.equal(result.status, "completed");
  assert.equal(seen.length, 1);
  assert.ok(agent.estimatedContextTokens() < 4000);
  await agent.close();
  const nonVision = createAgent({ cwd: root, provider: stub(false, []), registry: new ToolRegistry(), system: "s" });
  await nonVision.run([{ type: "text", text: "describe" }, imageBlock(big)]);
  assert.ok(nonVision.estimatedContextTokens() < 1000);
  await nonVision.close();
});

test("projectVisionMessages replaces only user images and never mutates its input", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "text" }, { role: "user", content: mixed() },
    { role: "assistant", text: "a", toolCalls: [] }];
  const before = structuredClone(messages);
  const projected = projectVisionMessages(messages, false);
  assert.deepEqual(messages, before);
  assert.equal(projected[0], messages[0]);
  const blocks = (projected[1] as unknown as { content: UserBlock[] }).content;
  assert.deepEqual(blocks.map((block) => block.type), ["text", "text", "text", "text", "text"]);
  assert.match((blocks[1] as { text: string }).text, /a\.png/);
  assert.deepEqual(projectVisionMessages(messages, true), messages);
});

test("images the API would reject become text notes, newest images keep the request allowance, input is not mutated", () => {
  const image = (characters: number, name: string) => ({ type: "image" as const, mimeType: "image/png" as const, data: "A".repeat(characters), name });
  const messages: ModelMessage[] = [
    { role: "user", content: [image(30, "old.png")] },
    { role: "tool", callId: "c", name: "view_image", result: { isError: false, content: [{ type: "image", mimeType: "image/jpeg", data: "B".repeat(30), path: "/tmp/shot.jpg" }] } },
    { role: "user", content: [{ type: "text", text: "look" }, image(80, "huge.png"), image(40, "new.png")] },
  ];
  const before = structuredClone(messages);
  const projected = projectImageLimits(messages, { perImage: 50, total: 75, count: 3 });
  assert.deepEqual(messages, before);
  const latest = (projected[2] as unknown as { content: UserBlock[] }).content;
  assert.equal(latest[0], (messages[2] as unknown as { content: UserBlock[] }).content[0]);
  assert.match((latest[1] as { text: string }).text, /"huge\.png".*over the provider's 0\.0 MiB per-image limit.*smaller copy/);
  assert.equal(latest[2]!.type, "image");
  // The tool image (30) still fits after the newest (40); the oldest would pass the 75-character allowance.
  assert.equal((projected[1] as unknown as { result: { content: Array<{ type: string }> } }).result.content[0]!.type, "image");
  assert.match(((projected[0] as unknown as { content: UserBlock[] }).content[0] as { text: string }).text, /"old\.png".*per-request allowance/);
  assert.deepEqual(projectImageLimits(messages, { total: 1000, count: 10 }), messages);
  assert.deepEqual(requestImageLimits("anthropic-messages"), { perImage: 5 * 1024 * 1024, total: 24 * 1024 * 1024, count: 100 });
});

test("an Anthropic request carries a note instead of an image over 5 MB, and the stored turn keeps the image", async () => {
  const fixture = await startMockProvider([{ frames: [...scenarios[2].frames] }]);
  const big = makePngOfSize(4 * 1024 * 1024);
  try {
    const agent = createAgent({ provider: createProvider({ agentName: "f", provider: "anthropic", method: "anthropic-messages", model: "fixture",
      baseUrl: fixture.url, apiKey: "fixture", vision: true }), registry: new ToolRegistry(), system: "s" });
    assert.equal((await agent.run([{ type: "text", text: "look" }, imageBlock(big, "image/png", "big.png")])).status, "completed");
    const sent = JSON.stringify(wireContent("anthropic-messages", fixture.requests[0]?.body));
    assert.match(sent, /Image omitted from this request: image\/png, \\"big\.png\\", 5\.\d MiB encoded/);
    assert.ok(!sent.includes(big.toString("base64").slice(0, 200)));
    assert.ok(JSON.stringify(agent.transcript[0]).includes(big.toString("base64").slice(0, 200)));
    await agent.close();
  } finally { await fixture.close(); }
});

test("image blocks never leak base64 into rendered text, history views, terminal, ACP text or compaction summaries", async () => {
  const input = mixed();
  const rendered = renderUserInput(input);
  assert.match(rendered, /\[Image: image\/png, \d+ bytes\]/);
  assert.ok(!rendered.includes(png.toString("base64").slice(0, 60)));
  const item = { sessionId: "s", sequence: 1, kind: "user", payload: { input }, status: "complete" as const, createdAt: 1 };
  assert.ok(!(projectHistoryItem(item).text ?? "").includes(png.toString("base64").slice(0, 60)));
  assert.ok(!renderTerminalHistory(item).includes(png.toString("base64").slice(0, 60)));
  const acp = storedAcpUpdates(item);
  assert.equal(acp.filter((update) => (update as { content?: { type?: string } }).content?.type === "image").length, 2);
  const requests: string[] = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "c", provider: "ollama", method: "openai-chat-completions", model: "f" },
    async generate(request) { requests.push(JSON.stringify(request.messages)); return { text: "summary", toolCalls: [], finishReason: "stop" }; } };
  const history: ModelMessage[] = [{ role: "user", content: input }, { role: "assistant", text: "seen", toolCalls: [] },
    { role: "user", content: "next" }, { role: "assistant", text: "ok", toolCalls: [] }];
  const work = await performCompaction({ messages: history, originalTask: input }, provider,
    { keepRecentTurns: 1, maxOutputTokens: 100, timeoutMs: 1000, signal: new AbortController().signal, cacheKey: "k" });
  assert.equal(requests.length, 1);
  assert.ok(work.result.status === "compacted" || work.result.status === "not_smaller");
  assert.match(requests[0]!, /\[Image: image\/png/);
  assert.ok(!requests[0]!.includes(png.toString("base64").slice(0, 60)));
});
