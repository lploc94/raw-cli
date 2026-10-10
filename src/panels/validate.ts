import {
  MAX_TEXT_ANSWER_BYTES, PANEL_ICONS, PANEL_ITEM_STATUSES, PANEL_LIMITS, PANEL_STATUSES, PanelError,
  type PanelAction, type PanelBlock, type PanelDeclaration, type PanelDocument, type PanelPatch, type PanelUpdate,
} from "./contract.js";

type Path = readonly (string | number)[];
type Obj = Record<string, unknown>;

const pointer = (path: Path): string => "/" + path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
export function invalid(path: Path, reason: string): never {
  throw new PanelError("panel_invalid", `${pointer(path)}: ${reason}`);
}

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const BLOCK_ID = /^[A-Za-z0-9_-]{1,32}$/;
const ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const PANEL_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function object(value: unknown, path: Path): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  return value as Obj;
}
function keys(value: Obj, allowed: readonly string[], path: Path): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid([...path, key], "unknown field");
}
function text(value: unknown, path: Path, max: number, min = 0): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (CONTROL.test(value)) invalid(path, "contains a control character");
  const count = value.length <= max ? value.length : [...value].length;
  if (count > max) invalid(path, `must be at most ${max} characters`);
  if (count < min) invalid(path, min === 1 ? "must not be empty" : `must be at least ${min} characters`);
  return value;
}
function bytesText(value: unknown, path: Path, maxBytes: number): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (CONTROL.test(value)) invalid(path, "contains a control character");
  if (Buffer.byteLength(value) > maxBytes) invalid(path, `must be at most ${maxBytes} bytes`);
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: Path): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T;
}
function id(value: unknown, pattern: RegExp, path: Path): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(path, `must match ${pattern.source}`);
  return value;
}
function array(value: unknown, path: Path, max: number, min = 0): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length > max) invalid(path, `must have at most ${max} entries`);
  if (value.length < min) invalid(path, `must have at least ${min} entries`);
  return value;
}
function count(value: unknown, path: Path, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(path, `must be an integer of at least ${min}`);
  return value;
}
function finite(value: unknown, path: Path): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(path, "must be a non-negative finite number");
  return value;
}
function ref(value: unknown, path: Path): void {
  const item = object(value, path);
  keys(item, ["path", "line"], path);
  text(item.path, [...path, "path"], 500, 1);
  if (item.line !== undefined) count(item.line, [...path, "line"], 1);
}
function status(value: unknown, path: Path): void { oneOf(value, PANEL_ITEM_STATUSES, path); }

const COMMON = ["id", "kind", "title", "fallback"];

function checklist(items: unknown, path: Path, depth: number, ids: Set<string>, total: { n: number }): void {
  for (const [index, raw] of array(items, path, PANEL_LIMITS.items).entries()) {
    const at = [...path, index];
    const item = object(raw, at);
    keys(item, ["id", "label", "status", "priority", "note", "ref", "children"], at);
    const itemId = id(item.id, ITEM_ID, [...at, "id"]);
    if (ids.has(itemId)) invalid([...at, "id"], "duplicate item id");
    ids.add(itemId);
    if (++total.n > PANEL_LIMITS.items) invalid(path, `must hold at most ${PANEL_LIMITS.items} items including children`);
    text(item.label, [...at, "label"], 200, 1);
    if (item.status !== undefined) status(item.status, [...at, "status"]);
    if (item.priority !== undefined) oneOf(item.priority, ["high", "medium", "low"], [...at, "priority"]);
    if (item.note !== undefined) text(item.note, [...at, "note"], 500);
    if (item.ref !== undefined) ref(item.ref, [...at, "ref"]);
    if (item.children !== undefined) {
      const children = array(item.children, [...at, "children"], PANEL_LIMITS.items);
      if (children.length && depth >= PANEL_LIMITS.checklistDepth) invalid([...at, "children"], `nesting is at most ${PANEL_LIMITS.checklistDepth} levels`);
      checklist(children, [...at, "children"], depth + 1, ids, total);
    }
  }
}

