import type { ApiMethod, ResolvedModelConfig } from "./types.js";

/**
 * Whether the adapter's provider documents that sending `tool_choice: "none"` keeps the prompt cache, so a compaction
 * request may set it (design §6.6; sources in docs/providers.md). OpenAI recommends it over removing tools; Anthropic
 * documents that a `tool_choice` change invalidates cached message blocks; Google documents nothing either way.
 */
export function toolChoiceKeepsCache(model: Pick<ResolvedModelConfig, "provider" | "method">): boolean {
  return model.provider === "openai" && (model.method === "openai-chat-completions" || model.method === "openai-responses");
}

export interface NormalizedUsage {
  inputTokensTotal?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheReadRatio?: number;
}

export interface UsageRecord { method: ApiMethod; provider: string; raw: unknown }

export interface UsageSummary {
  requests: number;
  inputTokensKnown: number;
  inputCoverage: number;
  outputTokensKnown: number;
  outputCoverage: number;
  cacheReadTokensKnown: number;
  cacheWriteTokensKnown: number;
  cacheReadCoverage: number;
  cacheWriteCoverage: number;
  cacheRatioCoverage: number;
  cacheReadRatio?: number;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeUsage(method: ApiMethod, raw: unknown, provider?: string): NormalizedUsage {
  const data = object(raw);
  let inputTokensTotal: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  if (method === "anthropic-messages") {
    const ordinary = count(data.input_tokens);
    cacheReadTokens = count(data.cache_read_input_tokens);
    cacheWriteTokens = count(data.cache_creation_input_tokens);
    if (ordinary !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined) {
      inputTokensTotal = ordinary + cacheReadTokens + cacheWriteTokens;
    }
    outputTokens = count(data.output_tokens);
  } else if (method === "google-generate-content") {
    inputTokensTotal = count(data.promptTokenCount);
    const candidates = count(data.candidatesTokenCount);
    const thoughts = count(data.thoughtsTokenCount);
    outputTokens = candidates !== undefined ? candidates + (thoughts ?? 0) : undefined;
    cacheReadTokens = count(data.cachedContentTokenCount);
  } else if (method === "openai-responses") {
    inputTokensTotal = count(data.input_tokens);
    outputTokens = count(data.output_tokens);
    const details = object(data.input_tokens_details);
    cacheReadTokens = count(details.cached_tokens);
    cacheWriteTokens = count(details.cache_write_tokens);
  } else {
    inputTokensTotal = count(data.prompt_tokens);
    outputTokens = count(data.completion_tokens);
    const details = object(data.prompt_tokens_details);
    cacheReadTokens = count(details.cached_tokens) ?? (provider === "deepseek" ? count(data.prompt_cache_hit_tokens) : undefined);
    cacheWriteTokens = count(details.cache_write_tokens);
  }
  return {
    ...(inputTokensTotal !== undefined ? { inputTokensTotal } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(inputTokensTotal !== undefined && inputTokensTotal > 0 && cacheReadTokens !== undefined && cacheReadTokens <= inputTokensTotal
      ? { cacheReadRatio: cacheReadTokens / inputTokensTotal } : {}),
  };
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  let inputTokensKnown = 0;
  let inputCoverage = 0;
  let outputTokensKnown = 0;
  let outputCoverage = 0;
  let cacheReadTokensKnown = 0;
  let cacheWriteTokensKnown = 0;
  let cacheReadCoverage = 0;
  let cacheWriteCoverage = 0;
  let cacheRatioCoverage = 0;
  let ratioInputs = 0;
  let ratioReads = 0;
  for (const record of records) {
    const usage = normalizeUsage(record.method, record.raw, record.provider);
    if (usage.inputTokensTotal !== undefined) { inputTokensKnown += usage.inputTokensTotal; inputCoverage++; }
    if (usage.outputTokens !== undefined) { outputTokensKnown += usage.outputTokens; outputCoverage++; }
    if (usage.cacheReadTokens !== undefined) { cacheReadTokensKnown += usage.cacheReadTokens; cacheReadCoverage++; }
    if (usage.cacheWriteTokens !== undefined) { cacheWriteTokensKnown += usage.cacheWriteTokens; cacheWriteCoverage++; }
    if (usage.inputTokensTotal !== undefined && usage.cacheReadTokens !== undefined && usage.cacheReadTokens <= usage.inputTokensTotal) {
      cacheRatioCoverage++;
      ratioInputs += usage.inputTokensTotal;
      ratioReads += usage.cacheReadTokens;
    }
  }
  return {
    requests: records.length, inputTokensKnown, inputCoverage, outputTokensKnown, outputCoverage,
    cacheReadTokensKnown, cacheWriteTokensKnown, cacheReadCoverage, cacheWriteCoverage, cacheRatioCoverage,
    ...(ratioInputs > 0 ? { cacheReadRatio: ratioReads / ratioInputs } : {}),
  };
}

export interface CacheSettings {
  openai?: { prompt_cache_key?: string; prompt_cache_retention?: "in_memory" | "24h"; prompt_cache_options?: { ttl: "30m" } };
  anthropic?: { cache_control: { type: "ephemeral"; ttl?: "5m" | "1h" } };
  llamaPrompt?: true;
}

const openAiExtendedRetentionModels = new Set([
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.2", "gpt-5.1-codex-max",
  "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-chat-latest",
  "gpt-5", "gpt-5-codex", "gpt-4.1",
]);

export function cacheSettings(modelConfig: Readonly<ResolvedModelConfig>, requestKey?: string, fallbackKey?: string): CacheSettings {
  const options = modelConfig.cache;
  const mode = options?.mode ?? "auto";
  if (mode !== "auto" && mode !== "no-hints") throw new Error(`unsupported cache mode: ${mode}`);
  if (options?.backend === "llama.cpp" && modelConfig.method !== "openai-chat-completions") throw new Error("llama.cpp backend requires openai-chat-completions method");
  if (modelConfig.provider === "openai") {
    const retention = options?.retention;
    if (retention !== undefined && !["in_memory", "24h", "30m"].includes(retention)) throw new Error(`unsupported OpenAI cache retention: ${retention}`);
    const retentionModel = modelConfig.model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    if (retention === "24h" && !openAiExtendedRetentionModels.has(retentionModel)) {
      throw new Error(`24h cache retention is unsupported for ${modelConfig.model}`);
    }
    if (retention === "in_memory" && /^gpt-(?:5\.5|5\.6|[6-9])/.test(modelConfig.model)) throw new Error(`in_memory cache retention is unsupported for ${modelConfig.model}`);
    if (retention === "30m" && !/^gpt-(?:5\.[6-9]|[6-9])/.test(modelConfig.model)) throw new Error(`30m cache retention is unsupported for ${modelConfig.model}`);
    if (mode === "no-hints") return {};
    const key = options?.key ?? requestKey ?? fallbackKey;
    if (key !== undefined && !key.trim()) throw new Error("cache key must be nonempty");
    return { openai: {
      ...(key !== undefined ? { prompt_cache_key: key } : {}),
      ...(retention === "30m" ? { prompt_cache_options: { ttl: "30m" } }
        : retention === "in_memory" || retention === "24h" ? { prompt_cache_retention: retention } : {}),
    } };
  }
  if (options?.key !== undefined) throw new Error(`cache key is unsupported for ${modelConfig.provider}`);
  if (modelConfig.provider === "anthropic") {
    if (options?.retention !== undefined && options.retention !== "5m" && options.retention !== "1h") throw new Error(`unsupported Anthropic cache retention: ${options.retention}`);
    if (mode === "no-hints") return {};
    return { anthropic: { cache_control: { type: "ephemeral", ...(options?.retention ? { ttl: options.retention } : {}) } } };
  }
  if (options?.retention !== undefined) throw new Error(`cache retention is unsupported for ${modelConfig.provider}`);
  if (options?.backend === "llama.cpp" && mode === "auto") return { llamaPrompt: true };
  return {};
}
