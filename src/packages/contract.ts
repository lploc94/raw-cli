export const componentKinds = ["agents", "skills", "tools", "hooks", "vars", "var_providers", "mcp"] as const;
export type ComponentKind = typeof componentKinds[number];

export interface PackageDependency {
  name: string;
  version: string;
  digest: string;
  archive: string;
}

export interface RawPackageManifest {
  schema_version: 1;
  name: string;
  version: string;
  description: string;
  files: readonly string[];
  exports: Partial<Record<ComponentKind, Readonly<Record<string, string>>>>;
  inputs?: Readonly<Record<string, unknown>>;
  requires?: readonly string[];
  dependencies?: Readonly<Record<string, PackageDependency>>;
  license?: string;
  repository?: string;
  keywords?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export const hostCapabilities = new Set(["raw.tool-api/1", "raw.var-provider/1", "raw.mcp/1", "raw.agent/1", "raw.skill/1", "raw.hook/1", "raw.panel/1"]);

export function packagePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes(":") || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid package path: ${value}`);
  }
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