function block(value: unknown, path: Path): PanelBlock {
  const item = object(value, path);
  id(item.id, BLOCK_ID, [...path, "id"]);
  if (typeof item.kind !== "string" || !item.kind) invalid([...path, "kind"], "must be a string");
  if (CONTROL.test(item.kind)) invalid([...path, "kind"], "contains a control character");
  if (item.title !== undefined) text(item.title, [...path, "title"], 80);
  if (item.fallback !== undefined) bytesText(item.fallback, [...path, "fallback"], PANEL_LIMITS.fallbackBytes);
  const kind = item.kind;
  const own = (extra: string[]) => keys(item, [...COMMON, ...extra], path);
  switch (kind) {
    case "mermaid":
      own(["source"]);
      bytesText(item.source, [...path, "source"], 16 * 1024);
      if (!item.source) invalid([...path, "source"], "must not be empty");
      break;
    case "form": {
      own(["fields"]);
      const ids = new Set<string>();
      for (const [index, raw] of array(item.fields, [...path, "fields"], 8, 1).entries()) {
        const at = [...path, "fields", index];
        const field = object(raw, at);
        const fieldId = id(field.id, ITEM_ID, [...at, "id"]);
        if (ids.has(fieldId)) invalid([...at, "id"], "duplicate field id");
        ids.add(fieldId);
        text(field.label, [...at, "label"], 200, 1);
        if (field.description !== undefined) text(field.description, [...at, "description"], 500);
        if (field.required !== undefined && typeof field.required !== "boolean") invalid([...at, "required"], "must be boolean");
        const fieldKind = oneOf(field.kind, ["text", "single_select", "multi_select"], [...at, "kind"]);
        const base = ["id", "label", "description", "required", "kind"];
        if (fieldKind === "text") {
          keys(field, [...base, "multiline", "max_bytes"], at);
          if (field.multiline !== undefined && typeof field.multiline !== "boolean") invalid([...at, "multiline"], "must be boolean");
          if (field.max_bytes !== undefined && count(field.max_bytes, [...at, "max_bytes"], 1) > MAX_TEXT_ANSWER_BYTES) invalid([...at, "max_bytes"], `must be at most ${MAX_TEXT_ANSWER_BYTES}`);
        } else {
          keys(field, [...base, "options", ...(fieldKind === "multi_select" ? ["min_selected", "max_selected"] : [])], at);
          const options = array(field.options, [...at, "options"], 32, 1);
          const optionIds = new Set<string>();
          for (const [index, raw] of options.entries()) {
            const loc = [...at, "options", index];
            const option = object(raw, loc);
            keys(option, ["id", "label"], loc);
            const optionId = id(option.id, ITEM_ID, [...loc, "id"]);
            if (optionIds.has(optionId)) invalid([...loc, "id"], "duplicate option id");
            optionIds.add(optionId);
            text(option.label, [...loc, "label"], 200, 1);
          }
          if (fieldKind === "multi_select") {
            const min = field.min_selected === undefined ? 0 : count(field.min_selected, [...at, "min_selected"]);
            const max = field.max_selected === undefined ? options.length : count(field.max_selected, [...at, "max_selected"], 1);
            if (min > max || max > options.length) invalid(at, "invalid selection limits");
          }
        }
      }
      break;
    }
    case "checklist": {
      own(["items"]);
      checklist(item.items, [...path, "items"], 1, new Set(), { n: 0 });
      break;
    }
    case "steps": {
      own(["items"]);
      const ids = new Set<string>();
      for (const [index, raw] of array(item.items, [...path, "items"], PANEL_LIMITS.steps).entries()) {
        const at = [...path, "items", index];
        const step = object(raw, at);
        keys(step, ["id", "label", "status", "detail", "started_at", "ended_at"], at);
        const stepId = id(step.id, ITEM_ID, [...at, "id"]);
        if (ids.has(stepId)) invalid([...at, "id"], "duplicate item id");
        ids.add(stepId);
        text(step.label, [...at, "label"], 200, 1);
        if (step.status !== undefined) status(step.status, [...at, "status"]);
        if (step.detail !== undefined) text(step.detail, [...at, "detail"], 200);
        if (step.started_at !== undefined) count(step.started_at, [...at, "started_at"]);
        if (step.ended_at !== undefined) count(step.ended_at, [...at, "ended_at"]);
      }
      break;
    }
    case "progress": {
      own(["label", "value", "max", "indeterminate"]);
      if (item.label !== undefined) text(item.label, [...path, "label"], 200);
      if (item.indeterminate !== undefined) {
        if (item.indeterminate !== true) invalid([...path, "indeterminate"], "must be true");
        if (item.value !== undefined || item.max !== undefined) invalid(path, "indeterminate excludes value and max");
      } else {
        const value = finite(item.value, [...path, "value"]);
        const max = finite(item.max, [...path, "max"]);
        if (max <= 0) invalid([...path, "max"], "must be greater than 0");
        if (value > max) invalid([...path, "value"], "must not exceed max");
      }
      break;
    }
    case "key_value": {
      own(["entries"]);
      const seen = new Set<string>();
      for (const [index, raw] of array(item.entries, [...path, "entries"], 50).entries()) {
        const at = [...path, "entries", index];
        const entry = object(raw, at);
        keys(entry, ["key", "value", "ref"], at);
        const key = text(entry.key, [...at, "key"], 60, 1);
        if (seen.has(key)) invalid([...at, "key"], "duplicate key");
        seen.add(key);
        text(entry.value, [...at, "value"], 500);
        if (entry.ref !== undefined) ref(entry.ref, [...at, "ref"]);
      }
      break;
    }
    case "table": {
      own(["columns", "rows"]);
      const columns = new Set<string>();
      for (const [index, raw] of array(item.columns, [...path, "columns"], 8, 1).entries()) {
        const at = [...path, "columns", index];
        const column = object(raw, at);
        keys(column, ["id", "label", "align"], at);
        const columnId = id(column.id, ITEM_ID, [...at, "id"]);
        if (columns.has(columnId)) invalid([...at, "id"], "duplicate column id");
        columns.add(columnId);
        text(column.label, [...at, "label"], 60);
        if (column.align !== undefined) oneOf(column.align, ["start", "end", "center"], [...at, "align"]);
      }
      const ids = new Set<string>();
      for (const [index, raw] of array(item.rows, [...path, "rows"], PANEL_LIMITS.items).entries()) {
        const at = [...path, "rows", index];
        const row = object(raw, at);
        keys(row, ["id", "status", "cells", "ref"], at);
        const rowId = id(row.id, ITEM_ID, [...at, "id"]);
        if (ids.has(rowId)) invalid([...at, "id"], "duplicate item id");
        ids.add(rowId);
        if (row.status !== undefined) status(row.status, [...at, "status"]);
        if (row.ref !== undefined) ref(row.ref, [...at, "ref"]);
        const cells = object(row.cells, [...at, "cells"]);
        for (const [column, cell] of Object.entries(cells)) {
          if (!columns.has(column)) invalid([...at, "cells", column], "unknown column");
          text(cell, [...at, "cells", column], 300);
        }
      }
      break;
    }
    case "markdown": {
      own(["text"]);
      bytesText(item.text, [...path, "text"], PANEL_LIMITS.markdownBytes);
      break;
    }
    case "timeline": {
      own(["max", "events"]);
      const max = item.max === undefined ? 100 : count(item.max, [...path, "max"], 1);
      if (max > 200) invalid([...path, "max"], "must be at most 200");
      const ids = new Set<string>();
      for (const [index, raw] of array(item.events, [...path, "events"], Math.min(max, PANEL_LIMITS.items)).entries()) {
        const at = [...path, "events", index];
        const event = object(raw, at);
        keys(event, ["id", "at", "level", "label", "detail"], at);
        const eventId = id(event.id, ITEM_ID, [...at, "id"]);
        if (ids.has(eventId)) invalid([...at, "id"], "duplicate item id");
        ids.add(eventId);
        count(event.at, [...at, "at"]);
        oneOf(event.level, ["info", "success", "warning", "error"], [...at, "level"]);
        text(event.label, [...at, "label"], 200, 1);
        if (event.detail !== undefined) text(event.detail, [...at, "detail"], 1000);
      }
      break;
    }
    case "files": {
      own(["entries"]);
      const seen = new Set<string>();
      for (const [index, raw] of array(item.entries, [...path, "entries"], PANEL_LIMITS.items).entries()) {
        const at = [...path, "entries", index];
        const entry = object(raw, at);
        keys(entry, ["path", "status", "line", "label"], at);
        const filePath = text(entry.path, [...at, "path"], 500, 1);
        if (seen.has(filePath)) invalid([...at, "path"], "duplicate path");
        seen.add(filePath);
        if (entry.status !== undefined) oneOf(entry.status, ["added", "modified", "deleted", "referenced"], [...at, "status"]);
        if (entry.line !== undefined) count(entry.line, [...at, "line"], 1);
        if (entry.label !== undefined) text(entry.label, [...at, "label"], 200);
      }
      break;
    }
    default: {
      // Forward compatibility: an unknown kind keeps its common fields; the rest must still be plain JSON.
      try { JSON.stringify(item); } catch { invalid(path, "is not serializable"); }
    }
  }
  return item as unknown as PanelBlock;
}

