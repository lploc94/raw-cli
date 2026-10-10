import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/llm/client.js";
import { anthropicFrame, googleFrame, openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { BUILTIN_TOOL_DEFINITIONS } from "../src/tools/registry.js";

function config(provider: string, method: string, request: Record<string, unknown>, url: string, limits: Record<string, unknown> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "raw-request-")), "config.json");
  writeFileSync(path, JSON.stringify({ default_agent: "run", models: { model: {
    provider, method, model_id: "fixture", base_url: url, api_key: "fixture-key", ...limits,
  } }, agents: { run: { model: "model", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] }, request } } }));
  return path;
}
const ordinary = { system: "tiny", messages: [{ role: "user" as const, content: "hello" }], tools: BUILTIN_TOOL_DEFINITIONS, timeoutMs: 1000 };
const anthFrames = [
  anthropicFrame("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
  anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
  anthropicFrame("content_block_stop", { index: 0 }),
  anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
  anthropicFrame("message_stop", {}),
];

test("OpenAI Chat, DeepSeek Chat, Anthropic Messages and Gemini controls reach their own wire fields", async () => {
  const cases = [
    { provider: "openai", method: "openai-responses", request: { service_tier: "fast", reasoning_effort: "high", reasoning_mode: "standard", max_output_tokens: 200 },
      frames: [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
        response: { id: "r", object: "response", status: "completed", model: "fixture", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, "data: [DONE]\n\n"],
      inspect: (body: Record<string, unknown>) => {
        assert.equal(body.service_tier, "fast"); assert.deepEqual(body.reasoning, { effort: "high", mode: "standard" });
        assert.equal(body.max_output_tokens, 200); assert.equal(body.store, false);
      } },
    { provider: "openai", method: "openai-chat-completions", request: { service_tier: "fast", reasoning_effort: "high", max_output_tokens: 200 },
      frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone], inspect: (body: Record<string, unknown>) => {
        assert.equal(body.service_tier, "fast"); assert.equal(body.reasoning_effort, "high"); assert.equal(body.max_completion_tokens, 200);
      } },
    { provider: "deepseek", method: "openai-chat-completions", request: { thinking: "enabled", reasoning_effort: "max", max_output_tokens: 200 },
      frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone], inspect: (body: Record<string, unknown>) => {
        assert.deepEqual(body.thinking, { type: "enabled" }); assert.equal(body.reasoning_effort, "max"); assert.equal(body.max_tokens, 200);
      } },
    { provider: "anthropic", method: "anthropic-messages", request: { thinking: { type: "adaptive" }, effort: "high", service_tier: "standard_only", max_output_tokens: 200 },
      frames: anthFrames, inspect: (body: Record<string, unknown>) => {
        assert.deepEqual(body.thinking, { type: "adaptive" }); assert.deepEqual(body.output_config, { effort: "high" });
        assert.equal(body.service_tier, "standard_only"); assert.equal(body.max_tokens, 200);
      } },
    { provider: "google", method: "google-generate-content", request: { thinking_level: "low", max_output_tokens: 200 },
      frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })], inspect: (body: Record<string, unknown>) => {
        const cfg = body.generationConfig as Record<string, unknown>;
        assert.equal(cfg.maxOutputTokens, 200); assert.deepEqual(cfg.thinkingConfig, { thinkingLevel: "LOW" });
      } },
  ];
  for (const scenario of cases) {
    const fixture = await startMockProvider([{ frames: scenario.frames }]);
    try {
      const path = config(scenario.provider, scenario.method, scenario.request, fixture.url, { max_output_tokens: 500, context_window_tokens: 2000 });
      const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
      await createProvider(runtime.modelConfig!).generate(ordinary);
      scenario.inspect(fixture.requests[0]?.body as Record<string, unknown>);
    } finally { await fixture.close(); }
  }
});

test("custom service with Anthropic method reaches Messages and has no guessed Anthropic cache hint", async () => {
  const fixture = await startMockProvider([{ frames: anthFrames }]);
  try {
    const path = config("my-anthropic-gateway", "anthropic-messages", { max_output_tokens: 120 }, fixture.url);
    const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
    const turn = await createProvider(runtime.modelConfig!).generate(ordinary);
    assert.equal(turn.text, "ok");
    assert.match(fixture.requests[0]?.url ?? "", /\/v1\/messages/);
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).cache_control, undefined);
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).max_tokens, 120);
  } finally { await fixture.close(); }
});

