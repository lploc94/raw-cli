import { PanelError, type PanelDocument, type PanelUpdate } from "./contract.js";
import { invalid, validateDocument, validateUpdate } from "./validate.js";

type Obj = Record<string, unknown>;

/** Copies own data properties without invoking setters, so a JSON `__proto__` key stays an (invalid) field. */
function assignOwn(target: Obj, source: Obj): void {
  for (const [key, value] of Object.entries(source)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
export interface PanelState { document: PanelDocument; closed: boolean }

function findBlock(doc: Obj, blockId: unknown, path: (string | number)[]): Obj {
  const found = (doc.blocks as Obj[]).find((entry) => entry.id === blockId);
  if (!found) invalid(path, `unknown block "${String(blockId)}"`);
  return found;
}

function checklistIndex(items: Obj[], map: Map<string, { item: Obj; list: Obj[] }>): void {
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue; // malformed input is reported by the final validation
    map.set(String(item.id), { item, list: items });
    if (Array.isArray(item.children)) checklistIndex(item.children as Obj[], map);
  }
}

/** Merges `patches` into a private copy of `document` and returns the raw result, unvalidated. */
function applyPatches(document: PanelDocument, patches: readonly Obj[]): Obj {
  const doc = structuredClone(document) as unknown as Obj;
  for (const [index, patch] of patches.entries()) {
    const at = ["patches", index];
    switch (patch.op) {
      case "set":
        if (patch.value === null) delete doc[patch.field as string];
        else doc[patch.field as string] = structuredClone(patch.value);
        break;
      case "set_block": {
        const blocks = doc.blocks as Obj[];
        const next = structuredClone(patch.block) as Obj;
        const existing = blocks.findIndex((entry) => entry.id === next.id);
        if (existing >= 0) blocks[existing] = next;
        else if (patch.before === undefined) blocks.push(next);
        else {
          const before = blocks.findIndex((entry) => entry.id === patch.before);
          if (before < 0) invalid([...at, "before"], `unknown block "${String(patch.before)}"`);
          blocks.splice(before, 0, next);
        }
        break;
      }
      case "remove_block": {
        const blocks = doc.blocks as Obj[];
        const found = blocks.findIndex((entry) => entry.id === patch.id);
        if (found < 0) invalid([...at, "id"], `unknown block "${String(patch.id)}"`);
        blocks.splice(found, 1);
        break;
      }
      case "upsert_items": {
        const block = findBlock(doc, patch.block, [...at, "block"]);
        const items = structuredClone(patch.items) as Obj[];
        const keyField = block.kind === "key_value" ? "key" : block.kind === "files" ? "path" : "id";
        const listName = block.kind === "key_value" || block.kind === "files" ? "entries" : block.kind === "table" ? "rows" : "items";
        if (!["checklist", "steps", "table", "key_value", "files"].includes(block.kind as string)) {
          invalid([...at, "block"], `block "${String(block.id)}" (${String(block.kind)}) does not support upsert_items`);
        }
        if (patch.parent !== undefined && block.kind !== "checklist") invalid([...at, "parent"], "is only for checklist blocks");
        const list = block[listName] as Obj[];
        const map = new Map<string, { item: Obj; list: Obj[] }>();
        if (block.kind === "checklist") checklistIndex(list, map);
        else for (const entry of list) map.set(String(entry[keyField]), { item: entry, list });
        for (const [position, item] of items.entries()) {
          const key = item[keyField];
          if (typeof key !== "string") invalid([...at, "items", position, keyField], "is required");
          const current = map.get(key);
          if (current) {
            assignOwn(current.item, item);
            if (block.kind === "checklist") { map.clear(); checklistIndex(list, map); } // a replaced `children` list drops old descendants
            continue;
          }
          let target = list;
          if (patch.parent !== undefined) {
            const parent = map.get(String(patch.parent));
            if (!parent) invalid([...at, "parent"], `unknown item "${String(patch.parent)}"`);
            parent.item.children ??= [];
            if (!Array.isArray(parent.item.children)) invalid([...at, "parent"], `item "${String(patch.parent)}" has malformed children`);
            target = parent.item.children as Obj[];
          }
          target.push(item);
          map.set(key, { item, list: target });
          if (block.kind === "checklist" && Array.isArray(item.children)) checklistIndex(item.children as Obj[], map);
        }
        break;
      }
      case "remove_items": {
        const block = findBlock(doc, patch.block, [...at, "block"]);
        const selector = patch.ids !== undefined ? "ids" : patch.keys !== undefined ? "keys" : "paths";
        const expected = block.kind === "key_value" ? "keys" : block.kind === "files" ? "paths"
          : ["checklist", "steps", "table", "timeline"].includes(block.kind as string) ? "ids" : undefined;
        if (!expected) invalid([...at, "block"], `block "${String(block.id)}" (${String(block.kind)}) does not support remove_items`);
        if (selector !== expected) invalid([...at, selector], `${String(block.kind)} blocks take ${expected}`);
        const targets = patch[selector] as string[];
        const listName = block.kind === "key_value" || block.kind === "files" ? "entries" : block.kind === "table" ? "rows" : block.kind === "timeline" ? "events" : "items";
        const keyField = selector === "keys" ? "key" : selector === "paths" ? "path" : "id";
        for (const target of targets) {
          const remove = (list: Obj[]): boolean => {
            const found = list.findIndex((entry) => entry[keyField] === target);
            if (found >= 0) { list.splice(found, 1); return true; }
            return block.kind === "checklist" && list.some((entry) => Array.isArray(entry.children) && remove(entry.children as Obj[]));
          };
          if (!remove(block[listName] as Obj[])) invalid([...at, selector], `"${target}" does not exist in block "${String(block.id)}"`);
        }
        break;
      }
      case "append_events": {
        const block = findBlock(doc, patch.block, [...at, "block"]);
        if (block.kind !== "timeline") invalid([...at, "block"], `block "${String(block.id)}" is not a timeline`);
        const max = typeof block.max === "number" ? block.max : 100;
        block.events = [...(block.events as Obj[]), ...structuredClone(patch.events as Obj[])].slice(-max);
        break;
      }
    }
  }
  return doc;
}

/**
 * Applies one validated update to the current state. Nothing is mutated: a failing update throws and the
 * caller keeps its previous state. A `patch` keeps the panel's closed flag; only `replace` reopens it.
 */
export function applyUpdate(current: PanelState | undefined, input: unknown): PanelState {
  const update = validateUpdate(input) as PanelUpdate;
  if (update.op === "replace") return { document: validateDocument(structuredClone(update.document)), closed: false };
  if (!current) throw new PanelError("panel_unknown", `panel "${update.panel}" has no document yet`);
  if (update.op === "close") return { document: structuredClone(current.document), closed: true };
  let merged: Obj;
  try { merged = applyPatches(current.document, update.patches as unknown as Obj[]); }
  catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError("panel_invalid", "/patches: an item is malformed and could not be merged"); // e.g. a non-object entry inside a nested list
  }
  return { document: validateDocument(merged), closed: current.closed };
}
