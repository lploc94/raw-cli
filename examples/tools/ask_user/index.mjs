// src/panels/contract.ts
var PANEL_LIMITS = {
  panelsPerTool: 4,
  actionsPerPanel: 8,
  panelsPerSession: 16,
  documentBytes: 64 * 1024,
  blocks: 20,
  items: 200,
  steps: 30,
  checklistDepth: 3,
  updatesPerCall: 200,
  receiptBytes: 1024,
  reminderBytes: 2 * 1024,
  reminderTotalBytes: 8 * 1024,
  markdownBytes: 16 * 1024,
  fallbackBytes: 4 * 1024,
  contextSummaryBytes: 2048
};
var PANEL_ITEM_STATUSES = ["pending", "in_progress", "done", "skipped", "blocked", "failed"];
var PANEL_STATUSES = ["idle", "active", "done", "failed"];
var PanelError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PanelError";
  }
  code;
};

// src/panels/validate.ts
var pointer = (path) => "/" + path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
function invalid(path, reason) {
  throw new PanelError("panel_invalid", `${pointer(path)}: ${reason}`);
}
var CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
var BLOCK_ID = /^[A-Za-z0-9_-]{1,32}$/;
var ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;
function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  return value;
}
function keys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid([...path, key], "unknown field");
}
function text(value, path, max, min = 0) {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (CONTROL.test(value)) invalid(path, "contains a control character");
  const count2 = value.length <= max ? value.length : [...value].length;
  if (count2 > max) invalid(path, `must be at most ${max} characters`);
  if (count2 < min) invalid(path, min === 1 ? "must not be empty" : `must be at least ${min} characters`);
  return value;
}
function bytesText(value, path, maxBytes) {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (CONTROL.test(value)) invalid(path, "contains a control character");
  if (Buffer.byteLength(value) > maxBytes) invalid(path, `must be at most ${maxBytes} bytes`);
  return value;
}
function oneOf(value, allowed, path) {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value;
}
function id(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) invalid(path, `must match ${pattern.source}`);
  return value;
}
function array(value, path, max, min = 0) {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length > max) invalid(path, `must have at most ${max} entries`);
  if (value.length < min) invalid(path, `must have at least ${min} entries`);
  return value;
}
function count(value, path, min = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(path, `must be an integer of at least ${min}`);
  return value;
}
function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(path, "must be a non-negative finite number");
  return value;
}
function ref(value, path) {
  const item = object(value, path);
  keys(item, ["path", "line"], path);
  text(item.path, [...path, "path"], 500, 1);
  if (item.line !== void 0) count(item.line, [...path, "line"], 1);
}
function status(value, path) {
  oneOf(value, PANEL_ITEM_STATUSES, path);
}
var COMMON = ["id", "kind", "title", "fallback"];
function checklist(items, path, depth, ids, total) {
  for (const [index, raw] of array(items, path, PANEL_LIMITS.items).entries()) {
    const at = [...path, index];
    const item = object(raw, at);
    keys(item, ["id", "label", "status", "priority", "note", "ref", "children"], at);
    const itemId = id(item.id, ITEM_ID, [...at, "id"]);
    if (ids.has(itemId)) invalid([...at, "id"], "duplicate item id");
    ids.add(itemId);
    if (++total.n > PANEL_LIMITS.items) invalid(path, `must hold at most ${PANEL_LIMITS.items} items including children`);
    text(item.label, [...at, "label"], 200, 1);
    if (item.status !== void 0) status(item.status, [...at, "status"]);
    if (item.priority !== void 0) oneOf(item.priority, ["high", "medium", "low"], [...at, "priority"]);
    if (item.note !== void 0) text(item.note, [...at, "note"], 500);
    if (item.ref !== void 0) ref(item.ref, [...at, "ref"]);
    if (item.children !== void 0) {
      const children = array(item.children, [...at, "children"], PANEL_LIMITS.items);
      if (children.length && depth >= PANEL_LIMITS.checklistDepth) invalid([...at, "children"], `nesting is at most ${PANEL_LIMITS.checklistDepth} levels`);
      checklist(children, [...at, "children"], depth + 1, ids, total);
    }
  }
}
function block(value, path) {
  const item = object(value, path);
  id(item.id, BLOCK_ID, [...path, "id"]);
  if (typeof item.kind !== "string" || !item.kind) invalid([...path, "kind"], "must be a string");
  if (CONTROL.test(item.kind)) invalid([...path, "kind"], "contains a control character");
  if (item.title !== void 0) text(item.title, [...path, "title"], 80);
  if (item.fallback !== void 0) bytesText(item.fallback, [...path, "fallback"], PANEL_LIMITS.fallbackBytes);
  const kind = item.kind;
  const own = (extra) => keys(item, [...COMMON, ...extra], path);
  switch (kind) {
    case "mermaid":
      own(["source"]);
      bytesText(item.source, [...path, "source"], 16 * 1024);
      if (!item.source) invalid([...path, "source"], "must not be empty");
      break;
    case "form": {
      own(["fields"]);
      const ids = /* @__PURE__ */ new Set();
      for (const [index, raw] of array(item.fields, [...path, "fields"], 8, 1).entries()) {
        const at = [...path, "fields", index];
        const field = object(raw, at);
        const fieldId = id(field.id, ITEM_ID, [...at, "id"]);
        if (ids.has(fieldId)) invalid([...at, "id"], "duplicate field id");
        ids.add(fieldId);
        text(field.label, [...at, "label"], 200, 1);
        if (field.description !== void 0) text(field.description, [...at, "description"], 500);
        if (field.required !== void 0 && typeof field.required !== "boolean") invalid([...at, "required"], "must be boolean");
        const fieldKind = oneOf(field.kind, ["text", "single_select", "multi_select"], [...at, "kind"]);
        const base = ["id", "label", "description", "required", "kind"];
        if (fieldKind === "text") {
          keys(field, [...base, "multiline", "max_bytes"], at);
          if (field.multiline !== void 0 && typeof field.multiline !== "boolean") invalid([...at, "multiline"], "must be boolean");
          if (field.max_bytes !== void 0 && count(field.max_bytes, [...at, "max_bytes"], 1) > 8192) invalid([...at, "max_bytes"], "must be at most 8192");
        } else {
          keys(field, [...base, "options", ...fieldKind === "multi_select" ? ["min_selected", "max_selected"] : []], at);
          const options = array(field.options, [...at, "options"], 32, 1);
          const optionIds = /* @__PURE__ */ new Set();
          for (const [index2, raw2] of options.entries()) {
            const loc = [...at, "options", index2];
            const option = object(raw2, loc);
            keys(option, ["id", "label"], loc);
            const optionId = id(option.id, ITEM_ID, [...loc, "id"]);
            if (optionIds.has(optionId)) invalid([...loc, "id"], "duplicate option id");
            optionIds.add(optionId);
            text(option.label, [...loc, "label"], 200, 1);
          }
          if (fieldKind === "multi_select") {
            const min = field.min_selected === void 0 ? 0 : count(field.min_selected, [...at, "min_selected"]);
            const max = field.max_selected === void 0 ? options.length : count(field.max_selected, [...at, "max_selected"], 1);
            if (min > max || max > options.length) invalid(at, "invalid selection limits");
          }
        }
      }
      break;
    }
    case "checklist": {
      own(["items"]);
      checklist(item.items, [...path, "items"], 1, /* @__PURE__ */ new Set(), { n: 0 });
      break;
    }
    case "steps": {
      own(["items"]);
      const ids = /* @__PURE__ */ new Set();
      for (const [index, raw] of array(item.items, [...path, "items"], PANEL_LIMITS.steps).entries()) {
        const at = [...path, "items", index];
        const step = object(raw, at);
        keys(step, ["id", "label", "status", "detail", "started_at", "ended_at"], at);
        const stepId = id(step.id, ITEM_ID, [...at, "id"]);
        if (ids.has(stepId)) invalid([...at, "id"], "duplicate item id");
        ids.add(stepId);
        text(step.label, [...at, "label"], 200, 1);
        if (step.status !== void 0) status(step.status, [...at, "status"]);
        if (step.detail !== void 0) text(step.detail, [...at, "detail"], 200);
        if (step.started_at !== void 0) count(step.started_at, [...at, "started_at"]);
        if (step.ended_at !== void 0) count(step.ended_at, [...at, "ended_at"]);
      }
      break;
    }
    case "progress": {
      own(["label", "value", "max", "indeterminate"]);
      if (item.label !== void 0) text(item.label, [...path, "label"], 200);
      if (item.indeterminate !== void 0) {
        if (item.indeterminate !== true) invalid([...path, "indeterminate"], "must be true");
        if (item.value !== void 0 || item.max !== void 0) invalid(path, "indeterminate excludes value and max");
      } else {
        const value2 = finite(item.value, [...path, "value"]);
        const max = finite(item.max, [...path, "max"]);
        if (max <= 0) invalid([...path, "max"], "must be greater than 0");
        if (value2 > max) invalid([...path, "value"], "must not exceed max");
      }
      break;
    }
    case "key_value": {
      own(["entries"]);
      const seen = /* @__PURE__ */ new Set();
      for (const [index, raw] of array(item.entries, [...path, "entries"], 50).entries()) {
        const at = [...path, "entries", index];
        const entry = object(raw, at);
        keys(entry, ["key", "value", "ref"], at);
        const key = text(entry.key, [...at, "key"], 60, 1);
        if (seen.has(key)) invalid([...at, "key"], "duplicate key");
        seen.add(key);
        text(entry.value, [...at, "value"], 500);
        if (entry.ref !== void 0) ref(entry.ref, [...at, "ref"]);
      }
      break;
    }
    case "table": {
      own(["columns", "rows"]);
      const columns = /* @__PURE__ */ new Set();
      for (const [index, raw] of array(item.columns, [...path, "columns"], 8, 1).entries()) {
        const at = [...path, "columns", index];
        const column = object(raw, at);
        keys(column, ["id", "label", "align"], at);
        const columnId = id(column.id, ITEM_ID, [...at, "id"]);
        if (columns.has(columnId)) invalid([...at, "id"], "duplicate column id");
        columns.add(columnId);
        text(column.label, [...at, "label"], 60);
        if (column.align !== void 0) oneOf(column.align, ["start", "end", "center"], [...at, "align"]);
      }
      const ids = /* @__PURE__ */ new Set();
      for (const [index, raw] of array(item.rows, [...path, "rows"], PANEL_LIMITS.items).entries()) {
        const at = [...path, "rows", index];
        const row = object(raw, at);
        keys(row, ["id", "status", "cells", "ref"], at);
        const rowId = id(row.id, ITEM_ID, [...at, "id"]);
        if (ids.has(rowId)) invalid([...at, "id"], "duplicate item id");
        ids.add(rowId);
        if (row.status !== void 0) status(row.status, [...at, "status"]);
        if (row.ref !== void 0) ref(row.ref, [...at, "ref"]);
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
      const max = item.max === void 0 ? 100 : count(item.max, [...path, "max"], 1);
      if (max > 200) invalid([...path, "max"], "must be at most 200");
      const ids = /* @__PURE__ */ new Set();
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
        if (event.detail !== void 0) text(event.detail, [...at, "detail"], 1e3);
      }
      break;
    }
    case "files": {
      own(["entries"]);
      const seen = /* @__PURE__ */ new Set();
      for (const [index, raw] of array(item.entries, [...path, "entries"], PANEL_LIMITS.items).entries()) {
        const at = [...path, "entries", index];
        const entry = object(raw, at);
        keys(entry, ["path", "status", "line", "label"], at);
        const filePath = text(entry.path, [...at, "path"], 500, 1);
        if (seen.has(filePath)) invalid([...at, "path"], "duplicate path");
        seen.add(filePath);
        if (entry.status !== void 0) oneOf(entry.status, ["added", "modified", "deleted", "referenced"], [...at, "status"]);
        if (entry.line !== void 0) count(entry.line, [...at, "line"], 1);
        if (entry.label !== void 0) text(entry.label, [...at, "label"], 200);
      }
      break;
    }
    default: {
      try {
        JSON.stringify(item);
      } catch {
        invalid(path, "is not serializable");
      }
    }
  }
  return item;
}
function validateDocument(value) {
  const doc = object(value, []);
  keys(doc, ["title", "subtitle", "status", "progress", "summary", "context_summary", "blocks"], []);
  if (doc.title !== void 0) text(doc.title, ["title"], 80);
  if (doc.subtitle !== void 0) text(doc.subtitle, ["subtitle"], 120);
  if (doc.status !== void 0) oneOf(doc.status, PANEL_STATUSES, ["status"]);
  if (doc.summary !== void 0) text(doc.summary, ["summary"], 120);
  if (doc.context_summary !== void 0) bytesText(doc.context_summary, ["context_summary"], PANEL_LIMITS.contextSummaryBytes);
  if (doc.progress !== void 0) {
    const progress = object(doc.progress, ["progress"]);
    keys(progress, ["done", "total"], ["progress"]);
    const done = count(progress.done, ["progress", "done"]);
    const total = count(progress.total, ["progress", "total"]);
    if (done > total) invalid(["progress", "done"], "must not exceed total");
  }
  const seen = /* @__PURE__ */ new Set();
  for (const [index, raw] of array(doc.blocks, ["blocks"], PANEL_LIMITS.blocks).entries()) {
    const checked = block(raw, ["blocks", index]);
    if (seen.has(checked.id)) invalid(["blocks", index, "id"], "duplicate block id");
    seen.add(checked.id);
  }
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(doc));
  } catch {
    invalid([], "is not serializable");
  }
  if (size > PANEL_LIMITS.documentBytes) throw new PanelError("panel_too_large", `document is ${size} bytes; the limit is ${PANEL_LIMITS.documentBytes}`);
  return doc;
}

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/results.ts
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/tools/bundled/ask_user/index.ts
function documentFor(args) {
  const fields = [];
  for (const question of args.questions) {
    const { free_text, ...field } = question;
    fields.push({ ...field, required: field.required ?? true });
    if (free_text) {
      if (field.kind === "text") throw new Error("free_text is only supported on choice questions");
      fields.push({ ...free_text, kind: "text", required: false });
    }
  }
  return { ...args.title !== void 0 ? { title: args.title } : {}, blocks: [{ id: "form", kind: "form", fields }] };
}
function validateArgs(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object";
    if (Object.keys(raw).some((key) => !["questions", "title", "timeout_ms"].includes(key))) return "unknown argument";
    const args = raw;
    if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) return "questions must contain 1\u20133 entries";
    if (args.timeout_ms !== void 0 && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 864e5)) return "timeout_ms must be positive and at most 24 hours";
    validateDocument(documentFor(args));
    return void 0;
  } catch (error) {
    return error.message;
  }
}
async function handler(raw, context) {
  const invalid2 = validateArgs(raw);
  if (invalid2) return errorResult("invalid_arguments", invalid2);
  if (!context.interactions) return errorResult("interaction_unavailable", "This host has no response adapter");
  const args = raw;
  try {
    const result = await context.interactions.request({
      panel: "questions",
      document: documentFor(args),
      ...args.timeout_ms !== void 0 ? { timeout_ms: args.timeout_ms } : {}
    });
    return {
      isError: result.status !== "answered",
      ...result.status !== "answered" ? { code: `interaction_${result.status}` } : {},
      content: [{ type: "json", value: result }]
    };
  } catch (error) {
    const failure = error;
    return errorResult(failure.code?.startsWith("interaction_") ? failure.code : "interaction_error", failure.message);
  }
}
export {
  handler,
  validateArgs
};
