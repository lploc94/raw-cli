import { stat } from "node:fs/promises";
import { componentKinds, type ComponentKind, type RawPackageManifest } from "./contract.js";
import { loadPackageManifest } from "./manifest.js";
import { validatePackageArchive } from "./archive.js";

export interface PackageReport {
  name: string;
  version: string;
  exports: Record<ComponentKind, string[]>;
  files: readonly string[];
  inputs: readonly string[];
  requires: readonly string[];
  prerequisites: readonly string[];
}

function report(manifest: RawPackageManifest, files: readonly string[]): PackageReport {
  const entries = Object.fromEntries(componentKinds.map((kind) => [kind, Object.keys(manifest.exports[kind] ?? {}).sort()])) as Record<ComponentKind, string[]>;
  return { name: manifest.name, version: manifest.version, exports: entries,
    files, inputs: Object.keys((manifest.inputs as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}).sort(),
    requires: manifest.requires ?? [],
    prerequisites: Array.isArray(manifest.metadata?.external_executables)
      ? manifest.metadata.external_executables.filter((item): item is string => typeof item === "string") : [] };
}

export async function inspectPackage(path: string): Promise<PackageReport> {
  if ((await stat(path)).isFile()) {
    const archive = await validatePackageArchive(path);
    return report(archive.manifest, archive.files);
  }
  const loaded = await loadPackageManifest(path);
  return report(loaded.manifest, ["raw-package.json", ...loaded.files.filter((file) => file !== "raw-package.json")].sort());
}

export async function validatePackage(path: string): Promise<PackageReport> { return inspectPackage(path); }
