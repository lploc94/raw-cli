import { highlightCode, languageForPath } from "./highlight.js";
import { wrapStyled } from "./layout.js";
import { icon, paint, type IconRole } from "./theme.js";
import type { TerminalCapabilities, UiOptions } from "./options.js";
import type { VisibleToolCall, VisibleToolResult } from "../sessions/visible.js";
import { safeTerminalText } from "./safe.js";

function typeIcon(identity: string | undefined): IconRole {
  if (identity === "builtin/read_file") return "read";
  if (identity === "builtin/write_file") return "write";
  if (identity === "builtin/bash") return "bash";
  if (identity === "builtin/list_skills" || identity === "builtin/load_skill") return "skill";
  if (identity?.startsWith("mcp/")) return "mcp";
  return "generic";
}

function shortArguments(call: VisibleToolCall): string {
  const args = call.arguments;
  if (call.identity === "builtin/bash" && Array.isArray(args.commands)) {
    return args.commands.map((item) => item && typeof item === "object" && "command" in item
      ? String(item.command) : JSON.stringify(item)).join(" ; ");
  }
  if (call.identity === "builtin/read_file" && Array.isArray(args.files)) {
    return args.files.map((item) => item && typeof item === "object" && "path" in item
      ? String(item.path) : JSON.stringify(item)).join(" · ");
  }
  if (call.identity === "builtin/write_file" && Array.isArray(args.operations)) {
    return args.operations.map((item) => item && typeof item === "object" && "path" in item
      ? `${String(item.path)}${"mode" in item ? ` (${String(item.mode)})` : ""}` : JSON.stringify(item)).join(" · ");
  }
  if (call.identity === "builtin/load_skill" && typeof args.name === "string") return args.name;
  return JSON.stringify(args);
}

export function formatToolStart(call: VisibleToolCall, ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  const label = paint("accent", `${icon(typeIcon(call.identity), ui, caps)} ${call.name}`, ui, caps);
  const detail = safeTerminalText(shortArguments(call));
  const prefix = call.started ? label : `${paint("warning", icon("attention", ui, caps), ui, caps)} ${label}`;
  const lines = wrapStyled(`${prefix}${detail ? `  ${paint("path", detail, ui, caps)}` : ""}`, width);
  return lines.join("\n") + "\n";
}

export function formatToolResult(result: VisibleToolResult, ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  const state = result.failed ? "failure" : "success";
  const meta = [
    ...(typeof result.exitCode === "number" ? [`exit ${result.exitCode}`] : []),
    ...(result.code ? [result.code] : []),
    ...(result.truncated ? ["model output capped"] : []),
    ...(typeof result.durationMs === "number" ? [`${result.durationMs}ms`] : []),
  ];
  const header = paint(result.failed ? "error" : "success", `${icon(state, ui, caps)} ${result.name}`, ui, caps)
    + (meta.length ? `  ${paint("muted", meta.join(" · "), ui, caps)}` : "");
  const rows = result.rows.length ? `  ${result.rows.map((row) => `${row.index}:${safeTerminalText(row.status)}${row.exitCode === undefined ? "" : `(exit${row.exitCode})`}`).join("  ")}` : "";
  const limit = result.failed || ui.density === "verbose" ? 9 : ui.density === "normal" ? 4 : 0;
  const body = result.segments.slice(0, limit).map((segment) => {
    const safe = safeTerminalText(segment.text);
    const content = segment.kind === "code" ? highlightCode(safe, segment.language ?? (segment.path ? languageForPath(segment.path) : undefined), ui, caps)
      : segment.kind === "json" ? paint("muted", safe, ui, caps) : safe;
    return wrapStyled(`  ${content}`, width).join("\n");
  });
  if (result.segments.length > limit && limit > 0) body.push(paint("muted", `  … ${result.segments.length - limit} preview lines hidden`, ui, caps));
  return [header, ...(rows ? wrapStyled(rows, width) : []), ...body].join("\n") + "\n";
}
