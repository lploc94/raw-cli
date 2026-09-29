import type { ChecklistItem, PanelBlock, PanelDocument, PanelItemStatus, PanelReceipt, PanelRef, StoredPanel } from "./contract.js";

const GLYPH: Record<PanelItemStatus, string> = {
  pending: "[ ]", in_progress: "[~]", done: "[x]", skipped: "[-]", blocked: "[!]", failed: "[✗]",
};
export const statusGlyph = (status: PanelItemStatus | undefined): string => GLYPH[status ?? "pending"];

const isDone = (status: PanelItemStatus | undefined) => status === "done" || status === "skipped";

function leaves(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.flatMap((item) => item.children?.length ? leaves(item.children) : [item]);
}

/** §6: leaf checklist items, else `steps`; `undefined` when the document has neither. */
export function derivedProgress(doc: PanelDocument): { done: number; total: number } | undefined {
  if (doc.progress) return doc.progress;
  const checklists = doc.blocks.filter((block) => block.kind === "checklist");
  const source = checklists.length ? checklists : doc.blocks.filter((block) => block.kind === "steps");
  if (!source.length) return undefined;
  const items = checklists.length
    ? checklists.flatMap((block) => leaves((block as Extract<PanelBlock, { kind: "checklist" }>).items))
    : source.flatMap((block) => (block as Extract<PanelBlock, { kind: "steps" }>).items);
  return { done: items.filter((item) => isDone(item.status)).length, total: items.length };
}

/** First `in_progress` item in document and tree order, parents included (§6 summary). */
function firstInProgress(doc: PanelDocument): string | undefined {
  const search = (items: readonly ChecklistItem[]): string | undefined => {
    for (const item of items) {
      if (item.status === "in_progress") return item.label;
      const inner = item.children && search(item.children);
      if (inner) return inner;
    }
    return undefined;
  };
  for (const block of doc.blocks) {
    if (block.kind !== "checklist" && block.kind !== "steps") continue;
    const found = search((block as Extract<PanelBlock, { kind: "checklist" | "steps" }>).items as ChecklistItem[]);
    if (found) return found;
  }
  return undefined;
}

export function derivedSummary(doc: PanelDocument, fallbackTitle = ""): string {
  if (doc.summary !== undefined) return doc.summary;
  const progress = derivedProgress(doc);
  if (progress) {
    const active = firstInProgress(doc);
    return truncate(`${progress.done}/${progress.total}${active ? ` · ${active}` : ""}`, 120);
  }
  return truncate(doc.blocks.find((block) => block.title)?.title ?? doc.title ?? fallbackTitle, 120);
}

function truncate(value: string, max: number): string {
  const all = [...value];
  return all.length <= max ? value : `${all.slice(0, max - 1).join("")}…`;
}

export function truncateBytes(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value;
  let out = "";
  for (const char of value) {
    if (Buffer.byteLength(out + char) > max - 3) break;
    out += char;
  }
  return `${out}…`;
}

const at = (ref?: PanelRef) => ref ? ` (${ref.path}${ref.line ? `:${ref.line}` : ""})` : "";

