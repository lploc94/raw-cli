import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import type { ApiMethod, ResolvedModelConfig } from "../src/llm/types.js";
import { applyRequestOverride, parseRequestOverride, requestControls, requestKind, RequestOverrideError } from "../src/request-controls.js";

const model = (provider: string, method: ApiMethod, request?: ResolvedModelConfig["request"]): Readonly<ResolvedModelConfig> =>
  Object.freeze({ agentName: "a", provider, method, model: "m", ...(request ? { request } : {}) });
const values = (controls: ReturnType<typeof requestControls>, id: string) => controls.find((control) => control.id === id)?.options.map((option) => option.value);

test("descriptors per provider: labels, ascending levels, tiers only where the provider has them", () => {
  const openai = requestControls("openai", "openai-chat-completions", { kind: "openai", reasoningEffort: "low", serviceTier: "flex" });
  assert.deepEqual(openai.map((control) => [control.id, control.label, control.kind, control.current]),
    [["effort", "Reasoning", "level", "low"], ["serviceTier", "Service tier", "choice", "flex"]]);
  assert.deepEqual(values(openai, "effort"), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(values(openai, "serviceTier"), ["auto", "default", "flex", "fast", "priority"]);
  assert.ok(openai[1]!.options.every((option) => option.hint && option.label), "tiers explain cost and speed");
  assert.deepEqual(requestControls("openai", "openai-responses").map((control) => control.id), ["effort", "serviceTier"]);
  const anthropic = requestControls("anthropic", "anthropic-messages");
  assert.deepEqual(anthropic.map((control) => [control.id, control.label, control.current]), [["effort", "Effort", undefined], ["serviceTier", "Service tier", undefined]]);
  assert.deepEqual(values(anthropic, "effort"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(values(anthropic, "serviceTier"), ["auto", "standard_only"]);
  const deepseek = requestControls("deepseek", "openai-chat-completions", { kind: "deepseek", reasoningEffort: "max" });
  assert.deepEqual(deepseek.map((control) => [control.id, control.label, control.current]), [["effort", "Reasoning", "max"]]);
  assert.deepEqual(values(deepseek, "effort"), ["low", "high", "max"]);
  const google = requestControls("google", "google-generate-content", { kind: "google", thinkingLevel: "high" });
  assert.deepEqual(google.map((control) => [control.id, control.label, control.current]), [["effort", "Thinking", "high"]]);
  assert.deepEqual(values(google, "effort"), ["minimal", "low", "medium", "high"]);
  for (const [provider, method] of [["ollama", "openai-chat-completions"], ["openrouter", "openai-chat-completions"], ["openai", "anthropic-messages"], ["custom", "openai-responses"]] as const)
    assert.deepEqual(requestControls(provider, method), [], `${provider}/${method} has no controls`);
  assert.equal(requestKind("deepseek", "openai-chat-completions"), "deepseek");
  assert.equal(requestKind("deepseek", "openai-responses"), "generic");
});

test("parseRequestOverride accepts only advertised values and keys", () => {
  const controls = requestControls("openai", "openai-chat-completions");
  assert.deepEqual(parseRequestOverride({}, controls), {});
  assert.deepEqual(parseRequestOverride({ effort: "xhigh", serviceTier: "priority" }, controls), { effort: "xhigh", serviceTier: "priority" });
  assert.deepEqual(parseRequestOverride({ serviceTier: "auto" }, controls), { serviceTier: "auto" });
  for (const bad of [{ effort: "ultra" }, { effort: 3 }, { serviceTier: "standard_only" }, { reasoning_effort: "low" }, { effort: "low", extra: 1 }, "high", null, [], 7])
    assert.throws(() => parseRequestOverride(bad, controls), RequestOverrideError, JSON.stringify(bad));
  const google = requestControls("google", "google-generate-content");
  assert.throws(() => parseRequestOverride({ serviceTier: "auto" }, google), /serviceTier/);
  assert.throws(() => parseRequestOverride({ effort: "max" }, google), /effort/);
  assert.throws(() => parseRequestOverride({ effort: "low" }, []), /no request controls/);
  assert.deepEqual(parseRequestOverride({}, []), {}, "an empty object is a no-op even without controls");
});

test("applyRequestOverride merges per provider, keeps other fields, never mutates and freezes the result", () => {
  const openai = model("openai", "openai-responses", { kind: "openai", maxOutputTokens: 900, reasoningMode: "pro", reasoningEffort: "low", serviceTier: "auto" });
  const openaiOut = applyRequestOverride(openai, { effort: "max", serviceTier: "priority" });
  assert.deepEqual(openaiOut.request, { kind: "openai", maxOutputTokens: 900, reasoningMode: "pro", reasoningEffort: "max", serviceTier: "priority" });
  assert.deepEqual(openai.request, { kind: "openai", maxOutputTokens: 900, reasoningMode: "pro", reasoningEffort: "low", serviceTier: "auto" });
  assert.ok(Object.isFrozen(openaiOut) && Object.isFrozen(openaiOut.request));
  assert.deepEqual(applyRequestOverride(openai, { serviceTier: "flex" }).request, { ...openai.request, serviceTier: "flex" });
  assert.equal(applyRequestOverride(openai, {}), openai, "no override returns the same model");
  const bare = applyRequestOverride(model("openai", "openai-chat-completions"), { effort: "minimal" });
  assert.deepEqual(bare.request, { kind: "openai", reasoningEffort: "minimal" });

  const anthropic = model("anthropic", "anthropic-messages", { kind: "anthropic", thinking: { type: "enabled", budgetTokens: 2048 }, maxOutputTokens: 8000 });
  assert.deepEqual(applyRequestOverride(anthropic, { effort: "high", serviceTier: "standard_only" }).request,
    { kind: "anthropic", thinking: { type: "enabled", budgetTokens: 2048 }, maxOutputTokens: 8000, effort: "high", serviceTier: "standard_only" });

  const deepseek = model("deepseek", "openai-chat-completions", { kind: "deepseek", thinking: "disabled" });
  assert.deepEqual(applyRequestOverride(deepseek, { effort: "high" }).request, { kind: "deepseek", thinking: "enabled", reasoningEffort: "high" });
  assert.deepEqual(deepseek.request, { kind: "deepseek", thinking: "disabled" });

  const google = model("google", "google-generate-content", { kind: "google", thinkingBudget: 512 });
  const googleOut = applyRequestOverride(google, { effort: "medium" });
  assert.deepEqual(googleOut.request, { kind: "google", thinkingLevel: "medium" });
  assert.ok(!("thinkingBudget" in googleOut.request!));

  const generic = model("ollama", "openai-chat-completions");
  assert.equal(applyRequestOverride(generic, { effort: "low" }), generic);
});

test("every advertised value is accepted by config validation and unknown values are refused (no drift)", async () => {
  const cases = [
    ["openai", "openai-chat-completions", "reasoning_effort", "effort"], ["openai", "openai-chat-completions", "service_tier", "serviceTier"],
    ["anthropic", "anthropic-messages", "effort", "effort"], ["anthropic", "anthropic-messages", "service_tier", "serviceTier"],
    ["deepseek", "openai-chat-completions", "reasoning_effort", "effort"], ["google", "google-generate-content", "thinking_level", "effort"],
  ] as const;
  for (const [provider, method, key, id] of cases) {
    const advertised = values(requestControls(provider, method), id)!;
    const load = async (value: string) => {
      const home = mkdtempSync(join(tmpdir(), "raw-request-controls-"));
      mkdirSync(join(home, ".config", "raw"), { recursive: true });
      writeFileSync(join(home, ".config", "raw", "config.json"), JSON.stringify({ default_agent: "a",
        models: { m: { provider, method, model_id: "x", api_key: "k", context_window_tokens: 65536, ...(provider === "deepseek" ? { base_url: "https://api.deepseek.com" } : {}) } },
        agents: { a: { model: "m", tools: { use: [] }, request: { [key]: value } } } }));
      try { return await loadConfig({ home, env: {}, requireModel: false }); } finally { rmSync(home, { recursive: true, force: true }); }
    };
    for (const value of advertised) await assert.doesNotReject(load(value), `${provider} ${key}=${value}`);
    await assert.rejects(load("bogus-level"), /unsupported/, `${provider} ${key}`);
  }
});