export function validateDocument(value: unknown): PanelDocument {
  const doc = object(value, []);
  keys(doc, ["title", "subtitle", "status", "progress", "summary", "context_summary", "blocks"], []);
  if (doc.title !== undefined) text(doc.title, ["title"], 80);
  if (doc.subtitle !== undefined) text(doc.subtitle, ["subtitle"], 120);
  if (doc.status !== undefined) oneOf(doc.status, PANEL_STATUSES, ["status"]);
  if (doc.summary !== undefined) text(doc.summary, ["summary"], 120);
  if (doc.context_summary !== undefined) bytesText(doc.context_summary, ["context_summary"], PANEL_LIMITS.contextSummaryBytes);
  if (doc.progress !== undefined) {
    const progress = object(doc.progress, ["progress"]);
    keys(progress, ["done", "total"], ["progress"]);
    const done = count(progress.done, ["progress", "done"]);
    const total = count(progress.total, ["progress", "total"]);
    if (done > total) invalid(["progress", "done"], "must not exceed total");
  }
  const seen = new Set<string>();
  for (const [index, raw] of array(doc.blocks, ["blocks"], PANEL_LIMITS.blocks).entries()) {
    const checked = block(raw, ["blocks", index]);
    if (seen.has(checked.id)) invalid(["blocks", index, "id"], "duplicate block id");
    seen.add(checked.id);
  }
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(doc)); } catch { invalid([], "is not serializable"); }
  if (size > PANEL_LIMITS.documentBytes) throw new PanelError("panel_too_large", `document is ${size} bytes; the limit is ${PANEL_LIMITS.documentBytes}`);
  return doc as unknown as PanelDocument;
}

