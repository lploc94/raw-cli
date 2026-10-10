import type { AgentSession } from "./agent.js";
import { normalizeUsage } from "./llm/cache.js";
import { base64ByteLength, type ModelMessage, type ModelRequestOptions, type ProviderAdapter, type ProviderTurn, type UserInput } from "./llm/types.js";
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

export const DEFAULT_COMPACT_OUTPUT_TOKENS = 16384;

/**
 * Summary output cap used when none is configured: 16k, bounded by the model's output capability and a quarter of its
 * context, and kept above a manual Anthropic thinking budget so the default never fails validation.
 */
export function defaultCompactOutputTokens(model: { contextWindow?: number | undefined; maxOutputTokens?: number | undefined;
  request?: Readonly<ModelRequestOptions> | undefined }): number {
  let limit = Math.min(DEFAULT_COMPACT_OUTPUT_TOKENS, model.maxOutputTokens ?? Infinity,
    model.contextWindow !== undefined ? Math.max(1, Math.floor(model.contextWindow / 4)) : Infinity);
  const thinking = model.request?.kind === "anthropic" ? model.request.thinking : undefined;
  // A manual budget is already validated below the ordinary request cap, so that cap is a summary limit the API accepts.
  if (thinking?.type === "enabled" && limit <= thinking.budgetTokens) {
    limit = model.request?.maxOutputTokens ?? model.maxOutputTokens ?? thinking.budgetTokens + 1;
  }
  return limit;
}

export const COMPACT_SYSTEM_PROMPT =
  "Summarize prior conversation for continuation. Include objective, constraints, decisions, completed work, changed files, unresolved failures, and next work. Use only supplied facts.";

/** Conservative token cost of one user image; base64 is never counted as text. */
export const USER_IMAGE_TOKEN_ESTIMATE = 1600;

export function estimateRequestTokens(system: string, messages: readonly ModelMessage[], tools: readonly ToolDefinition[]): number {
  let images = 0;
  const light = messages.map((message): ModelMessage => {
    if (message.role !== "user" || typeof message.content === "string" || !message.content.some((block) => block.type === "image")) return message;
    return { role: "user", content: message.content.map((block) => {
      if (block.type !== "image") return block;
      images++;
      return { type: "image" as const, data: "", mimeType: block.mimeType };
    }) };
  });
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system, messages: light, tools }), "utf8") / 2) + 32 + images * USER_IMAGE_TOKEN_ESTIMATE;
}

function summaryUserInput(input: UserInput): UserInput {
  if (typeof input === "string" || !input.some((block) => block.type === "image")) return input;
  return input.map((block) => block.type === "image"
    ? { type: "text" as const, text: `[Image: ${block.mimeType}, ${base64ByteLength(block.data)} bytes${block.name ? `, ${JSON.stringify(block.name)}` : ""}]` }
    : block);
}

function summaryMessage(message: ModelMessage): ModelMessage {
  if (message.role === "user") return { role: "user", content: structuredClone(summaryUserInput(message.content)) };
  if (message.role !== "tool") return structuredClone(message);
  return { ...structuredClone(message), result: { ...message.result,
    content: message.result.content.map((block) => block.type === "image"
      ? { type: "text" as const, text: `[Image: path=${block.path ?? "unknown"}; mime=${block.mimeType}; bytes=${block.byteSize ?? Buffer.from(block.data, "base64").length}]` }
      : structuredClone(block)) } };
}

function summaryInput(originalTask: UserInput | undefined, previousSummary: string | undefined, turns: readonly ModelMessage[][]): string {
  return JSON.stringify({ originalTask: originalTask === undefined ? undefined : summaryUserInput(originalTask), ...(previousSummary ? { previousSummary } : {}), olderTurns: turns });
}

function summaryFits(provider: ProviderAdapter, input: string, outputTokens: number): boolean {
  const context = provider.modelConfig.contextWindow;
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
  for (let offset = 0, requestIndex = 0; offset < sanitized.length;) {
    let end = offset;
    while (end < sanitized.length && summaryFits(provider,
      summaryInput(snapshot.originalTask, snapshot.previousSummary && offset === 0 ? undefined : summary,
        sanitized.slice(offset, end + 1)), options.maxOutputTokens)) end++;
    if (end === offset) throw new Error("compaction input exceeds context budget for one turn");
    const input = summaryInput(snapshot.originalTask, snapshot.previousSummary && offset === 0 ? undefined : summary, sanitized.slice(offset, end));
    let budget = options.maxOutputTokens;
    let turn: ProviderTurn;
    for (;;) {
      const index = requestIndex++;
      options.onRequestStart?.(index);
      turn = await provider.generate({
        system: COMPACT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: input }],
        tools: [],
        timeoutMs: options.timeoutMs,
        maxOutputTokens: budget,
        signal: options.signal,
        cacheKey: options.cacheKey,
        onUsage: (raw) => { if (!options.signal.aborted) options.onUsage?.(index, raw); },
      });
      if (!options.signal.aborted && turn.usage !== undefined) options.onUsage?.(index, turn.usage);
      if (options.signal.aborted) return { result: { status: "cancelled", beforeBytes, afterBytes: beforeBytes } };
      // A summary cut at the output limit is retried once with twice the budget when the model and context allow it.
      const larger = Math.min(budget * 2, provider.modelConfig.maxOutputTokens ?? Infinity);
      if (!turn.truncated || budget !== options.maxOutputTokens || larger <= budget || !summaryFits(provider, input, larger)) break;
      budget = larger;
    }
    if (turn.toolCalls.length || (!turn.truncated && !["stop", "end_turn", "STOP"].includes(turn.finishReason))) throw new Error("compaction did not return a final text answer");
    if (!turn.text.trim()) throw new Error("compaction returned an empty summary");
    const reportedOutput = normalizeUsage(provider.modelConfig.method, turn.usage, provider.modelConfig.provider).outputTokens;
    if (reportedOutput !== undefined && reportedOutput > budget) throw new Error("compaction exceeded output token budget");
    // Still cut after the retry: a lossy summary that says so beats keeping a transcript too large to continue.
    summary = turn.truncated ? `${turn.text}\n[Summary cut off at the output token limit.]` : turn.text;
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
