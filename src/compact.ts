import type { AgentSession } from "./agent.js";
import { normalizeUsage } from "./llm/cache.js";
import type { ModelMessage, ProviderAdapter, UserInput } from "./llm/types.js";
import type { ToolDefinition } from "./tools/registry.js";

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
  originalTask?: UserInput;
  previousSummary?: string;
}

export interface CompactWorkResult {
  result: CompactResult;
  replacement?: ModelMessage[];
  summary?: string;
}

export const COMPACT_SYSTEM_PROMPT =
  "Summarize prior conversation for continuation. Include objective, constraints, decisions, completed work, changed files, unresolved failures, and next work. Use only supplied facts.";

export function estimateRequestTokens(system: string, messages: readonly ModelMessage[], tools: readonly ToolDefinition[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system, messages, tools }), "utf8") / 2) + 32;
}

function summaryMessage(message: ModelMessage): ModelMessage {
  if (message.role !== "tool") return structuredClone(message);
  return { ...structuredClone(message), result: { ...message.result,
    content: message.result.content.map((block) => block.type === "image"
      ? { type: "text" as const, text: `[Image: path=${block.path ?? "unknown"}; mime=${block.mimeType}; bytes=${block.byteSize ?? Buffer.from(block.data, "base64").length}]` }
      : structuredClone(block)) } };
}

function summaryInput(originalTask: UserInput | undefined, previousSummary: string | undefined, turns: readonly ModelMessage[][]): string {
  return JSON.stringify({ originalTask, ...(previousSummary ? { previousSummary } : {}), olderTurns: turns });
}

function summaryFits(provider: ProviderAdapter, input: string, outputTokens: number): boolean {
  const context = provider.profile.contextWindow;
  if (context === undefined) return true;
  const margin = Math.max(64, Math.ceil(context * 0.05));
  const serialized = Buffer.byteLength(JSON.stringify({ system: COMPACT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: input }], tools: [] }), "utf8");
  return serialized + outputTokens + margin <= context;
}

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
    onRequestStart?: (index: number) => void; onUsage?: (index: number, raw: unknown) => void;
  },
): Promise<CompactWorkResult> {
  const beforeBytes = byteLength(snapshot.messages);
  const history = snapshot.previousSummary ? snapshot.messages.slice(1) : snapshot.messages;
  const turns = completeTurns(history);
  if (snapshot.previousSummary && turns[0]?.length === 1 && turns.length <= options.keepRecentTurns + 1) {
    return { result: { status: "noop", beforeBytes, afterBytes: beforeBytes } };
  }
  const older = turns.slice(0, Math.max(0, turns.length - options.keepRecentTurns));
  if (!older.length) return { result: { status: "noop", beforeBytes, afterBytes: beforeBytes } };
  const retained = turns.slice(turns.length - options.keepRecentTurns).flat();
  const sanitized = older.map((turn) => turn.map(summaryMessage));
  let summary = snapshot.previousSummary;
  let usage: unknown;
  for (let offset = 0, requestIndex = 0; offset < sanitized.length; requestIndex++) {
    let end = offset;
    while (end < sanitized.length && summaryFits(provider,
      summaryInput(snapshot.originalTask, snapshot.previousSummary && offset === 0 ? undefined : summary,
        sanitized.slice(offset, end + 1)), options.maxOutputTokens)) end++;
    if (end === offset) throw new Error("compaction input exceeds context budget for one turn");
    const input = summaryInput(snapshot.originalTask, snapshot.previousSummary && offset === 0 ? undefined : summary, sanitized.slice(offset, end));
    options.onRequestStart?.(requestIndex);
    const turn = await provider.generate({
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      tools: [],
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
      signal: options.signal,
      cacheKey: options.cacheKey,
      onUsage: (raw) => { if (!options.signal.aborted) options.onUsage?.(requestIndex, raw); },
    });
    if (!options.signal.aborted && turn.usage !== undefined) options.onUsage?.(requestIndex, turn.usage);
    if (options.signal.aborted) return { result: { status: "cancelled", beforeBytes, afterBytes: beforeBytes } };
    if (turn.toolCalls.length || !["stop", "end_turn", "STOP"].includes(turn.finishReason)) throw new Error("compaction did not return a final text answer");
    if (!turn.text.trim()) throw new Error("compaction returned an empty summary");
    const reportedOutput = normalizeUsage(provider.profile.method, turn.usage, provider.profile.provider).outputTokens;
    if (reportedOutput !== undefined && reportedOutput > options.maxOutputTokens) throw new Error("compaction exceeded output token budget");
    summary = turn.text;
    usage = turn.usage;
    offset = end;
  }
  const replacement: ModelMessage[] = [
    ...(snapshot.originalTask !== undefined ? [{ role: "user" as const, content: snapshot.originalTask }] : []),
    { role: "user", content: `[Conversation summary]\n${summary}` },
    ...retained,
  ];
  const afterBytes = byteLength(replacement);
  if (afterBytes >= beforeBytes) return { result: { status: "not_smaller", beforeBytes, afterBytes, ...(usage !== undefined ? { usage } : {}) } };
  return {
    result: { status: "compacted", beforeBytes, afterBytes, ...(usage !== undefined ? { usage } : {}) },
    replacement, summary: summary!,
  };
}

export function compactSession(session: AgentSession, options: CompactOptions = {}): Promise<CompactResult> {
  return session.compact(options);
}