const SET_FIELDS = ["title", "subtitle", "status", "summary", "context_summary", "progress"];

/** Shape-checks one patch. Field-level merge results are validated as part of the whole document afterwards. */
function patch(value: unknown, path: Path): PanelPatch {
  const item = object(value, path);
  switch (item.op) {
    case "set":
      keys(item, ["op", "field", "value"], path);
      oneOf(item.field, SET_FIELDS, [...path, "field"]);
      if (!Object.hasOwn(item, "value")) invalid([...path, "value"], "is required");
      break;
    case "set_block":
      keys(item, ["op", "block", "before"], path);
      block(item.block, [...path, "block"]);
      if (item.before !== undefined) id(item.before, BLOCK_ID, [...path, "before"]);
      break;
    case "remove_block":
      keys(item, ["op", "id"], path);
      id(item.id, BLOCK_ID, [...path, "id"]);
      break;
    case "upsert_items": {
      keys(item, ["op", "block", "items", "parent"], path);
      id(item.block, BLOCK_ID, [...path, "block"]);
      for (const [index, raw] of array(item.items, [...path, "items"], PANEL_LIMITS.items, 1).entries()) object(raw, [...path, "items", index]);
      if (item.parent !== undefined) id(item.parent, ITEM_ID, [...path, "parent"]);
      break;
    }
    case "remove_items": {
      keys(item, ["op", "block", "ids", "keys", "paths"], path);
      id(item.block, BLOCK_ID, [...path, "block"]);
      const selectors = ["ids", "keys", "paths"].filter((name) => item[name] !== undefined);
      if (selectors.length !== 1) invalid(path, "exactly one of ids, keys or paths is required");
      const name = selectors[0]!;
      for (const [index, entry] of array(item[name], [...path, name], PANEL_LIMITS.items, 1).entries()) {
        if (typeof entry !== "string") invalid([...path, name, index], "must be a string");
      }
      break;
    }
    case "append_events":
      keys(item, ["op", "block", "events"], path);
      id(item.block, BLOCK_ID, [...path, "block"]);
      array(item.events, [...path, "events"], PANEL_LIMITS.items, 1);
      break;
    default:
      invalid([...path, "op"], "unknown patch operation");
  }
  return item as unknown as PanelPatch;
}

