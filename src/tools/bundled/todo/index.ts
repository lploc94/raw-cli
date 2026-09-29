import { PANEL_LIMITS, type ChecklistItem, type PanelDocument, type PanelItemStatus } from "../../../panels/contract.js";
import { derivedProgress, statusGlyph, truncateBytes } from "../../../panels/render.js";
import type { ToolContext } from "../../primitives.js";
import { errorResult } from "../../results.js";
import type { ToolHandlerResult } from "../../types.js";

type Status = Extract<PanelItemStatus, "pending" | "in_progress" | "done" | "blocked" | "skipped">;
interface Todo { id: string; content: string; status: Status; parent?: string; note?: string }
interface Input { id?: string; content?: string; status?: Status; parent?: string; note?: string; remove?: true }

const MAX_ITEMS = 100;
const finished = (status: Status) => status === "done" || status === "skipped";
const invalid = (message: string) => errorResult("invalid_todo", message);

/** Argument-only validation (docs/panels-design.md §18); it never sees panel state. A `remove` item only needs its id; other fields on it are ignored. */
export function validateArgs(args: unknown): string | undefined {
  const { mode = "replace", todos, clear } = args as { mode?: string; todos: Input[]; clear?: unknown };
  if (mode === "replace" && clear !== undefined) return "clear is only allowed in merge mode";
  const ids = new Set<string>();
  const byId = new Map<string, Input>();
  let active = 0;
  for (const [index, item] of todos.entries()) {
    const at = `todos[${index}]`;
    if (mode === "replace") {
      if (item.content === undefined || item.status === undefined) return `${at}: content and status are required in replace mode`;
      if (item.remove !== undefined) return `${at}: remove is only allowed in merge mode`;
    } else {
      if (item.id === undefined) return `${at}: id is required in merge mode`;
    }
    if (item.id !== undefined) {
      if (ids.has(item.id)) return `${at}: duplicate id "${item.id}"`;
      ids.add(item.id);
      byId.set(item.id, item);
    }
    if (item.status === "in_progress" && ++active > 1) return `${at}: at most one item may be in_progress`;
  }
  for (const [index, item] of todos.entries()) {
    if (item.parent !== undefined && byId.get(item.parent)?.parent !== undefined) {
      return `todos[${index}]: parent "${item.parent}" is itself a subtask; nesting is limited to two levels`;
    }
  }
  return undefined;
}

function fromDocument(document: PanelDocument | undefined): { items: Todo[]; title?: string } {
  const block = document?.blocks.find((entry) => entry.id === "items" && entry.kind === "checklist") as { items: ChecklistItem[] } | undefined;
  const items: Todo[] = [];
  for (const top of block?.items ?? []) {
    items.push(toTodo(top));
    for (const child of top.children ?? []) items.push(toTodo(child, top.id));
  }
  return { items, ...(document?.title !== undefined ? { title: document.title } : {}) };
}

function toTodo(item: ChecklistItem, parent?: string): Todo {
  return { id: item.id, content: item.label, status: (item.status ?? "pending") as Status,
    ...(parent !== undefined ? { parent } : {}), ...(item.note !== undefined ? { note: item.note } : {}) };
}

/** The whole list must satisfy §18's state rules; the message names the offending item. */
function checkState(items: readonly Todo[], capacity = true): string | undefined {
  if (capacity && items.length > MAX_ITEMS) return `item "${items[MAX_ITEMS]!.id}": the list would hold ${items.length} items; the limit is ${MAX_ITEMS}`;
  const byId = new Map<string, Todo>();
  for (const item of items) {
    if (byId.has(item.id)) return `item "${item.id}": duplicate id`;
    byId.set(item.id, item);
  }
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    return `item "${items.filter((item) => item.status === "in_progress")[1]!.id}": at most one item may be in_progress`;
  }
  for (const item of items) {
    if (item.parent === undefined) continue;
    const parent = byId.get(item.parent);
    if (!parent) return `item "${item.id}": parent "${item.parent}" does not exist`;
    if (parent.parent !== undefined) return `item "${item.id}": parent "${item.parent}" is itself a subtask; nesting is limited to two levels`;
  }
  for (const item of items) {
    if (!finished(item.status)) continue;
    const open = items.find((child) => child.parent === item.id && !finished(child.status));
    if (open) return `item "${item.id}" cannot be ${item.status} while its subtask "${open.id}" is ${open.status}; finish or skip the subtask first`;
  }
  return undefined;
}

