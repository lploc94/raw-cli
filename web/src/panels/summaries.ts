/** What a tab badge and an Overview card say about a panel (docs/side-panel-design.md §3). Pure, so it is unit-tested. */
import type { ChecklistItem, FileEntry, PanelBlock, PanelDocument, StepItem } from "../../../src/panels/contract.js";
import { derivedProgress, derivedSummary } from "../../../src/panels/render.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";
import type { UsageSummary } from "../../../src/llm/cache.js";
import type { Approval } from "../../../src/dashboard/approvals.js";
import type { CommandRecord } from "../../../src/processes/presentation.js";
import { contextUsage, type ContextUsageInput } from "../composer/context-usage.js";
import { commandFailed, commandRunning } from "./commands-state.js";
import { formatDuration } from "./panel-state.js";

export type Tone = "accent" | "success" | "warning" | "error" | "muted";
export interface SummaryLine { text: string; glyph?: "running" | "pending" | "failed" | "done"; meta?: string }
export interface PanelSummary {
  /** The tab badge: short text, and what it means in words for its tooltip and accessible description. */
  badge?: { text: string; tone: Tone; label: string };
  /** A done or failed document: the tab shows this glyph instead of a badge. */
  status?: "done" | "failed";
  /** Muted text at the right of the Overview card, such as `2 of 5`. */
  meta?: string;
  chips: Array<{ text: string; tone: Tone; spin?: boolean }>;
  /** Added and removed line totals, each only when some file reported it. */
  stats?: { added?: number; removed?: number };
  /** Up to two key lines for the Overview card. */
  lines: SummaryLine[];
  /** 0..1 */
  progress?: { value: number; tone: Tone };
  /** The muted line under the tab header's title. */
  summary?: string;
}

const blocksOf = <K extends string, T>(doc: PanelDocument, kind: K) => doc.blocks.filter((block) => block.kind === kind) as unknown as Array<PanelBlock & T>;
const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** The first item, in tree order, whose own status matches. */
function find(items: readonly ChecklistItem[], match: (item: ChecklistItem) => boolean): ChecklistItem | undefined {
  for (const item of items) {
    if (match(item)) return item;
    const inner = item.children && find(item.children, match);
    if (inner) return inner;
  }
  return undefined;
}
const unfinished = (item: ChecklistItem) => !item.children?.length && item.status !== "done" && item.status !== "skipped";

export function summarizePanel(item: PanelStackItem): PanelSummary {
  const chips: PanelSummary["chips"] = [];
  if (item.closed) chips.push({ text: "Closed", tone: "muted" });
  if (item.stale) chips.push({ text: "Stale", tone: "muted" });
  const doc = item.document;
  if (!doc) return { chips, lines: [{ text: "No data yet" }], summary: "No data yet" };
  const status = doc.status === "done" || doc.status === "failed" ? doc.status : undefined;
  const text = derivedSummary(doc);
  const out: PanelSummary = { chips, lines: [], ...(text ? { summary: text } : {}), ...(status ? { status } : {}) };
  const progress = derivedProgress(doc);
  if (progress && progress.total > 0) {
    out.meta = `${progress.done} of ${progress.total}`;
    if (!status) out.badge = { text: `${progress.done}/${progress.total}`, tone: "muted", label: `${progress.done} of ${progress.total} done` };
    out.progress = { value: Math.min(1, progress.done / progress.total), tone: status === "failed" ? "error" : status === "done" ? "success" : "accent" };
  }
  const checklists = blocksOf<"checklist", { items: ChecklistItem[] }>(doc, "checklist");
  const steps = blocksOf<"steps", { items: StepItem[] }>(doc, "steps");
  const files = blocksOf<"files", { entries: FileEntry[] }>(doc, "files").flatMap((block) => block.entries);
  if (checklists.length) {
    const items = checklists.flatMap((block) => block.items);
    const active = find(items, (entry) => entry.status === "in_progress");
    const next = active ?? find(items, unfinished);
    if (next) out.lines.push({ text: next.label, glyph: active ? "running" : next.status === "failed" ? "failed" : "pending" });
  } else if (steps.length) {
    const items = steps.flatMap((block) => block.items);
    const active = items.find((entry) => entry.status === "in_progress") ?? items.find((entry) => entry.status !== "done" && entry.status !== "skipped");
    if (active) out.lines.push({ text: active.label, glyph: active.status === "in_progress" ? "running" : active.status === "failed" ? "failed" : "pending" });
  } else if (files.length) {
    if (!status) out.badge = { text: String(files.length), tone: "muted", label: `${files.length} ${files.length === 1 ? "file" : "files"}` };
    const known = (key: "added" | "removed") => files.some((entry) => typeof entry[key] === "number") ? files.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) : undefined;
    const added = known("added");
    const removed = known("removed");
    if (added !== undefined || removed !== undefined) out.stats = { ...(added === undefined ? {} : { added }), ...(removed === undefined ? {} : { removed }) };
    out.lines.push({ text: files.map((entry) => baseName(entry.path)).join(", ") });
  }
  if (!out.lines.length && out.summary) out.lines.push({ text: out.summary });
  return out;
}