export function validateUpdate(value: unknown): PanelUpdate {
  const update = object(value, []);
  id(update.panel, PANEL_ID, ["panel"]);
  switch (update.op) {
    case "replace":
      keys(update, ["panel", "op", "document", "base_revision"], []);
      if (update.base_revision !== undefined) count(update.base_revision, ["base_revision"]);
      if (update.document === undefined) invalid(["document"], "is required");
      validateDocument(update.document);
      break;
    case "patch":
      keys(update, ["panel", "op", "base_revision", "patches"], []);
      if (update.base_revision !== undefined) count(update.base_revision, ["base_revision"]);
      for (const [index, raw] of array(update.patches, ["patches"], Infinity, 1).entries()) patch(raw, ["patches", index]);
      break;
    case "close":
      keys(update, ["panel", "op", "base_revision"], []);
      if (update.base_revision !== undefined) count(update.base_revision, ["base_revision"]);
      break;
    default:
      invalid(["op"], "must be replace, patch or close");
  }
  return update as unknown as PanelUpdate;
}

const TEMPLATE = /\{\{\s*([^}]*?)\s*\}\}/g;
const TEMPLATE_NAMES = ["panel.id", "block.id", "item.id", "item.label"];
function checkTemplates(value: unknown, path: Path): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE)) if (!TEMPLATE_NAMES.includes(match[1]!)) invalid(path, `unknown template {{${match[1]}}}`);
  } else if (Array.isArray(value)) value.forEach((entry, index) => checkTemplates(entry, [...path, index]));
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) checkTemplates(entry, [...path, key]);
}

