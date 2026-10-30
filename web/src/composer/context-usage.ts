/** The part of the session's context metrics the usage indicator needs. */
export interface ContextUsageInput { estimatedTokens: number; source?: "provider" | "estimate" | undefined; contextWindow?: number | undefined; compactTrigger?: number | undefined;
  /** The trigger is Raw's estimate of where the CLI compacts (Claude Code), shown with `≈`. */
  compactTriggerEstimated?: boolean | undefined }

/** `≈` before an estimated trigger. */
export const compactTriggerMark = (context: ContextUsageInput): string => context.compactTriggerEstimated ? "≈" : "";

export interface ContextUsage {
  /** What the tokens are measured against: the auto-compact trigger when the agent sets one, else the model's context window. */
  limit: number;
  basis: "compact" | "window";
  /** Share of `limit` in use, unrounded; may exceed 100 once the trigger has been passed. */
  percent: number;
}

/** Usage against the level that matters to the user: where compaction starts, not the model's largest window. */
export function contextUsage(context: ContextUsageInput | undefined | null): ContextUsage | undefined {
  if (!context) return undefined;
  const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;
  const basis = positive(context.compactTrigger) ? "compact" : positive(context.contextWindow) ? "window" : undefined;
  if (!basis) return undefined;
  const limit = basis === "compact" ? context.compactTrigger! : context.contextWindow!;
  return { limit, basis, percent: context.estimatedTokens / limit * 100 };
}
