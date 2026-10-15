import type { PreviewSegment, VisibleToolResult } from "../../../src/sessions/visible.js";
import type { ToolResultType } from "../../../src/tools/display.js";

// What the tool cards read from a result without rendering it (docs/chat-design.md §6): no React, so unit tests and the
// work group's totals share it.

export const textOf = (segments: PreviewSegment[]) => segments.map((segment) => segment.text).join("\n");

/**
 * Each line's class in a unified diff. File headers are recognized only as an un-hunked `---`/`+++` pair; inside a
 * hunk, the line counts of its `@@` header decide where it ends, so a changed line whose text starts with `--` or
 * `++` stays a change. Approval previews also use the patch dialect's bare `@@` marker without counts; its
 * following header-looking content remains inside the hunk.
 */
export function diffKinds(lines: string[]): string[] {
  let oldLeft = 0;
  let newLeft = 0;
  let bareHunk = false;
  return lines.map((line, index) => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      bareHunk = false;
      return "diff-hunk";
    }
    if (line === "@@") {
      bareHunk = true;
      return "diff-hunk";
    }
    if (oldLeft > 0 || newLeft > 0 || bareHunk) {
      if (line.startsWith("+")) { newLeft--; return "diff-add"; }
      if (line.startsWith("-")) { oldLeft--; return "diff-remove"; }
      if (line.startsWith("\\")) return "diff-meta";
      oldLeft--;
      newLeft--;
      return "diff-context";
    }
    // Only a paired file header is metadata. A lone `--- text` or `+++ text` is content.
    const fileHeader = (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "))
      || (line.startsWith("+++ ") && lines[index - 1]?.startsWith("--- "));
    return fileHeader || /^(diff |index )/.test(line) ? "diff-meta diff-file" : line.startsWith("@@") ? "diff-meta" : line.startsWith("+") ? "diff-add"
      : line.startsWith("-") ? "diff-remove" : "diff-context";
  });
}

/**
 * Whether a diff's line counts are known: every file in it has a hunk. A file the host could not diff (binary, too large,
 * unreadable) has a bracketed notice instead of hunks, so its lines are unknown.
 */
export function diffCountable(text: string): boolean {
  const lines = text.replace(/\n$/, "").split("\n");
  const kinds = diffKinds(lines);
  let files = 0;
  let hunked = 0;
  let current = false;
  kinds.forEach((kind, index) => {
    if (kind.includes("diff-file") && lines[index]!.startsWith("--- ")) { files++; current = false; }
    else if (kind === "diff-hunk" && !current) { current = true; if (files) hunked++; }
  });
  return files ? hunked === files : kinds.includes("diff-hunk");
}

/** Added and removed lines of a unified diff; file headers do not count. */
export function diffStats(text: string): { added: number; removed: number } {
  const kinds = diffKinds(text.replace(/\n$/, "").split("\n"));
  return { added: kinds.filter((kind) => kind === "diff-add").length, removed: kinds.filter((kind) => kind === "diff-remove").length };
}

export function parsedJson(result: VisibleToolResult): unknown[] | undefined {
  if (result.json) return result.json;
  // Old records carry only the pretty-printed preview.
  if (!result.segments.length || !result.segments.every((segment) => segment.kind === "json")) return undefined;
  try {
    return [JSON.parse(textOf(result.segments))];
  } catch {
    return undefined;
  }
}

/** The text of a result's preview, without its JSON segments when it has a tree. */
export const previewText = (result: VisibleToolResult): string =>
  textOf(parsedJson(result) ? result.segments.filter((segment) => segment.kind !== "json") : result.segments);

/** Which body a result gets: terminal output, a diff, or another body (docs/tool-ux-design.md §5.4). */
export function bodyKind(result: VisibleToolResult, hint?: ToolResultType | undefined): "terminal" | "diff" | "other" {
  const type = result.resultType ?? hint;
  const text = previewText(result);
  const failed = result.status ? !["ok", "exit"].includes(result.status) : result.failed;
  const refused = result.status ? ["error", "denied"].includes(result.status) : result.failed && result.exitCode === undefined;
  if (type === "terminal" && !refused) return "terminal";
  if (!failed && type === "diff" && (result.host?.diff || text)) return "diff";
  return "other";
}

/**
 * What a tool card's footer Copy copies for a body that is not terminal output or a diff: the code lines of a code
 * result, else the text, then the structured JSON pretty-printed.
 */
export function resultCopy(result: VisibleToolResult, hint?: ToolResultType | undefined): { value: string; label: string } {
  const type = result.resultType ?? hint;
  const json = parsedJson(result);
  const segments = json ? result.segments.filter((segment) => segment.kind !== "json") : result.segments;
  const failed = result.status ? !["ok", "exit"].includes(result.status) : result.failed;
  if (!failed && type === "code" && segments.some((segment) => segment.kind === "code"))
    return { value: textOf(segments.filter((segment) => segment.kind === "code")), label: "Copy code" };
  const parts = [textOf(segments), ...(json ? [JSON.stringify(json.length === 1 ? json[0] : json, null, 2)] : [])];
  return { value: parts.filter(Boolean).join("\n"), label: "Copy result" };
}

/** The files a diff result names: its host files, else the `+++` headers of its diff. */
export function diffFileCount(result: VisibleToolResult): number {
  if (result.host?.files?.length) return result.host.files.length;
  const lines = (result.host?.diff ?? previewText(result)).replace(/\n$/, "").split("\n");
  // Only header lines: an added line whose text starts with `++ ` is a change inside a hunk.
  return diffKinds(lines).filter((kind, index) => kind.includes("diff-file") && lines[index]!.startsWith("+++ ")).length;
}
