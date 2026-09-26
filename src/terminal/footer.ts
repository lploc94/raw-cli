import type { RunStatus } from "../agent.js";
import type { UsageSummary } from "../llm/cache.js";
import type { TerminalCapabilities, UiOptions } from "./options.js";
import { icon, paint } from "./theme.js";

export interface TurnFooterInput {
  status: RunStatus;
  code?: string;
  elapsedMs: number;
  startedToolCalls: number;
  notRunToolCalls: number;
  stats: UsageSummary;
  contextTokens: number;
  contextWindow?: number;
  inputBudget?: number;
  compactTrigger?: number;
  sessionId: string;
  resumable: boolean;
  repl?: boolean;
  ui: UiOptions;
  caps: TerminalCapabilities;
}

function amount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function state(status: RunStatus): string {
  return status === "completed" ? "Done" : status === "cancelled" ? "Cancelled"
    : status === "max_steps" ? "Stopped: max steps" : "Failed";
}

function covered(label: string, value: number, count: number, total: number): string {
  return `${label.padEnd(12)}${amount(value)} (reported ${count}/${total} requests)`;
}

export function formatResumeCommand(id: string, ui: UiOptions, caps: TerminalCapabilities): string {
  return `${paint("accent", icon("continue", ui, caps), ui, caps)} Continue this session\n  raw --resume ${id} "query"\n`;
}

export function formatTurnFooter(input: TurnFooterInput): string {
  const { status, code, elapsedMs, startedToolCalls, notRunToolCalls, stats,
    contextTokens, contextWindow, inputBudget, compactTrigger, sessionId, resumable, ui, caps } = input;
  const okay = status === "completed";
  const label = state(status);
  const headline = `${paint(okay ? "success" : status === "cancelled" ? "warning" : "error",
    `${icon(okay ? "success" : status === "cancelled" ? "attention" : "failure", ui, caps)} ${label}`, ui, caps)}`
    + `${code && !okay ? ` · ${code}` : ""} · ${duration(elapsedMs)} · ${startedToolCalls} tool${startedToolCalls === 1 ? "" : "s"}`
    + `${notRunToolCalls ? ` · ${notRunToolCalls} not run` : ""}`;
  const warning = (compactTrigger !== undefined && contextTokens >= compactTrigger)
    || (inputBudget !== undefined && contextTokens >= inputBudget);
  let context = contextWindow === undefined
    ? `Context  ~${amount(contextTokens)} tokens (window unknown)`
    : `Context  ${caps.unicode ? "▰".repeat(Math.max(0, Math.min(10, Math.floor(contextTokens / contextWindow * 10))))
      + "▱".repeat(Math.max(0, 10 - Math.min(10, Math.floor(contextTokens / contextWindow * 10))))
      : "#".repeat(Math.max(0, Math.min(10, Math.floor(contextTokens / contextWindow * 10))))
      + "-".repeat(Math.max(0, 10 - Math.min(10, Math.floor(contextTokens / contextWindow * 10))))}`
      + `  ~${amount(contextTokens)} / ${amount(contextWindow)} · ${(contextTokens / contextWindow * 100).toFixed(1)}% used`;
  if (warning) context = paint("warning", context, ui, caps);
  if (input.repl) return `${headline}\n  ${context}\n`;
  const lines = [headline, `  ${context}`];
  const all = stats.requests > 0;
  const shown: string[] = [];
  if (all && stats.inputCoverage === stats.requests) shown.push(`${amount(stats.inputTokensKnown)} input`);
  if (all && stats.outputCoverage === stats.requests) shown.push(`${amount(stats.outputTokensKnown)} output`);
  if (all && stats.cacheReadCoverage === stats.requests) shown.push(`${amount(stats.cacheReadTokensKnown)} cache read`);
  if (shown.length) lines.push(`  Session  ${shown.join(" · ")}`);
  if (ui.density === "verbose" && all) {
    lines.push(`  ${covered("Input", stats.inputTokensKnown, stats.inputCoverage, stats.requests)}`);
    lines.push(`  ${covered("Output", stats.outputTokensKnown, stats.outputCoverage, stats.requests)}`);
    lines.push(`  ${covered("Cache read", stats.cacheReadTokensKnown, stats.cacheReadCoverage, stats.requests)}`);
    lines.push(`  ${covered("Cache write", stats.cacheWriteTokensKnown, stats.cacheWriteCoverage, stats.requests)}`);
    if (stats.cacheReadRatio !== undefined) lines.push(`  Cache ratio ${(stats.cacheReadRatio * 100).toFixed(1)}% (reported ${stats.cacheRatioCoverage}/${stats.requests} requests)`);
  }
  if (resumable) lines.push("", formatResumeCommand(sessionId, ui, caps).trimEnd());
  return lines.join("\n") + "\n";
}

export function formatStats(stats: UsageSummary, _ui: UiOptions, _caps: TerminalCapabilities,
  lastTurn?: { elapsedMs: number; firstTextMs?: number }): string {
  const total = stats.requests;
  const lines = [`Requests    ${total}`,
    covered("Input", stats.inputTokensKnown, stats.inputCoverage, total),
    covered("Output", stats.outputTokensKnown, stats.outputCoverage, total),
    covered("Cache read", stats.cacheReadTokensKnown, stats.cacheReadCoverage, total),
    covered("Cache write", stats.cacheWriteTokensKnown, stats.cacheWriteCoverage, total),
    `Cache ratio ${stats.cacheReadRatio === undefined ? "unavailable" : `${(stats.cacheReadRatio * 100).toFixed(1)}%`} (reported ${stats.cacheRatioCoverage}/${total} requests)`];
  if (lastTurn) lines.push(`Last turn   ${duration(lastTurn.elapsedMs)}${lastTurn.firstTextMs === undefined ? "" : ` · first text ${duration(lastTurn.firstTextMs)}`}`);
  return lines.join("\n") + "\n";
}
