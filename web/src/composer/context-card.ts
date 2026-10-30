import { compactTokens, contextTone } from "../panels/summaries.js";
import { compactTriggerMark, contextUsage, type ContextUsageInput } from "./context-usage.js";

/** The composer's context ring and its Context card (docs/chat-design.md §8). */
export interface ContextCard {
  /** The ring button's accessible name. */
  label: string;
  /** Rounded share of the limit; absent before the first measurement or without a known limit. */
  percent?: number;
  /** The ring, the chip and the bar: the accent, amber from 80 %, red from 95 %. */
  tone: "accent" | "warning" | "error";
  /** `~5.9k`, without `~` when the provider reported it; absent before the first measurement. */
  tokens?: string;
  /** `/ 8.2k tokens`, `/ 4k tokens until auto compact`, or `tokens` without a limit. */
  of?: string;
  /** `30 messages kept · auto compact at 7.4k`, then `· last measured` for an old measurement. */
  line: string;
}

export function contextCard(
  context: ContextUsageInput | undefined | null,
  { stale, messages }: { stale: boolean; messages?: number | undefined },
): ContextCard {
  if (!context) return { label: "Context: not measured yet", tone: "accent", line: "" };
  const usage = contextUsage(context);
  const tokens = `${context.source === "provider" ? "" : "~"}${compactTokens(context.estimatedTokens)}`;
  const line = [
    messages === undefined ? undefined : `${messages} ${messages === 1 ? "message" : "messages"} kept`,
    context.compactTrigger ? `auto compact at ${compactTriggerMark(context)}${compactTokens(context.compactTrigger)}` : "auto compact off",
    stale ? "last measured" : undefined,
  ].filter(Boolean).join(" · ");
  if (!usage) return { label: `Context: ${tokens} tokens, no limit known`, tone: "accent", tokens, of: "tokens", line };
  const percent = Math.round(usage.percent);
  const fill = contextTone(usage.percent);
  const tone = fill === "error" || fill === "warning" ? fill : "accent";
  return {
    label: `Context: ${percent}% used`,
    percent,
    tone,
    tokens,
    of: `/ ${usage.basis === "compact" ? compactTriggerMark(context) : ""}${compactTokens(usage.limit)} tokens${usage.basis === "compact" ? " until auto compact" : ""}`,
    line,
  };
}