function duration(start?: number, end?: number): string {
  if (start === undefined || end === undefined || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return ` (${seconds}s)`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? ` (${minutes}m)` : ` (${Math.round(minutes / 60)}h)`;
}

function renderChecklist(items: readonly ChecklistItem[], depth: number, lines: string[]): void {
  for (const item of items) {
    lines.push(`${"  ".repeat(depth)}${statusGlyph(item.status)} ${item.label}${item.note ? ` — ${item.note}` : ""}${at(item.ref)}`);
    if (item.children) renderChecklist(item.children, depth + 1, lines);
  }
}

function renderBlock(block: PanelBlock): string[] {
  const lines: string[] = block.title ? [`## ${block.title}`] : [];
  switch (block.kind) {
    case "checklist": renderChecklist((block as Extract<PanelBlock, { kind: "checklist" }>).items, 0, lines); break;
    case "steps":
      (block as Extract<PanelBlock, { kind: "steps" }>).items.forEach((item, index) => lines.push(
        `${index + 1}. ${statusGlyph(item.status)} ${item.label}${item.detail ? ` — ${item.detail}` : ""}${duration(item.started_at, item.ended_at)}`));
      break;
    case "progress": {
      const item = block as Extract<PanelBlock, { kind: "progress" }>;
      lines.push(`${item.label ?? "Progress"} ${item.indeterminate ? "…" : `${Math.round((item.value! / item.max!) * 100)}%`}`);
      break;
    }
    case "key_value":
      for (const entry of (block as Extract<PanelBlock, { kind: "key_value" }>).entries) lines.push(`${entry.key}: ${entry.value}${at(entry.ref)}`);
      break;
    case "table": {
      const table = block as Extract<PanelBlock, { kind: "table" }>;
      const shown = table.rows.slice(0, 50);
      const rows = shown.map((row) => [row.status ? statusGlyph(row.status) : "", ...table.columns.map((column) => Object.hasOwn(row.cells, column.id) ? row.cells[column.id]! : "")]);
      const header = ["", ...table.columns.map((column) => column.label)];
      const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => [...row[column]!].length)));
      const pad = (row: string[]) => row.map((cell, column) => cell + " ".repeat(widths[column]! - [...cell].length)).join("  ").trimEnd();
      lines.push(pad(header), ...rows.map(pad));
      if (table.rows.length > shown.length) lines.push(`… ${table.rows.length - shown.length} more rows`);
      break;
    }
    case "markdown": lines.push((block as Extract<PanelBlock, { kind: "markdown" }>).text); break;
    case "timeline":
      for (const event of [...(block as Extract<PanelBlock, { kind: "timeline" }>).events].reverse()) {
        lines.push(`[${event.level}] ${event.label}${event.detail ? ` — ${event.detail}` : ""}`);
      }
      break;
    case "files":
      for (const entry of (block as Extract<PanelBlock, { kind: "files" }>).entries) {
        lines.push(`${(entry.status ?? "referenced")[0]!.toUpperCase()} ${entry.path}${entry.line ? `:${entry.line}` : ""}${entry.label ? ` ${entry.label}` : ""}`);
      }
      break;
    default:
      lines.push(typeof block.fallback === "string" ? block.fallback : `Unsupported block "${block.kind}"`);
  }
  return lines;
}

/** Plain-text rendering used by the CLI, ACP replay fallbacks and the compaction reminder. */
export function renderPanelText(title: string, doc: PanelDocument): string {
  const progress = derivedProgress(doc);
  const head = `${doc.title ?? title}${progress ? ` (${progress.done}/${progress.total})` : ""}${doc.subtitle ? ` — ${doc.subtitle}` : ""}`;
  return [head, ...doc.blocks.flatMap(renderBlock)].join("\n");
}

export interface PlanEntry { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }
const PLAN_STATUS: Record<PanelItemStatus, PlanEntry["status"]> = { pending: "pending", in_progress: "in_progress", done: "completed", skipped: "completed", blocked: "pending", failed: "pending" };
/** §13.3: the first checklist block flattened depth-first (a parent, then its subtasks) as ACP plan entries. */
export function planEntries(doc: PanelDocument): PlanEntry[] {
  const block = doc.blocks.find((candidate) => candidate.kind === "checklist") as unknown as { items: ChecklistItem[] } | undefined;
  const walk = (items: readonly ChecklistItem[]): PlanEntry[] => items.flatMap((item) =>
    [{ content: item.label, priority: item.priority ?? "medium", status: PLAN_STATUS[item.status ?? "pending"] }, ...walk(item.children ?? [])]);
  return block ? walk(block.items) : [];
}

/** §13.2: the text of the given panels, one after another, as `/panels` and `raw sessions panels` print them. */
export function renderPanelsText(panels: ReadonlyArray<{ title: string; document: PanelDocument; closed?: boolean }>): string {
  return panels.map((panel) => `${renderPanelText(panel.title, panel.document)}${panel.closed ? "\n(closed)" : ""}`).join("\n\n");
}

/**
 * The panels `/panels` and `raw sessions panels` show: open ones (all with `all`), or one panel by full ID or by its local ID
 * when that is unambiguous. `undefined` means the requested panel does not exist.
 */
export function selectPanels(panels: readonly StoredPanel[], options: { all?: boolean; id?: string } = {}): StoredPanel[] | undefined {
  if (options.id === undefined) return panels.filter((panel) => options.all || !panel.closed);
  const local = (panel: StoredPanel) => panel.panelId.slice(panel.owner.length + 1);
  const exact = panels.filter((panel) => panel.panelId === options.id);
  const found = exact.length ? exact : panels.filter((panel) => local(panel) === options.id);
  return found.length === 1 && (options.all || !found[0]!.closed) ? found : undefined;
}
export const panelTitle = (panel: StoredPanel): string => panel.document.title ?? panel.declaration.title;

/** One CLI receipt line. It never relies on color. */
export function receiptLine(receipt: Pick<PanelReceipt, "title" | "revision" | "summary" | "error">): string {
  if (receipt.error) return `  ▸ ${receipt.title} update rejected: ${receipt.error.code}`;
  return `  ▸ ${receipt.title} r${receipt.revision}${receipt.summary ? ` · ${receipt.summary}` : ""}`;
}
