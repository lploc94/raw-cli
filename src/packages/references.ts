import { componentKinds, type ComponentKind } from "./contract.js";

const segment = "[a-z][a-z0-9_-]*";
const kindPattern = `(${componentKinds.join("|")})`;
const own = new RegExp(`^#${kindPattern}/(${segment})$`);
const dependency = new RegExp(`^dep:(${segment})#${kindPattern}/(${segment})$`);
const installed = new RegExp(`^pkg/(${segment})/${kindPattern}/(${segment})$`);

export type ComponentReference =
  | { source: "self"; kind: ComponentKind; exportName: string }
  | { source: "dependency"; dependency: string; kind: ComponentKind; exportName: string }
  | { source: "installed"; alias: string; kind: ComponentKind; exportName: string };

export function parseComponentReference(value: string): ComponentReference {
  const ownMatch = own.exec(value);
  if (ownMatch) return { source: "self", kind: ownMatch[1] as ComponentKind, exportName: ownMatch[2]! };
  const dependencyMatch = dependency.exec(value);
  if (dependencyMatch) return { source: "dependency", dependency: dependencyMatch[1]!,
    kind: dependencyMatch[2] as ComponentKind, exportName: dependencyMatch[3]! };
  const installedMatch = installed.exec(value);
  if (installedMatch) return { source: "installed", alias: installedMatch[1]!,
    kind: installedMatch[2] as ComponentKind, exportName: installedMatch[3]! };
  throw new Error(`invalid package component reference: ${value}`);
}

export interface SelectionReference { ref: string; as?: string; inputs: Readonly<Record<string, unknown>> }

export function parseSelectionReference(value: unknown): SelectionReference {
  if (typeof value === "string") { parseComponentReference(value); return { ref: value, inputs: {} }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid selection reference");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["ref", "as", "inputs"].includes(key)) || typeof item.ref !== "string") {
    throw new Error("invalid selection reference");
  }
  parseComponentReference(item.ref);
  if (item.as !== undefined && (typeof item.as !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(item.as))) {
    throw new Error("invalid selection alias");
  }
  if (item.inputs !== undefined && (!item.inputs || typeof item.inputs !== "object" || Array.isArray(item.inputs))) {
    throw new Error("invalid selection inputs");
  }
  return { ref: item.ref, ...(item.as === undefined ? {} : { as: item.as }),
    inputs: item.inputs === undefined ? {} : structuredClone(item.inputs) as Record<string, unknown> };
}
