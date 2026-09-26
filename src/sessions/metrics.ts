import type { AgentSession } from "../agent.js";
import type { CompactSettings } from "../config.js";
import type { UsageSummary } from "../llm/cache.js";
import { effectiveInputBudget } from "../llm/context.js";
import type { ResolvedModelConfig } from "../llm/types.js";

export interface SessionMetrics {
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
  const estimatedTokens = agent.estimatedContextTokens();
  const outputReserve = model.request?.maxOutputTokens ?? model.maxOutputTokens ?? 1024;
  return { measuredAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - options.startedAt)),
    model: model.model, agentName: model.agentName, startedTools: options.startedTools, failedTools: options.failedTools,
    session: agent.stats(), turn: agent.stats(options.firstRequest), context: { estimatedTokens, outputReserve,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow,
        percentage: estimatedTokens / model.contextWindow * 100, inputBudget: effectiveInputBudget(model.contextWindow, outputReserve) }),
      ...(options.compact?.triggerTokens === undefined ? {} : { compactTrigger: options.compact.triggerTokens }) } };
}
