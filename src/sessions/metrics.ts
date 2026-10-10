import type { AgentSession } from "../agent.js";
import type { CompactSettings } from "../config.js";
import type { UsageSummary } from "../llm/cache.js";
import { effectiveInputBudget } from "../llm/context.js";
import { effectiveOutputTokens } from "../llm/output.js";
import type { ResolvedModelConfig } from "../llm/types.js";

export interface SessionMetrics {
  capabilities?: { tools: readonly string[]; skills: readonly string[]; vars: readonly string[] };
  historyWatermark?: number;
  measuredAt: number;
  elapsedMs: number;
  model: string;
  agentName: string;
  startedTools: number;
  failedTools: number;
  session: UsageSummary;
  turn: UsageSummary;
  context: {
    estimatedTokens: number;
    /** `provider` when the size is the provider's own count of the last response, `estimate` when it is derived from the bytes. */
    source?: "provider" | "estimate";
    contextWindow?: number;
    percentage?: number;
    inputBudget?: number;
    outputReserve: number;
    compactTrigger?: number;
  };
}

export function measureSession(agent: AgentSession, model: Readonly<ResolvedModelConfig>, options: {
  startedAt: number; firstRequest: number; startedTools: number; failedTools: number;
  compact?: Readonly<CompactSettings>;
}): SessionMetrics {
  const { tokens: estimatedTokens, source } = agent.contextUsage();
  const outputReserve = effectiveOutputTokens(model);
  return { measuredAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - options.startedAt)),
    model: model.model, agentName: model.agentName, startedTools: options.startedTools, failedTools: options.failedTools,
    session: agent.stats(), turn: agent.stats(options.firstRequest), context: { estimatedTokens, source, outputReserve,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow,
        percentage: estimatedTokens / model.contextWindow * 100, inputBudget: effectiveInputBudget(model.contextWindow, outputReserve) }),
      ...(options.compact?.triggerTokens === undefined ? {} : { compactTrigger: options.compact.triggerTokens }) } };
}