test("generic Responses and Gemini gateways honor the common agent output cap", async () => {
  const cases = [
    { method: "openai-responses", frames: [`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1,
      response: { id: "r", object: "response", status: "completed", model: "fixture", output: [], usage: null } })}\n\n`, "data: [DONE]\n\n"],
      read: (body: Record<string, unknown>) => body.max_output_tokens },
    { method: "google-generate-content", frames: [googleFrame({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })],
      read: (body: Record<string, unknown>) => (body.generationConfig as Record<string, unknown>).maxOutputTokens },
  ];
  for (const scenario of cases) {
    const fixture = await startMockProvider([{ frames: scenario.frames }]);
    try {
      const path = config("my-gateway", scenario.method, { max_output_tokens: 120 }, fixture.url, { max_output_tokens: 4096 });
      const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
      await createProvider(runtime.modelConfig!).generate(ordinary);
      assert.equal(scenario.read(fixture.requests[0]?.body as Record<string, unknown>), 120);
    } finally { await fixture.close(); }
  }
});

test("request field combinations and output budgets reject before network", async () => {
  const cases = [
    ["my-gateway", "openai-chat-completions", { service_tier: "fast" }, /service_tier/],
    ["openai", "openai-chat-completions", { reasoning_mode: "pro" }, /reasoning_mode/],
    ["deepseek", "openai-chat-completions", { reasoning_effort: "xhigh" }, /reasoning_effort/],
    ["deepseek", "openai-chat-completions", { thinking: "disabled", reasoning_effort: "high" }, /requires thinking enabled/],
    ["google", "google-generate-content", { thinking_level: "low", thinking_budget: 100 }, /thinking_level or thinking_budget/],
    ["anthropic", "anthropic-messages", { thinking: { type: "enabled" } }, /budget_tokens/],
    ["anthropic", "anthropic-messages", { thinking: { type: "enabled", budget_tokens: 1023 }, max_output_tokens: 400 }, /at least 1024/],
    ["anthropic", "anthropic-messages", { thinking: { type: "enabled", budget_tokens: 200 }, max_output_tokens: 200 }, /budget_tokens/],
    ["openai", "openai-responses", { max_output_tokens: 600 }, /model capability/],
    ["openai", "openai-responses", { tools: [] }, /tools/],
  ] as const;
  for (const [provider, method, request, error] of cases) {
    const path = config(provider, method, request, "http://127.0.0.1:1", { max_output_tokens: 500, context_window_tokens: 2000 });
    await assert.rejects(loadConfig({ configPath: path, env: {}, requireModel: true }), error);
  }
  const reserveCase = config("openai", "openai-responses", { max_output_tokens: 1950 }, "http://127.0.0.1:1",
    { max_output_tokens: 1999, context_window_tokens: 2000 });
  await assert.rejects(loadConfig({ configPath: reserveCase, env: {}, requireModel: true }), /context budget after reserve/);
});

test("Anthropic manual thinking requires a valid compact cap and rejects smaller call overrides before network", async () => {
  const fixture = await startMockProvider([{ frames: anthFrames }]);
  try {
    const path = config("anthropic", "anthropic-messages", { thinking: { type: "enabled", budget_tokens: 1024 }, max_output_tokens: 2048 },
      fixture.url, { max_output_tokens: 4096 });
    assert.equal((await loadConfig({ configPath: path, env: {}, requireModel: true })).compact.maxOutputTokens, 4096);
    const fs = await import("node:fs/promises");
    const doc = JSON.parse(await fs.readFile(path, "utf8"));
    doc.agents.run.compact = { max_output_tokens: 1024 };
    await fs.writeFile(path, JSON.stringify(doc));
    await assert.rejects(loadConfig({ configPath: path, env: {}, requireModel: true }), /compact.max_output_tokens/);
    doc.agents.run.compact = { max_output_tokens: 2048 };
    await fs.writeFile(path, JSON.stringify(doc));
    const runtime = await loadConfig({ configPath: path, env: {}, requireModel: true });
    await assert.rejects(createProvider(runtime.modelConfig!).generate({ ...ordinary, maxOutputTokens: 512 }), /thinking budget/);
    assert.equal(fixture.requests.length, 0);
    await createProvider(runtime.modelConfig!).generate(ordinary);
    assert.equal((fixture.requests[0]?.body as Record<string, unknown>).max_tokens, 2048);
  } finally { await fixture.close(); }
});
