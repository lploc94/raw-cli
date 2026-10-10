import { closeSync, openSync, statSync } from "node:fs";
import { resultText, savedOutputPaths } from "./compact.js";
import type { ModelMessage } from "./llm/types.js";
import { utf8Prefix } from "./tools/results.js";
import { spillFits, spillText } from "./tools/spill.js";
import type { ToolResult } from "./tools/types.js";

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;

/** Tier-0 clearing (docs/compaction-v2-design.md §6.8): results at or under this size stay. */
export const CLEAR_MIN_RESULT_BYTES = 2048;
/** Clearing continues until the next request is at most this share of the input budget. */
export const CLEAR_TARGET_RATIO = 0.45;
/** A clearing that frees less than this changes nothing, so the cached prefix changes rarely. */
export const CLEAR_MIN_FREED_TOKENS = 20000;
/** Default `compact.clear_tokens`, as a share of the input budget. */
export const CLEAR_DEFAULT_RATIO = 0.6;
const STUB_PREFIX = "[Old tool result cleared: ";
const SHORT_ARGS_BYTES = 120;

export interface ClearedResult { callId: string; tool: string; bytes: number; path: string }

export interface ClearOptions {
  /** Index of the first message of the protected tail; only results before it are cleared. */
  protectedFrom: number;
  /** The calibrated estimate of the next request now. */
  currentTokens: number;
  /** Stop once the estimate is at or below this. */
  targetTokens: number;
  /** Commit only when at least this much is freed; 0 for the forced clearing of the fallback chain. */
  minFreedTokens: number;
  /** Calibrated tokens the message at `index` adds to a request, on the same basis as `currentTokens`. */
  messageTokens: (message: ModelMessage, index: number) => number;
  /** Results that are never cleared: ledger answers, load_skill results, results named by a panel reminder. */
  exempt?: (message: ToolMessage) => boolean;
  /**
   * The whole next request built from `messages`, on the basis of `currentTokens`. What a request admits depends on all of
   * it (shrinking text can admit an image it left out), so when given, the cleared context is measured whole.
   */
  measure?: (messages: readonly ModelMessage[]) => number;
}

/** Whether `path` is a readable regular file of exactly `bytes` bytes. */
function readableCopy(path: string, bytes: number): boolean {
  try {
    if (!statSync(path).isFile() || statSync(path).size !== bytes) return false;
    closeSync(openSync(path, "r"));
    return true;
  } catch { return false; }
}

/**
 * Where a complete, readable copy of `result` is: its saved full output when that file is readable, is not capped and has
 * the size of the observed output; otherwise a new saved copy of the text the context holds. None when no complete copy fits.
 */
export function secureCopy(result: ToolResult): string | undefined {
  const full = result.fullOutputPath;
  if (full && !result.fullOutputCapped && result.observedBytes !== undefined) {
    if (readableCopy(full, result.observedBytes)) return full;
  }
  const text = resultText(result);
  const bytes = Buffer.byteLength(text);
  if (!spillFits(bytes)) return undefined;
  const saved = spillText("cleared", text);
  if (!saved.path || saved.capped) return undefined;
  return readableCopy(saved.path, bytes) ? saved.path : undefined;
}

/** Whether a panel reminder names the result: its call ID, its saved full output, or a saved output of one of its rows. */
export function namedByReminder(message: ToolMessage, reminders: readonly string[]): boolean {
  const names = [message.callId, ...savedOutputPaths(message.result)];
  return reminders.some((text) => names.some((name) => text.includes(name)));
}

export function isClearedStub(message: ModelMessage): boolean {
  return message.role === "tool" && message.result.content.length === 1 && message.result.content[0]!.type === "text"
    && message.result.content[0]!.text.startsWith(STUB_PREFIX);
}

/**
 * Replaces old, large tool results with stubs naming a secured copy, oldest first, until the estimate reaches the target
 * (design §6.8). Assistant messages, including their reasoning, are never changed. Undefined when nothing would be cleared
 * or less than the minimum would be freed.
 */
export function clearToolResults(messages: readonly ModelMessage[], options: ClearOptions):
  { messages: ModelMessage[]; cleared: ClearedResult[]; freedTokens: number } | undefined {
  if (options.currentTokens <= options.targetTokens) return undefined;
  const calls = new Map<string, { name: string; arguments: unknown }>();
  for (const message of messages) if (message.role === "assistant") for (const call of message.toolCalls) calls.set(call.id, call);
  const stub = (message: ToolMessage, path: string): ToolMessage => {
    const args = calls.get(message.callId)?.arguments;
    const prefix = args === undefined ? undefined : utf8Prefix(JSON.stringify(args), SHORT_ARGS_BYTES);
    const short = prefix ? ` ${prefix.text}${prefix.truncated ? "…" : ""}` : "";
    const text = `${STUB_PREFIX}${message.name}${short}, ${Buffer.byteLength(resultText(message.result))} bytes; full output: ${path} `
      + "(saved copy, normally kept 7 days; may be removed earlier when saved outputs exceed their disk limit)]";
    return { role: "tool", callId: message.callId, name: message.name,
      result: { isError: message.result.isError, ...(message.result.code ? { code: message.result.code } : {}), content: [{ type: "text", text }] } };
  };
  const candidates = messages.flatMap((message, index) => index < options.protectedFrom && message.role === "tool"
    && !isClearedStub(message) && !message.result.content.some((block) => block.type === "image")
    && Buffer.byteLength(resultText(message.result)) > CLEAR_MIN_RESULT_BYTES && !options.exempt?.(message) ? [index] : []);
  // What clearing every candidate could free, with a placeholder path; below the minimum, no copy is written.
  const saving = (index: number, path: string) =>
    options.messageTokens(messages[index]!, index) - options.messageTokens(stub(messages[index] as ToolMessage, path), index);
  const placeholder = "x".repeat(96);
  const needed = options.currentTokens - options.targetTokens;
  let possible = 0;
  for (const index of candidates) { if (possible >= needed) break; possible += saving(index, placeholder); }
  if (possible < options.minFreedTokens) return undefined;

  const next = [...messages];
  const cleared: ClearedResult[] = [];
  let at = 0;
  /** Clears the oldest remaining candidate that gets a secured copy; the tokens it frees, or undefined when none is left. */
  const clearNext = (): number | undefined => {
    while (at < candidates.length) {
      const index = candidates[at++]!;
      const message = messages[index] as ToolMessage;
      const path = secureCopy(message.result);
      if (path === undefined) continue;
      next[index] = stub(message, path);
      cleared.push({ callId: message.callId, tool: message.name, bytes: Buffer.byteLength(resultText(message.result)), path });
      return saving(index, path);
    }
    return undefined;
  };
  let freed = 0;
  while (options.currentTokens - freed > options.targetTokens) {
    const more = clearNext();
    if (more === undefined) break;
    freed += more;
  }
  if (options.measure && cleared.length) {
    let now = options.measure(next);
    while (now > options.targetTokens && clearNext() !== undefined) now = options.measure(next);
    freed = options.currentTokens - now;
  }
  if (!cleared.length || freed < options.minFreedTokens) return undefined;
  return { messages: next, cleared, freedTokens: freed };
}
