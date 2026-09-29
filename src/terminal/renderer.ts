import { fstatSync } from "node:fs";
import type { AgentSession, RunEvent, RunResult } from "../agent.js";
import type { RuntimeConfig } from "../config.js";
import { toolArguments } from "../sessions/display.js";
import { projectToolCall, projectToolResult, renderPlainToolResult } from "../sessions/visible.js";
import { MarkdownStream } from "./markdown.js";
import { terminalCapabilities } from "./options.js";
import { icon, paint } from "./theme.js";
import { formatToolResult, formatToolStart } from "./tools.js";
import { TerminalWriter } from "./writer.js";
import { safeTerminalText } from "./safe.js";
import { receiptLine } from "../panels/render.js";

export function sharedInteractiveTerminal(): boolean {
  if (!process.stdout.isTTY || !process.stderr.isTTY || process.env.TERM === "dumb") return false;
  try {
    const out = fstatSync(process.stdout.fd);
    const err = fstatSync(process.stderr.fd);
    return out.isCharacterDevice() && err.isCharacterDevice() && out.dev === err.dev && out.ino === err.ino && out.rdev === err.rdev;
  } catch { return false; }
}

export class TerminalRenderer {
  readonly rich: boolean;
  readonly decoratedPlain: boolean;
  private readonly caps;
  private readonly stderrCaps;
  private readonly width: number;
  private readonly answerWriter: TerminalWriter;
  private readonly statusWriter: TerminalWriter;
  private markdown: MarkdownStream | undefined;
  private pendingTail = "";
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRefresh = 0;
  private wrote = false;
  private endedWithNewline = false;
  private thinkingOpen = false;
  private thinkingEndedWithNewline = false;
  private answerOpen = false;
  private readonly pendingCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  private readonly startedIds = new Set<string>();
  private notRun = 0;
  private startedAt = 0;
  private firstTextAt: number | undefined;

  get startedToolCalls(): number { return this.startedIds.size; }
  get notRunToolCalls(): number { return this.notRun; }
  get elapsedMs(): number { return Math.max(0, performance.now() - this.startedAt); }
  get firstTextMs(): number | undefined { return this.firstTextAt === undefined ? undefined : Math.max(0, this.firstTextAt - this.startedAt); }

  constructor(private readonly session: AgentSession, private readonly runtime: RuntimeConfig,
    private readonly cwd: string, private readonly showHeader: boolean, private readonly resumed = false) {
    this.caps = terminalCapabilities(Boolean(process.stdout.isTTY), process.env, runtime.ui);
    this.stderrCaps = terminalCapabilities(Boolean(process.stderr.isTTY), process.env, runtime.ui);
    const shared = sharedInteractiveTerminal();
    this.rich = shared && this.caps.ansi && this.stderrCaps.ansi;
    this.decoratedPlain = shared && !this.rich;
    this.width = Math.max(20, process.stdout.columns || 80);
    this.answerWriter = new TerminalWriter(process.stdout, this.rich, undefined, this.width);
    this.statusWriter = new TerminalWriter(process.stderr, this.rich, undefined, this.width);
  }

  start(): void {
    this.startedAt = performance.now();
    if ((this.rich || this.decoratedPlain) && this.showHeader) {
      const agent = this.runtime.modelConfig?.agentName ?? this.runtime.agentName ?? "raw";
      const model = this.runtime.modelConfig?.model ?? "unknown";
      process.stderr.write(`${paint("accent", `${icon("brand", this.runtime.ui, this.caps)} raw`, this.runtime.ui, this.caps)} · agent ${agent} · model ${model}`
        + `${this.resumed ? " · Resumed" : ""}\n`
        + (this.runtime.ui.density === "compact" ? "\n" : `${paint("muted", this.cwd, this.runtime.ui, this.caps)}\n\n`));
    }
  }

  private finishTextLine(): void {
    if (this.wrote && !this.endedWithNewline) { process.stdout.write("\n"); this.endedWithNewline = true; }
  }

  private finishThinking(): void {
    if (this.thinkingOpen && !this.thinkingEndedWithNewline) process.stderr.write("\n");
    this.thinkingOpen = false;
  }

