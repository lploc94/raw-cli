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

// src/panels/render.ts
var GLYPH = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  skipped: "[-]",
  blocked: "[!]",
  failed: "[\u2717]"
};
var statusGlyph = (status) => GLYPH[status ?? "pending"];
var isDone = (status) => status === "done" || status === "skipped";
function leaves(items) {
  return items.flatMap((item) => item.children?.length ? leaves(item.children) : [item]);
}
function derivedProgress(doc) {
  if (doc.progress) return doc.progress;
  const checklists = doc.blocks.filter((block) => block.kind === "checklist");
  const source = checklists.length ? checklists : doc.blocks.filter((block) => block.kind === "steps");
  if (!source.length) return void 0;
  const items = checklists.length ? checklists.flatMap((block) => leaves(block.items)) : source.flatMap((block) => block.items);
  return { done: items.filter((item) => isDone(item.status)).length, total: items.length };
}
function truncateBytes(value, max) {
  if (Buffer.byteLength(value) <= max) return value;
  let out = "";
  for (const char of value) {
    if (Buffer.byteLength(out + char) > max - 3) break;
    out += char;
  }
  return `${out}\u2026`;
}

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/results.ts
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/tools/bundled/todo/index.ts
var MAX_ITEMS = 100;
var finished = (status) => status === "done" || status === "skipped";
var invalid = (message) => errorResult("invalid_todo", message);
function validateArgs(args) {
  const { mode = "replace", todos, clear } = args;
  if (mode === "replace" && clear !== void 0) return "clear is only allowed in merge mode";
  const ids = /* @__PURE__ */ new Set();
  const byId = /* @__PURE__ */ new Map();
  let active = 0;
  for (const [index, item] of todos.entries()) {
    const at = `todos[${index}]`;
    if (mode === "replace") {
      if (item.content === void 0 || item.status === void 0) return `${at}: content and status are required in replace mode`;
      if (item.remove !== void 0) return `${at}: remove is only allowed in merge mode`;
    } else {
      if (item.id === void 0) return `${at}: id is required in merge mode`;
    }
    if (item.id !== void 0) {
      if (ids.has(item.id)) return `${at}: duplicate id "${item.id}"`;
      ids.add(item.id);
      byId.set(item.id, item);
    }
    if (item.status === "in_progress" && ++active > 1) return `${at}: at most one item may be in_progress`;
  }
  for (const [index, item] of todos.entries()) {
    if (item.parent !== void 0 && byId.get(item.parent)?.parent !== void 0) {
      return `todos[${index}]: parent "${item.parent}" is itself a subtask; nesting is limited to two levels`;
    }
  }
  return void 0;
}
function fromDocument(document) {
  const block = document?.blocks.find((entry) => entry.id === "items" && entry.kind === "checklist");
  const items = [];
  for (const top of block?.items ?? []) {
    items.push(toTodo(top));
    for (const child of top.children ?? []) items.push(toTodo(child, top.id));
  }
  return { items, ...document?.title !== void 0 ? { title: document.title } : {} };
}
function toTodo(item, parent) {
  return {
    id: item.id,
    content: item.label,
    status: item.status ?? "pending",
    ...parent !== void 0 ? { parent } : {},
    ...item.note !== void 0 ? { note: item.note } : {}
  };
}
function checkState(items, capacity = true) {
  if (capacity && items.length > MAX_ITEMS) return `item "${items[MAX_ITEMS].id}": the list would hold ${items.length} items; the limit is ${MAX_ITEMS}`;
  const byId = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (byId.has(item.id)) return `item "${item.id}": duplicate id`;
    byId.set(item.id, item);
  }
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    return `item "${items.filter((item) => item.status === "in_progress")[1].id}": at most one item may be in_progress`;
  }
  for (const item of items) {
    if (item.parent === void 0) continue;
    const parent = byId.get(item.parent);
    if (!parent) return `item "${item.id}": parent "${item.parent}" does not exist`;
    if (parent.parent !== void 0) return `item "${item.id}": parent "${item.parent}" is itself a subtask; nesting is limited to two levels`;
  }
  for (const item of items) {
    if (!finished(item.status)) continue;
    const open = items.find((child) => child.parent === item.id && !finished(child.status));
    if (open) return `item "${item.id}" cannot be ${item.status} while its subtask "${open.id}" is ${open.status}; finish or skip the subtask first`;
  }
  return void 0;
}
function generateIds(input) {
  const used = new Set(input.flatMap((item) => item.id === void 0 ? [] : [item.id]));
  let next = 1;
  return input.map((item) => {
    let id = item.id;
    if (id === void 0) {
      while (used.has(`t${next}`)) next++;
      id = `t${next}`;
      used.add(id);
    }
    return {
      id,
      content: item.content,
      status: item.status,
      ...item.parent !== void 0 ? { parent: item.parent } : {},
      ...item.note ? { note: item.note } : {}
    };
  });
}
function merge(current, input) {
  let items = current.map((item) => ({ ...item }));
  for (const change of input) {
    const id = change.id;
    const index = items.findIndex((item) => item.id === id);
    if (change.remove) {
      if (index < 0) return { error: `item "${id}": cannot remove an item that does not exist` };
      items = items.filter((item) => item.id !== id && item.parent !== id);
    } else if (index >= 0) {
      const target = items[index];
      if (change.content !== void 0) target.content = change.content;
      if (change.status !== void 0) target.status = change.status;
      if (change.parent !== void 0) target.parent = change.parent;
      if (change.note !== void 0) {
        if (change.note) target.note = change.note;
        else delete target.note;
      }
    } else {
      if (change.content === void 0) return { error: `item "${id}": unknown id; adding an item needs content` };
      items.push({
        id,
        content: change.content,
        status: change.status ?? "pending",
        ...change.parent !== void 0 ? { parent: change.parent } : {},
        ...change.note ? { note: change.note } : {}
      });
    }
  }
  return { items };
}
function toChecklist(items) {
  const node = (item) => ({ id: item.id, label: item.content, status: item.status, ...item.note ? { note: item.note } : {} });
  return items.filter((item) => item.parent === void 0).map((top) => {
    const children = items.filter((item) => item.parent === top.id).map(node);
    return { ...node(top), ...children.length ? { children } : {} };
  });
}
function lines(items) {
  const row = (item, depth) => `${"  ".repeat(depth)}${statusGlyph(item.status)} ${item.id} ${item.content}${item.note ? ` \u2014 ${item.note}` : ""}`;
  return items.filter((item) => item.parent === void 0).flatMap((top) => [row(top, 0), ...items.filter((item) => item.parent === top.id).map((child) => row(child, 1))]);
}
async function handler(args, context) {
  if (!context.panels) return errorResult("panels_unavailable", "this host does not provide panels");
  const { mode = "replace", title, todos, clear } = args;
  const before = fromDocument(context.panels.get("todo")?.document);
  let items;
  if (mode === "replace") items = generateIds(todos);
  else {
    const merged = merge(before.items, todos);
    if ("error" in merged) return invalid(merged.error);
    items = merged.items;
  }
  let problem = checkState(items, clear !== "done");
  if (problem) return invalid(problem);
  if (clear === "done") {
    const removed = new Set(items.filter((item) => finished(item.status)).map((item) => item.id));
    items = items.filter((item) => !removed.has(item.id) && !(item.parent !== void 0 && removed.has(item.parent)));
    problem = checkState(items);
    if (problem) return invalid(problem);
  }
  const listTitle = title ?? before.title;
  const checklist = toChecklist(items);
  const document = {
    ...listTitle !== void 0 ? { title: listTitle } : {},
    status: items.length === 0 ? "idle" : items.every((item) => finished(item.status)) ? "done" : "active",
    blocks: [{ id: "items", kind: "checklist", items: checklist }]
  };
  const progress = derivedProgress(document);
  const header = progress && progress.total ? `${progress.done}/${progress.total} done` : "empty";
  document.context_summary = truncateBytes([header, ...lines(items)].join("\n"), PANEL_LIMITS.contextSummaryBytes);
  const text = [`Todo (${header}):`, ...lines(items)].join("\n");
  return { isError: false, content: [{ type: "text", text }, { type: "panel", panel: "todo", op: "replace", document }] };
}
export {
  handler,
  validateArgs
};
