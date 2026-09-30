/** The part of the session's context metrics the usage indicator needs. */
export interface ContextUsageInput { estimatedTokens: number; source?: "provider" | "estimate" | undefined; contextWindow?: number | undefined; compactTrigger?: number | undefined }

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

/** The footer text: `~N / limit · P%` plus what the limit is, or a note when no limit is known. */
export function contextUsageText(context: ContextUsageInput | undefined | null, stale: boolean): string {
  if (!context) return "Context usage unavailable";
  const usage = contextUsage(context);
  const tokens = `${context.source === "provider" ? "" : "~"}${context.estimatedTokens.toLocaleString()}`;
  const suffix = stale ? " · last measured" : "";
  if (!usage) return `${tokens} tokens · window unavailable${suffix}`;
  return `${tokens} / ${usage.limit.toLocaleString()} · ${usage.percent.toFixed(1)}%${usage.basis === "compact" ? " · until auto compact" : ""}${suffix}`;
}