  private drawTail(force = false): void {
    if (!this.rich) return;
    const elapsed = performance.now() - this.lastRefresh;
    if (!force && elapsed < 100 && this.lastRefresh > 0) {
      if (this.refreshTimer === undefined) this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        this.drawTail(true);
      }, 100 - elapsed);
      return;
    }
    this.answerWriter.replaceTail(this.pendingTail);
    this.lastRefresh = performance.now();
  }

  private clearRefresh(): void {
    if (this.refreshTimer !== undefined) { clearTimeout(this.refreshTimer); this.refreshTimer = undefined; }
  }

  private addAnswer(text: string): void {
    if (!text) return;
    this.statusWriter.finish();
    if (!this.answerOpen) {
      this.answerWriter.write(`${paint("accent", icon("assistant", this.runtime.ui, this.caps), this.runtime.ui, this.caps)} `);
      this.markdown = new MarkdownStream(this.runtime.ui, this.caps, Math.max(8, this.width - 2));
      this.answerOpen = true;
    }
    const frame = this.markdown!.push(text);
    if (frame.committed) {
      this.clearRefresh();
      this.answerWriter.write(frame.committed);
      this.lastRefresh = 0;
    }
    this.pendingTail = frame.tail;
    this.endedWithNewline = text.endsWith("\n");
    this.drawTail();
    this.wrote = true;
  }

  private flushAnswer(): void {
    if (!this.answerOpen) return;
    this.clearRefresh();
    this.answerWriter.clearTail();
    const text = this.markdown?.flush() ?? "";
    if (text) this.answerWriter.write(text);
    this.pendingTail = "";
    this.markdown = undefined;
    this.answerOpen = false;
    if ((text && !text.endsWith("\n")) || (!text && !this.endedWithNewline)) process.stdout.write("\n");
    this.endedWithNewline = true;
  }

  beforeInput(): void {
    if (this.rich) { this.flushAnswer(); this.statusWriter.finish(); }
    else { this.finishThinking(); this.finishTextLine(); }
  }

  approvalPrompt(name: string, args: Record<string, unknown>, identity?: string): string {
    this.beforeInput();
    if (!this.rich && !this.decoratedPlain) return `raw: allow ${name} ${toolArguments(name, args, true, identity)}? [y/N] `;
    const call = projectToolCall(name, identity, args, false);
    return `${paint("warning", `${icon("attention", this.runtime.ui, this.caps)} Allow ${name}?`, this.runtime.ui, this.caps)}\n`
      + `  ${JSON.stringify(call.arguments)}\n  [y/N] `;
  }

  event = (event: RunEvent): void => {
    if (event.type === "text_delta" && event.text && this.firstTextAt === undefined) this.firstTextAt = performance.now();
    if (event.type === "tool_start") this.startedIds.add(event.id);
    if (event.type === "tool_result" && !this.startedIds.has(event.id)) this.notRun++;
    if (!this.rich) { this.plainEvent(event); return; }
    if (event.type === "text_delta") { this.addAnswer(event.text); return; }
    if (event.type === "reasoning_delta" && event.text && this.runtime.ui.reasoning !== "hidden") {
      this.flushAnswer();
      if (!this.thinkingOpen) process.stderr.write(`${paint("thinking", `${icon("thinking", this.runtime.ui, this.caps)} Thinking…`, this.runtime.ui, this.caps)}\n`);
      if (this.runtime.ui.reasoning === "full") process.stderr.write(paint("thinking", event.text, this.runtime.ui, this.caps));
      this.thinkingOpen = true;
      this.thinkingEndedWithNewline = this.runtime.ui.reasoning !== "full" || event.text.endsWith("\n");
      return;
    }
    if (event.type === "tool_call") { this.pendingCalls.set(event.id, { name: event.name, arguments: event.arguments }); return; }
    if (event.type === "tool_start") {
      this.pendingCalls.delete(event.id);
      this.flushAnswer(); this.finishThinking();
      const display = event.display ?? projectToolCall(event.name, this.session.toolIdentity(event.name), event.arguments, true);
      process.stderr.write(formatToolStart(display, this.runtime.ui, this.caps, this.width));
      this.statusWriter.activity(`Running ${event.name}`);
      return;
    }
    if (event.type === "tool_result") {
      this.flushAnswer(); this.finishThinking(); this.statusWriter.finish();
      const pending = this.pendingCalls.get(event.id);
      if (pending) {
        this.pendingCalls.delete(event.id);
        process.stderr.write(formatToolStart(projectToolCall(pending.name, this.session.toolIdentity(pending.name), pending.arguments, false),
          this.runtime.ui, this.caps, this.width));
      }
      process.stderr.write(formatToolResult(event.display ?? projectToolResult(event.name, this.session.toolIdentity(event.name), event.result),
        this.runtime.ui, this.caps, this.width));
      this.panelReceipts(event);
      return;
    }
    if (event.type === "hook_event") {
      this.flushAnswer(); this.finishThinking();
      process.stderr.write(`${paint(event.outcome === "error" ? "warning" : "muted", safeTerminalText(`Hook ${event.id} · ${event.event} · ${event.outcome}${event.message ? ` · ${event.message}` : event.code ? ` · ${event.code}` : ""}`), this.runtime.ui, this.caps)}\n`);
      return;
    }
    if (event.type === "compact_start") {
      this.flushAnswer();
      this.statusWriter.activity(`Compacting context (~${event.estimatedTokens} tokens)`);
    } else if (event.type === "compact_end") {
      this.statusWriter.finish();
      process.stderr.write(`${icon(event.result.status === "compacted" ? "success" : "attention", this.runtime.ui, this.caps)} Compact ${event.result.status}\n`);
    }
  };

  /** §13.2: one receipt line per committed panel update, on stderr so a one-shot run's stdout stays the answer. */
  private panelReceipts(event: Extract<RunEvent, { type: "tool_result" }>): void {
    for (const receipt of event.panelReceipts ?? []) {
      process.stderr.write(`${paint(receipt.error ? "warning" : "muted", safeTerminalText(receiptLine(receipt)), this.runtime.ui, this.caps)}\n`);
    }
  }

  private plainEvent(event: RunEvent): void {
    if (event.type === "hook_event") {
      this.finishTextLine(); this.finishThinking();
      process.stderr.write(`${safeTerminalText(`raw: hook ${event.id} ${event.event} ${event.outcome}${event.message ? ` · ${event.message}` : event.code ? ` · ${event.code}` : ""}`)}\n`);
      return;
    }
    if (event.type === "text_delta") {
      this.finishThinking();
      process.stdout.write(event.text);
      this.wrote ||= event.text.length > 0;
      if (event.text.length) this.endedWithNewline = event.text.endsWith("\n");
    } else if (event.type === "reasoning_delta" && event.text && this.runtime.ui.reasoning !== "hidden") {
      this.finishTextLine();
      if (!this.thinkingOpen) process.stderr.write(this.decoratedPlain
        ? `${icon("thinking", this.runtime.ui, this.caps)} Thinking…\n` : "raw: thinking\n");
      if (this.runtime.ui.reasoning === "full") process.stderr.write(event.text);
      this.thinkingOpen = true;
      this.thinkingEndedWithNewline = this.runtime.ui.reasoning !== "full" || event.text.endsWith("\n");
    } else if (event.type === "tool_call") {
      this.pendingCalls.set(event.id, { name: event.name, arguments: event.arguments });
    } else if (event.type === "tool_start") {
      this.pendingCalls.delete(event.id);
      this.finishTextLine(); this.finishThinking();
      if (this.decoratedPlain) {
        process.stderr.write(formatToolStart(event.display ?? projectToolCall(event.name, this.session.toolIdentity(event.name), event.arguments, true),
          this.runtime.ui, this.caps, this.width));
        return;
      }
      const args = JSON.stringify(event.display?.arguments ?? projectToolCall(event.name, this.session.toolIdentity(event.name), event.arguments, true).arguments);
      process.stderr.write(`raw: ${event.name} ${args}\n`);
    } else if (event.type === "tool_result") {
      this.finishTextLine(); this.finishThinking();
      const pending = this.pendingCalls.get(event.id);
      if (this.decoratedPlain) {
        if (pending) {
          this.pendingCalls.delete(event.id);
          process.stderr.write(formatToolStart(projectToolCall(pending.name, this.session.toolIdentity(pending.name), pending.arguments, false),
            this.runtime.ui, this.caps, this.width));
        }
        process.stderr.write(formatToolResult(event.display ?? projectToolResult(event.name, this.session.toolIdentity(event.name), event.result),
          this.runtime.ui, this.caps, this.width));
        this.panelReceipts(event);
        return;
      }
      if (pending) {
        this.pendingCalls.delete(event.id);
        const args = JSON.stringify(projectToolCall(pending.name, this.session.toolIdentity(pending.name), pending.arguments, false).arguments);
        process.stderr.write(`raw: ⚠ ${pending.name} ${args}\n`);
      }
      const result = event.result;
      const display = event.display ?? projectToolResult(event.name, this.session.toolIdentity(event.name), result);
      const meta = [
        ...(typeof result.exitCode === "number" ? [`exit ${result.exitCode}`] : []),
        ...(result.code ? [result.code] : []),
        ...(result.truncated ? ["model output capped"] : []),
      ];
      const preview = renderPlainToolResult(display);
      process.stderr.write(`raw: ${display.failed ? "✗" : "↳"} ${event.name} result${meta.length ? ` (${meta.join(", ")})` : ""}${preview ? "" : " (empty)"}\n`);
      if (preview) process.stderr.write(`${preview}\n`);
      this.panelReceipts(event);
    } else if (event.type === "compact_start") {
      this.finishTextLine();
      process.stderr.write(this.decoratedPlain ? `${icon("thinking", this.runtime.ui, this.caps)} Compacting context (~${event.estimatedTokens} tokens)\n`
        : `raw: compacting context (${event.estimatedTokens} estimated input tokens)\n`);
    } else if (event.type === "compact_end") {
      this.finishTextLine();
      process.stderr.write(this.decoratedPlain ? `${icon(event.result.status === "compacted" ? "success" : "attention", this.runtime.ui, this.caps)} Compact ${event.result.status}\n`
        : `raw: compact ${event.result.status}\n`);
    }
  }

  finish(result: RunResult): void {
    this.statusWriter.finish();
    if (this.rich) {
      if (!this.wrote && result.text) this.addAnswer(result.text);
      this.flushAnswer();
    } else {
      this.finishThinking();
      if (!this.wrote && result.text) {
        process.stdout.write(result.text);
        this.endedWithNewline = result.text.endsWith("\n");
        this.wrote = true;
      }
      if (this.wrote && !this.endedWithNewline) process.stdout.write("\n");
    }
    this.clearRefresh();
  }
}
