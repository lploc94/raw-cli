import type { PanelAction, PanelBlock, PanelDeclaration, PanelDocument, PanelItemStatus } from "./contract.js";

/** Why an action request cannot run. The dashboard maps every code to `422 invalid_action`. */
export class PanelActionError extends Error {
  constructor(message: string) { super(message); this.name = "PanelActionError"; }
}

export interface ActionRequest { action: string; block?: string | undefined; item?: string | undefined }
export interface ActionTarget { block?: PanelBlock; item?: { id: string; label: string; status?: PanelItemStatus | undefined } }

/** Finds an item by id inside a block that has items: checklist (whole tree), steps and table rows. */
export function findItem(block: PanelBlock, id: string): NonNullable<ActionTarget["item"]> | undefined {
  const walk = (items: readonly { id: string; label: string; status?: PanelItemStatus; children?: unknown[] }[]): NonNullable<ActionTarget["item"]> | undefined => {
    for (const item of items) {
      if (item.id === id) return { id: item.id, label: item.label, status: item.status };
      const inner = item.children?.length ? walk(item.children as never) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  if (block.kind === "checklist" || block.kind === "steps") return walk((block as unknown as { items: never[] }).items);
  if (block.kind === "table") {
    const table = block as Extract<PanelBlock, { kind: "table" }>;
    const row = table.rows.find((candidate) => candidate.id === id);
    const first = table.columns[0];
    return row ? { id: row.id, label: (first && row.cells[first.id]) || row.id, status: row.status } : undefined;
  }
  return undefined;
}

/** Replaces `{{panel.id}}`, `{{block.id}}`, `{{item.id}}` and `{{item.label}}` inside string values only (§11). */
function fill(value: unknown, values: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-z]+\.[a-z]+)\s*\}\}/g, (whole, key: string) => {
      const found = values[key];
      if (found === undefined) throw new PanelActionError(`template ${whole} cannot be resolved for this action`);
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => fill(entry, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry, values)]));
  return value;
}

export interface ResolvedAction { action: PanelAction; arguments?: Record<string, unknown>; text?: string }

/**
 * Checks a request against the declaration and the panel's current document and resolves its templates.
 * Scope, `blocks`, `when` and every template must hold, or the action is not available (§11).
 */
export function resolveAction(declaration: PanelDeclaration, request: ActionRequest, document: PanelDocument | null): ResolvedAction {
  const action = declaration.actions.find((candidate) => candidate.id === request.action);
  if (!action) throw new PanelActionError(`panel ${declaration.id} has no action "${request.action}"`);
  const target: ActionTarget = {};
  if (action.scope === "panel") {
    if (request.block !== undefined || request.item !== undefined) throw new PanelActionError("a panel action takes no block or item");
    if (action.when) throw new PanelActionError("this action is only offered for items with a status");
  } else {
    if (request.block === undefined) throw new PanelActionError(`action "${action.id}" needs a block`);
    if (action.blocks && !action.blocks.includes(request.block)) throw new PanelActionError(`action "${action.id}" does not apply to block "${request.block}"`);
    const block = document?.blocks.find((candidate) => candidate.id === request.block);
    if (!block) throw new PanelActionError(`block "${request.block}" does not exist in the panel`);
    target.block = block;
    if (action.scope === "block") {
      if (request.item !== undefined) throw new PanelActionError("a block action takes no item");
      if (action.when) throw new PanelActionError("this action is only offered for items with a status");
    } else {
      if (request.item === undefined) throw new PanelActionError(`action "${action.id}" needs an item`);
      const item = findItem(block, request.item);
      if (!item) throw new PanelActionError(`item "${request.item}" does not exist in block "${request.block}"`);
      target.item = item;
      if (action.when && !action.when.status.includes(item.status ?? "pending")) throw new PanelActionError(`action "${action.id}" is not available for an item with status ${item.status ?? "pending"}`);
    }
  }
  const values = { "panel.id": declaration.id, "block.id": target.block?.id, "item.id": target.item?.id, "item.label": target.item?.label };
  if (action.kind === "tool") return { action, arguments: fill(action.arguments ?? {}, values) as Record<string, unknown> };
  return { action, text: fill(action.text ?? "", values) as string };
}