function action(value: unknown, path: Path): PanelAction {
  const item = object(value, path);
  keys(item, ["id", "label", "scope", "blocks", "kind", "text", "send", "arguments", "response", "primary", "confirm", "when"], path);
  id(item.id, PANEL_ID, [...path, "id"]);
  text(item.label, [...path, "label"], 32, 1);
  const scope = oneOf(item.scope, ["panel", "block", "item"], [...path, "scope"]);
  const kind = oneOf(item.kind, ["prompt", "tool", "response"], [...path, "kind"]);
  if (kind !== "response" && item.response !== undefined) invalid([...path, "response"], "is only for response actions");
  if (item.blocks !== undefined) {
    if (scope === "panel") invalid([...path, "blocks"], "is not allowed for panel scope");
    for (const [index, entry] of array(item.blocks, [...path, "blocks"], PANEL_LIMITS.blocks, 1).entries()) id(entry, BLOCK_ID, [...path, "blocks", index]);
  }
  if (kind === "prompt") {
    text(item.text, [...path, "text"], 2000, 1);
    if (item.send !== undefined && typeof item.send !== "boolean") invalid([...path, "send"], "must be a boolean");
    if (item.arguments !== undefined) invalid([...path, "arguments"], "is only for tool actions");
    checkTemplates(item.text, [...path, "text"]);
  } else if (kind === "tool") {
    object(item.arguments, [...path, "arguments"]);
    if (item.text !== undefined || item.send !== undefined) invalid(path, "text and send are only for prompt actions");
    checkTemplates(item.arguments, [...path, "arguments"]);
  } else {
    if (scope !== "block") invalid([...path, "scope"], "response actions require block scope");
    oneOf(item.response, ["submit", "cancel"], [...path, "response"]);
    if (item.arguments !== undefined || item.text !== undefined || item.send !== undefined || item.primary !== undefined || item.when !== undefined) invalid(path, "response actions do not accept execution arguments or item predicates");
  }
  if (item.primary !== undefined) {
    if (item.primary !== true) invalid([...path, "primary"], "must be true");
    if (scope !== "item") invalid([...path, "primary"], "is only for item actions");
  }
  if (item.confirm !== undefined) text(item.confirm, [...path, "confirm"], 200, 1);
  if (item.when !== undefined) {
    const when = object(item.when, [...path, "when"]);
    keys(when, ["status"], [...path, "when"]);
    for (const [index, entry] of array(when.status, [...path, "when", "status"], PANEL_ITEM_STATUSES.length, 1).entries()) {
      status(entry, [...path, "when", "status", index]);
    }
  }
  return item as unknown as PanelAction;
}

const warned = new Set<string>();
/** The default load-warning channel: Node's process warnings (stderr), once per distinct message. */
export function panelWarning(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(message, { code: "RAW_PANEL_DECLARATION" });
}

/** Validates one `panels[]` declaration. An unknown icon falls back to `panel` and calls `warn` (default: a process warning). */
export function validateDeclaration(value: unknown, where: string, warn: (message: string) => void = panelWarning): PanelDeclaration {
  const at: Path = [where];
  const item = object(value, at);
  keys(item, ["id", "title", "icon", "placement", "open", "context", "acp_plan", "actions"], at);
  id(item.id, PANEL_ID, [...at, "id"]);
  text(item.title, [...at, "title"], 40, 1);
  let icon: PanelDeclaration["icon"] = "panel";
  if (item.icon !== undefined) {
    if (typeof item.icon === "string" && (PANEL_ICONS as readonly string[]).includes(item.icon)) icon = item.icon as PanelDeclaration["icon"];
    else if (typeof item.icon === "string") warn(`${where}: unknown icon "${item.icon}" falls back to "panel"`);
    else invalid([...at, "icon"], "must be a string");
  }
  const open = item.open === undefined ? "never" : oneOf(item.open, ["never", "first_update"], [...at, "open"]);
  const context = item.context === undefined ? "none" : oneOf(item.context, ["none", "summary"], [...at, "context"]);
  const placement = item.placement === undefined ? "sidebar" : oneOf(item.placement, ["chat", "sidebar"], [...at, "placement"]);
  if (item.acp_plan !== undefined && typeof item.acp_plan !== "boolean") invalid([...at, "acp_plan"], "must be a boolean");
  const actions: PanelAction[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of array(item.actions ?? [], [...at, "actions"], PANEL_LIMITS.actionsPerPanel).entries()) {
    const checked = action(raw, [...at, "actions", index]);
    if (ids.has(checked.id)) invalid([...at, "actions", index, "id"], "duplicate action id");
    ids.add(checked.id);
    actions.push(checked);
  }
  if (actions.filter((entry) => entry.primary).length > 1) invalid([...at, "actions"], "at most one primary action");
  return { id: item.id as string, title: item.title as string, icon, placement, open, context, acp_plan: item.acp_plan === true, actions };
}
