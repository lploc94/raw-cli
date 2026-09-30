import { parseFilePatch } from "../tools/file-patch.js";
import type { ToolResult } from "../tools/types.js";

export interface VisibleToolCall {
  id?: string;
  name: string;
  identity?: string;
  started: boolean;
  arguments: Record<string, unknown>;
}
export interface PreviewSegment {
  kind: "text" | "json" | "code" | "image";
  text: string;
  path?: string;
  language?: string;
}
export interface VisibleBatchRow { index: number; status: string; exitCode?: number; path?: string }
export interface VisibleToolResult {
  id?: string;
  name: string;
  identity?: string;
  failed: boolean;
  code?: string;
  exitCode?: number | null;
  truncated: boolean;
  durationMs?: number;
  rows: VisibleBatchRow[];
  segments: PreviewSegment[];
}

const PREVIEW_CHARS = 2000;
const PREVIEW_LINES = 9;
const builtins = new Set(["builtin/read_file", "builtin/write_file", "builtin/bash"]);

export function projectToolCall(name: string, identity: string | undefined, args: Record<string, unknown>, started: boolean): VisibleToolCall {
  if (identity === "builtin/write_file") {
    if (typeof args.patch === "string") {
      let paths: string[] = [];
      try { paths = parseFilePatch(args.patch, "/").changes.map(change => change.rawDestination ? `${change.rawPath} → ${change.rawDestination}` : change.rawPath); } catch { /* invalid patch still gets a content-free summary */ }
      return { name, identity, started, arguments: { patch_bytes: Buffer.byteLength(args.patch), patch_paths: paths } };
    }
    if (!Array.isArray(args.operations)) return { name, identity, started, arguments: { argument_keys: Object.keys(args) } };
    return { name, identity, started, arguments: { operations: args.operations.map((value: unknown) => {
      const op = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { path: op.path, mode: op.mode,
        ...(typeof op.content === "string" ? { content_bytes: Buffer.byteLength(op.content, "utf8") } : {}),
        ...(typeof op.old_text === "string" ? { old_text_bytes: Buffer.byteLength(op.old_text, "utf8") } : {}),
        ...(typeof op.new_text === "string" ? { new_text_bytes: Buffer.byteLength(op.new_text, "utf8") } : {}),
        ...(op.start_line !== undefined ? { start_line: op.start_line } : {}),
        ...(op.end_line !== undefined ? { end_line: op.end_line } : {}),
      };
    }) } };
  }
  return { name, ...(identity ? { identity } : {}), started, arguments: structuredClone(args) };
}

function bounded(lines: PreviewSegment[]): PreviewSegment[] {
  const limited = lines.length > PREVIEW_LINES
    ? [...lines.slice(0, 4), { kind: "text" as const, text: "… [middle lines hidden] …" }, ...lines.slice(-4)] : lines;
  const bodyCap = PREVIEW_CHARS - (PREVIEW_LINES - 1);
  const count = limited.reduce((sum, line) => sum + [...line.text].length, 0);
  if (count <= bodyCap) return limited;
  const marker = "… [middle characters hidden] …";
  const allowance = bodyCap - [...marker].length;
  const head: PreviewSegment[] = [];
  const tail: PreviewSegment[] = [];
  let remaining = Math.ceil(allowance / 2);
  for (const line of limited) {
    if (remaining <= 0 || head.length >= 4) break;
    const chars = [...line.text];
    const take = Math.min(chars.length, remaining);
    head.push({ ...line, text: chars.slice(0, take).join("") });
    remaining -= take;
  }
  remaining = Math.floor(allowance / 2);
  for (const line of [...limited].reverse()) {
    if (remaining <= 0 || tail.length >= 4) break;
    const chars = [...line.text];
    const take = Math.min(chars.length, remaining);
    tail.unshift({ ...line, text: chars.slice(-take).join("") });
    remaining -= take;
  }
  return [...head, { kind: "text" as const, text: marker }, ...tail];
}

function addLines(lines: PreviewSegment[], kind: PreviewSegment["kind"], value: string, path?: string): void {
  if (!value) return;
  for (const line of value.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")) {
    lines.push({ kind, text: line, ...(path ? { path } : {}) });
  }
}

export function projectToolResult(name: string, identity: string | undefined, result: ToolResult, durationMs?: number): VisibleToolResult {
  const rows: VisibleBatchRow[] = [];
  const lines: PreviewSegment[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      addLines(lines, "text", block.channel ? `[${block.channel}]\n${block.text}` : block.text);
      continue;
    }
    if (block.type === "image") {
      addLines(lines, "image", `[${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes]`);
      continue;
    }
    const value = block.value;
    const batch = builtins.has(identity ?? "") && value && typeof value === "object" && !Array.isArray(value)
      && Array.isArray((value as { results?: unknown }).results)
      ? (value as { results: unknown[] }).results : undefined;
    if (batch && batch.length <= 16 && batch.every((item) => item && typeof item === "object" && !Array.isArray(item)
      && Number.isSafeInteger((item as Record<string, unknown>).index) && typeof (item as Record<string, unknown>).status === "string")) {
      for (const item of batch) {
        const row = item as Record<string, unknown>;
        rows.push({ index: row.index as number, status: row.status as string,
          ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
          ...(typeof row.path === "string" ? { path: row.path } : {}) });
        if (identity === "builtin/read_file" && typeof row.path === "string" && typeof row.text === "string") {
          addLines(lines, "text", `${row.index}:${row.status} ${row.path}`);
          addLines(lines, "code", row.text, row.path);
        } else addLines(lines, "json", JSON.stringify(row));
      }
    } else addLines(lines, "json", JSON.stringify(value));
  }
  return { name, ...(identity ? { identity } : {}), failed: result.isError
      || (typeof result.exitCode === "number" && result.exitCode !== 0)
      || rows.some((row) => row.status !== "ok"),
    ...(result.code ? { code: result.code } : {}), ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    truncated: result.truncated ?? false,
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    rows, segments: bounded(lines) };
}

export function renderPlainToolResult(result: VisibleToolResult): string {
  const statuses = result.rows.length ? `statuses: ${result.rows.map((row) =>
    `${row.index}:${row.status}${row.exitCode === undefined ? "" : `(exit${row.exitCode})`}`).join(" ")}` : "";
  return [statuses, ...result.segments.map((segment) => segment.text)].filter(Boolean).join("\n");
}