/** A command that ended badly: a nonzero exit, a failure, a timeout or a lost process. A stopped job is not a failure. */
const newest = (a: CommandRecord, b: CommandRecord) => b.createdAt - a.createdAt;
const failure = (item: CommandRecord) => (item.state === "timed_out" ? "timed out" : item.exitCode ? `exit ${item.exitCode}` : item.signal ?? "failed");

export function summarizeCommands(items: readonly CommandRecord[], now: number): PanelSummary {
  const running = items.filter(commandRunning).sort(newest);
  const failed = items.filter(commandFailed).sort(newest);
  const title = (item: CommandRecord) => item.label ?? item.command;
  const chips: PanelSummary["chips"] = [];
  if (running.length) chips.push({ text: `${running.length} running`, tone: "accent", spin: true });
  if (failed.length) chips.push({ text: `${failed.length} failed`, tone: "error" });
  const badge: PanelSummary["badge"] = running.length ? { text: String(running.length), tone: "accent", label: `${running.length} running` }
    : failed.length ? { text: String(failed.length), tone: "error", label: `${failed.length} failed` }
    : items.length ? { text: String(items.length), tone: "muted", label: `${items.length} ${items.length === 1 ? "command" : "commands"}` } : undefined;
  const lines: SummaryLine[] = [
    ...running.map((item): SummaryLine => ({ text: title(item), glyph: "running", meta: formatDuration(now - item.createdAt) })),
    ...failed.map((item): SummaryLine => ({ text: title(item), glyph: "failed", meta: failure(item) })),
  ].slice(0, 2);
  const last = [...items].sort(newest)[0];
  // Nothing running or failed: the newest command, with a check only when it succeeded; a stopped job says so.
  if (!lines.length && last) lines.push(last.state === "stopped" ? { text: title(last), meta: "stopped" }
    : { text: title(last), glyph: "done", ...(last.endedAt === undefined ? {} : { meta: formatDuration(last.endedAt - last.createdAt) }) });
  if (!lines.length) lines.push({ text: "No commands yet" });
  const summary = items.length ? `${running.length} running · ${failed.length} failed · ${items.length} total` : undefined;
  return { ...(badge ? { badge } : {}), chips, lines, ...(summary ? { summary } : {}) };
}

/** The Approvals tab's badge and Overview card (docs/side-panel-design.md §3.3): how many wait, newest first. */
export function summarizeApprovals(items: readonly Approval[], now: number): PanelSummary {
  const waiting = [...items].sort((a, b) => b.createdAt - a.createdAt);
  const badge: PanelSummary["badge"] = waiting.length ? { text: String(waiting.length), tone: "warning", label: `${waiting.length} waiting for approval` } : undefined;
  const chips: PanelSummary["chips"] = waiting.length ? [{ text: `${waiting.length} waiting`, tone: "warning" }] : [];
  // The time left, never negative: an approval whose deadline passed reads `0s`, not a minus sign.
  const lines: SummaryLine[] = waiting.slice(0, 2).map((item) => ({ text: item.title || item.name, meta: formatDuration(Math.max(0, item.deadline - now)) }));
  if (!lines.length) lines.push({ text: "Nothing waits for approval" });
  return { ...(badge ? { badge } : {}), chips, lines, ...(waiting.length ? { summary: `${waiting.length} waiting for approval` } : {}) };
}

/** `950`, `6.9k`, `128k`, `1.3M`. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
/** Context fill tone: warning from 80 %, error from 95 %. */
export const contextTone = (percent: number): Tone => (percent >= 95 ? "error" : percent >= 80 ? "warning" : "muted");

/** The Details tab badge and the Overview Context card; undefined until the session has been measured. */
export function summarizeContext(context: ContextUsageInput | undefined | null): PanelSummary | undefined {
  if (!context) return undefined;
  const usage = contextUsage(context);
  const tokens = `${context.source === "provider" ? "" : "~"}${compactTokens(context.estimatedTokens)}`;
  if (!usage) return { chips: [], lines: [{ text: `${tokens} tokens` }], summary: `${tokens} tokens` };
  const percent = Math.round(usage.percent);
  const tone = contextTone(usage.percent);
  const text = `${tokens} / ${compactTokens(usage.limit)} tokens`;
  return {
    badge: { text: `${percent}%`, tone, label: `${percent}% of the ${usage.basis === "compact" ? "auto-compact trigger" : "context window"} used` },
    chips: [{ text: `${percent}%`, tone }],
    // The card shows the chip and the bar (frame-overview.png); the numbers stay in the summary and in Details.
    lines: [],
    progress: { value: Math.min(1, usage.percent / 100), tone: tone === "muted" ? "accent" : tone },
    summary: text,
  };
}

/** Some request in this usage reported a token count: input, output or cache. */
export const reportsTokens = (usage: UsageSummary) => !!(usage.inputCoverage || usage.outputCoverage || usage.cacheReadCoverage || usage.cacheWriteCoverage);
