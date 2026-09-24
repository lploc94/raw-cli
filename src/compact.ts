import type { AgentSession } from "./agent.js";
import { normalizeUsage } from "./llm/cache.js";
import type { ModelMessage, ProviderAdapter } from "./llm/types.js";

export interface CompactOptions {
  provider?: ProviderAdapter;
  keepRecentTurns?: number;
  maxOutputTokens?: number;
}

export interface CompactResult {
  status: "compacted" | "noop" | "not_smaller" | "cancelled";
  beforeBytes?: number;
  afterBytes?: number;
  usage?: unknown;
}

export interface CompactSnapshot {
  messages: readonly ModelMessage[];
  originalTask?: string;
  previousSummary?: string;
}

export interface CompactWorkResult {
  result: CompactResult;
  replacement?: ModelMessage[];
  summary?: string;
}

export const COMPACT_SYSTEM_PROMPT =
  "Summarize prior conversation for continuation. Include objective, constraints, decisions, completed work, changed files, unresolved failures, and next work. Use only supplied facts.";

function completeTurns(messages: readonly ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push([message]);
    else {
      const current = turns.at(-1);
      if (!current) throw new Error("transcript has content before the first user message");
      current.push(message);
    }
  }
  return turns;
}

function byteLength(messages: readonly ModelMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export async function performCompaction(
  snapshot: CompactSnapshot,
  provider: ProviderAdapter,
  options: Required<Pick<CompactOptions, "keepRecentTurns" | "maxOutputTokens">> & {
    timeoutMs: number; signal: AbortSignal; cacheKey: string;
    onRequestStart?: () => void; onUsage?: (raw: unknown) => void;
  },
): Promise<CompactWorkResult> {
  const beforeBytes = byteLength(snapshot.messages);
  const history = snapshot.previousSummary ? snapshot.messages.slice(2) : snapshot.messages;
  const turns = completeTurns(history);
  const older = turns.slice(0, Math.max(0, turns.length - options.keepRecentTurns));
  if (!older.length) return { result: { status: "noop", beforeBytes, afterBytes: beforeBytes } };
  const retained = turns.slice(turns.length - options.keepRecentTurns).flat();
  const input = JSON.stringify({
    originalTask: snapshot.originalTask,
    ...(snapshot.previousSummary ? { previousSummary: snapshot.previousSummary } : {}),
    olderTurns: older,
  });
  options.onRequestStart?.();
  const turn = await provider.generate({
    system: COMPACT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: input }],
    tools: [],
    timeoutMs: options.timeoutMs,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
    cacheKey: options.cacheKey,
    onUsage: (raw) => { if (!options.signal.aborted) options.onUsage?.(raw); },
  });
  if (!options.signal.aborted && turn.usage !== undefined) options.onUsage?.(turn.usage);
  if (options.signal.aborted) return { result: { status: "cancelled", beforeBytes, afterBytes: beforeBytes } };
  if (turn.toolCalls.length || !["stop", "end_turn", "STOP"].includes(turn.finishReason)) throw new Error("compaction did not return a final text answer");
  if (!turn.text.trim()) throw new Error("compaction returned an empty summary");
  const reportedOutput = normalizeUsage(provider.profile.provider, turn.usage).outputTokens;
  if (reportedOutput !== undefined && reportedOutput > options.maxOutputTokens) throw new Error("compaction exceeded output token budget");
  const replacement: ModelMessage[] = [
    ...(snapshot.originalTask !== undefined ? [{ role: "user" as const, content: snapshot.originalTask }] : []),
    { role: "user", content: `[Conversation summary]\n${turn.text}` },
    ...retained,
  ];
  const afterBytes = byteLength(replacement);
  if (afterBytes >= beforeBytes) return { result: { status: "not_smaller", beforeBytes, afterBytes, ...(turn.usage !== undefined ? { usage: turn.usage } : {}) } };
  return {
    result: { status: "compacted", beforeBytes, afterBytes, ...(turn.usage !== undefined ? { usage: turn.usage } : {}) },
    replacement, summary: turn.text,
  };
}

export function compactSession(session: AgentSession, options: CompactOptions = {}): Promise<CompactResult> {
  return session.compact(options);
}
