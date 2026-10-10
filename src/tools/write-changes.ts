import { PANEL_LIMITS, type FileEntry, type PanelDocument } from "../panels/contract.js";
import { utf8Prefix } from "./results.js";
import { unifiedDiff } from "./line-diff.js";
import type { CompletedPatchChange } from "./file-patch.js";
import type { ToolContext } from "./primitives.js";

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "�");
type CompletedWriteChange = CompletedPatchChange & { beforeUnavailable?: boolean; afterUnavailable?: boolean };
const omittedKey = "Omitted history entries";
const DIFF_PREVIEW_BYTES = 6144;
/** Larger files are reported by size; the write snapshot reads one byte more to detect them. */
export const MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;

/** The changed regions of one write with surrounding context, not the start of the file. */
function diffPreview(change: CompletedWriteChange): string {
  const sides = [change.before, change.after];
  // A write snapshot stops one byte past the limit, so a longer side is only known to be larger than it.
  const size = (bytes: Buffer | undefined) => (bytes?.length ?? 0) > MAX_DIFF_SOURCE_BYTES ? `more than ${MAX_DIFF_SOURCE_BYTES}` : String(bytes?.length ?? 0);
  if (sides.some((bytes) => bytes && bytes.length > MAX_DIFF_SOURCE_BYTES)) return `[file too large to diff: ${size(change.before)} → ${size(change.after)} bytes]\n`;
  if (sides.some((bytes) => bytes?.subarray(0, 8192).includes(0))) return `[binary content: ${size(change.before)} → ${size(change.after)} bytes]\n`;
  // Indented code avoids treating any file bytes (including Markdown fences) as active markup.
  const diff = unifiedDiff(clean(change.before?.toString("utf8") ?? ""), clean(change.after?.toString("utf8") ?? ""), DIFF_PREVIEW_BYTES, "    ");
  return `${diff.text}\n${diff.truncated ? "\n[diff truncated]" : ""}`;
}

/** Bounded, persisted history of tool writes; it deliberately does not inspect Git or the workspace. */
export function buildWriteChanges(previous: PanelDocument | undefined, changes: readonly CompletedWriteChange[]): PanelDocument {
  const files = previous?.blocks.find(b => b.id === "files" && b.kind === "files") as { entries: FileEntry[] } | undefined;
  const retention = previous?.blocks.find(b => b.id === "retention" && b.kind === "key_value") as { entries: Array<{key: string; value: string}> } | undefined;
  let omitted = Number(retention?.entries.find(e => e.key === omittedKey)?.value ?? 0) || 0;
  const byPath = new Map((files?.entries ?? []).map(e => [e.path, { ...e }]));
  const put = (path: string, status: FileEntry["status"], label?: string) => {
    if ([...path].length > 500 || /[\u0000-\u001F\u007F]/.test(path)) { omitted++; return; }
    const old = byPath.get(path);
    byPath.delete(path);
    byPath.set(path, { path, status: status === "modified" && old?.status === "added" ? "added" : status!,
      ...(label ? { label: [...clean(label)].slice(0, 200).join("") } : {}) });
  };
  const previews: string[] = [];
  for (const change of changes) {
    if (change.kind === "renamed" && change.oldPath) {
      put(change.oldPath, "deleted", `${change.oldPath} → ${change.path}`);
      put(change.path, "added", `${change.oldPath} → ${change.path}`);
    } else put(change.path, change.kind === "deleted" ? "deleted" : change.kind === "added" ? "added" : "modified");
    previews.push(`Recent diff: ${clean(change.oldPath ? `${change.oldPath} → ${change.path}` : change.path)}\n\n${diffPreview(change)}${change.beforeUnavailable || change.afterUnavailable ? "\n[diff unavailable: file bytes could not be read]" : ""}`);
  }
  while (byPath.size > 200) { byPath.delete(byPath.keys().next().value!); omitted++; }
  const oldPreview = previous?.blocks.find(b => b.id === "recent_diff" && b.kind === "markdown") as { text: string } | undefined;
  const allPreview = [...previews.reverse(), ...(oldPreview ? [oldPreview.text] : [])].join("\n\n");
  const preview = utf8Prefix(allPreview, 12000);
  const doc = (): PanelDocument => ({ title: "Files changed", status: "done",
    subtitle: "Successful tool writes in this session; not Git status or Bash edits.",
    summary: `${byPath.size} paths shown; ${omitted} history entries omitted`,
    context_summary: `${byPath.size} successful tool-write paths retained; ${omitted} history entries omitted.`,
    blocks: [{ id: "files", kind: "files", entries: [...byPath.values()] },
      { id: "retention", kind: "key_value", entries: [{ key: omittedKey, value: String(omitted) }] },
      { id: "recent_diff", kind: "markdown", title: "Recent diff", text: preview.text + (preview.truncated ? "\n\n[diff truncated]" : "") }] });
  let document = doc();
  while (Buffer.byteLength(JSON.stringify(document)) > PANEL_LIMITS.documentBytes && byPath.size) {
    byPath.delete(byPath.keys().next().value!); omitted++; document = doc();
  }
  return document;
}

/** Publication is secondary to completed I/O and must never turn success into a write error. */
export async function publishWriteChanges(context: ToolContext, changes: readonly CompletedWriteChange[]): Promise<void> {
  if (!changes.length) return;
  try { context.onWriteCompleted?.(); } catch { /* host accounting cannot affect completed I/O */ }
  if (!context.panels) return;
  try {
    const previous = context.panels.get("files_changed")?.document;
    await context.panels.update("files_changed", { op: "replace", document: buildWriteChanges(previous, changes) });
  } catch { /* a full/closed panel does not undo filesystem changes */ }
}