function generateIds(input: readonly Input[]): Todo[] {
  const used = new Set(input.flatMap((item) => item.id === undefined ? [] : [item.id]));
  let next = 1;
  return input.map((item) => {
    let id = item.id;
    if (id === undefined) {
      while (used.has(`t${next}`)) next++;
      id = `t${next}`;
      used.add(id);
    }
    return { id, content: item.content!, status: item.status!, ...(item.parent !== undefined ? { parent: item.parent } : {}),
      ...(item.note ? { note: item.note } : {}) };
  });
}

function merge(current: readonly Todo[], input: readonly Input[]): { items: Todo[] } | { error: string } {
  let items = current.map((item) => ({ ...item }));
  for (const change of input) {
    const id = change.id!;
    const index = items.findIndex((item) => item.id === id);
    if (change.remove) {
      if (index < 0) return { error: `item "${id}": cannot remove an item that does not exist` };
      items = items.filter((item) => item.id !== id && item.parent !== id);
    } else if (index >= 0) {
      const target = items[index]!;
      if (change.content !== undefined) target.content = change.content;
      if (change.status !== undefined) target.status = change.status;
      if (change.parent !== undefined) target.parent = change.parent;
      if (change.note !== undefined) { if (change.note) target.note = change.note; else delete target.note; }
    } else {
      if (change.content === undefined) return { error: `item "${id}": unknown id; adding an item needs content` };
      items.push({ id, content: change.content, status: change.status ?? "pending",
        ...(change.parent !== undefined ? { parent: change.parent } : {}), ...(change.note ? { note: change.note } : {}) });
    }
  }
  return { items };
}

function toChecklist(items: readonly Todo[]): ChecklistItem[] {
  const node = (item: Todo): ChecklistItem => ({ id: item.id, label: item.content, status: item.status, ...(item.note ? { note: item.note } : {}) });
  return items.filter((item) => item.parent === undefined).map((top) => {
    const children = items.filter((item) => item.parent === top.id).map(node);
    return { ...node(top), ...(children.length ? { children } : {}) };
  });
}

function lines(items: readonly Todo[]): string[] {
  const row = (item: Todo, depth: number) => `${"  ".repeat(depth)}${statusGlyph(item.status)} ${item.id} ${item.content}${item.note ? ` — ${item.note}` : ""}`;
  return items.filter((item) => item.parent === undefined).flatMap((top) =>
    [row(top, 0), ...items.filter((item) => item.parent === top.id).map((child) => row(child, 1))]);
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolHandlerResult> {
  if (!context.panels) return errorResult("panels_unavailable", "this host does not provide panels");
  const { mode = "replace", title, todos, clear } = args as { mode?: string; title?: string; todos: Input[]; clear?: "done" };
  const before = fromDocument(context.panels.get("todo")?.document);
  let items: Todo[];
  if (mode === "replace") items = generateIds(todos);
  else {
    const merged = merge(before.items, todos);
    if ("error" in merged) return invalid(merged.error);
    items = merged.items;
  }
  // The capacity limit applies to the resulting list, so it is checked after `clear` has removed finished items.
  let problem = checkState(items, clear !== "done");
  if (problem) return invalid(problem);
  if (clear === "done") {
    const removed = new Set(items.filter((item) => finished(item.status)).map((item) => item.id));
    items = items.filter((item) => !removed.has(item.id) && !(item.parent !== undefined && removed.has(item.parent)));
    problem = checkState(items);
    if (problem) return invalid(problem);
  }
  const listTitle = title ?? before.title;
  const checklist = toChecklist(items);
  const document: PanelDocument = { ...(listTitle !== undefined ? { title: listTitle } : {}),
    status: items.length === 0 ? "idle" : items.every((item) => finished(item.status)) ? "done" : "active",
    blocks: [{ id: "items", kind: "checklist", items: checklist }] };
  const progress = derivedProgress(document);
  const header = progress && progress.total ? `${progress.done}/${progress.total} done` : "empty";
  document.context_summary = truncateBytes([header, ...lines(items)].join("\n"), PANEL_LIMITS.contextSummaryBytes);
  const text = [`Todo (${header}):`, ...lines(items)].join("\n");
  return { isError: false, content: [{ type: "text", text }, { type: "panel", panel: "todo", op: "replace", document }] };
}
