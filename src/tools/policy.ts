import { RE2JS } from "re2js";
import type { ToolDefinition } from "./registry.js";

export type ConditionSource = "arguments" | "effects";
export interface ToolPolicyWhen { readonly source: ConditionSource; readonly any: string; readonly regex: string }

interface PathStep { readonly key: string; readonly each: boolean }

export interface CompiledWhen {
  readonly source: ConditionSource;
  readonly path: readonly PathStep[];
  readonly pattern: RE2JS;
}

export function compileWhen(when: ToolPolicyWhen): CompiledWhen {
  if (when.source !== "arguments" && when.source !== "effects") throw new Error("when.source must be arguments or effects");
  if (typeof when.any !== "string" || when.any.length > 256 || !when.any) throw new Error("when.any must be a bounded path");
  const parts = when.any.split(".");
  if (parts.length > 16) throw new Error("when.any path is too deep");
  const path = parts.map((part) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\[\*\])?$/.exec(part);
    if (!match) throw new Error(`invalid when.any path: ${when.any}`);
    return { key: match[1]!, each: match[2] !== undefined };
  });
  if (typeof when.regex !== "string" || !when.regex || Buffer.byteLength(when.regex) > 1024) {
    throw new Error("when.regex must be a nonempty pattern of at most 1024 bytes");
  }
  let pattern: RE2JS;
  try { pattern = RE2JS.compile(when.regex); }
  catch (error) { throw new Error(`invalid RE2 when.regex: ${(error as Error).message}`); }
  return { source: when.source, path, pattern };
}

function schemaObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function allowsType(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    const item = schemaObject(node);
    if (!item || !Object.hasOwn(item, key)) return undefined;
    node = item[key];
  }
  return node;
}

function canReachString(node: unknown, path: readonly PathStep[], index: number, arrayMode: boolean,
  root: Record<string, unknown>, active: WeakMap<object, Set<string>>, depth: number): boolean {
  const schema = schemaObject(node);
  if (!schema || depth > 128) return false;
  const key = `${index}:${arrayMode}`;
  const entered = active.get(schema) ?? new Set<string>();
  if (entered.has(key)) return false;
  entered.add(key);
  active.set(schema, entered);
  try {
    if (typeof schema.$ref === "string"
      && canReachString(resolveRef(root, schema.$ref), path, index, arrayMode, root, active, depth + 1)) return true;
    for (const group of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(schema[group])
        && schema[group].some((branch) => canReachString(branch, path, index, arrayMode, root, active, depth + 1))) return true;
    }
    if (arrayMode) {
      if (!allowsType(schema, "array") && !(schema.type === undefined && (schema.items !== undefined || schema.prefixItems !== undefined))) return false;
      const items = [schema.items, ...(Array.isArray(schema.prefixItems) ? schema.prefixItems : [])];
      return items.some((item) => canReachString(item, path, index, false, root, active, depth + 1));
    }
    if (index === path.length) return allowsType(schema, "string");
    if (!allowsType(schema, "object") && !(schema.type === undefined && schema.properties !== undefined)) return false;
    const step = path[index]!;
    const properties = schemaObject(schema.properties);
    const child = properties?.[step.key] ?? (schema.additionalProperties === true ? undefined : schema.additionalProperties);
    return child !== undefined && canReachString(child, path, index + 1, step.each, root, active, depth + 1);
  } finally {
    entered.delete(key);
  }
}

export function bindWhenToSchema(when: CompiledWhen, definition: ToolDefinition): void {
  if (!(definition.conditionSources ?? ["arguments"]).includes(when.source)) throw new Error(`when.source ${when.source} is unavailable in ${definition.name}`);
  const root = schemaObject(when.source === "effects" ? definition.effectsSchema : definition.inputSchema);
  if (!root) throw new Error(`when.source ${when.source} has no schema in ${definition.name}`);
  if (!canReachString(root, when.path, 0, false, root, new WeakMap(), 0)) {
    throw new Error(`when.any path does not resolve to a string in ${definition.name} schema`);
  }
}

export function matchesWhen(when: CompiledWhen, args: Record<string, unknown>, effects?: Record<string, unknown>): boolean {
  let values: unknown[] = [when.source === "effects" ? effects : args];
  for (const step of when.path) {
    const next: unknown[] = [];
    for (const value of values) {
      const item = schemaObject(value);
      if (!item || !Object.hasOwn(item, step.key)) continue;
      const selected = item[step.key];
      if (step.each) { if (Array.isArray(selected)) next.push(...selected); }
      else next.push(selected);
    }
    values = next;
    if (!values.length) return false;
  }
  return values.some((value) => typeof value === "string" && when.pattern.matcher(value).find());
}
