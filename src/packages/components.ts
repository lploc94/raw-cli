import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { deepFreeze, hostCapabilities, type ComponentKind } from "./contract.js";
import type { LoadedPackageManifest } from "./manifest.js";
import { parseComponentReference } from "./references.js";
import { parseSkillMarkdown } from "../skills/frontmatter.js";

export interface ComponentContext {
  self?: LoadedPackageManifest;
  dependencies?: ReadonlyMap<string, LoadedPackageManifest>;
  installed?: ReadonlyMap<string, LoadedPackageManifest>;
  hostCapabilities?: ReadonlySet<string>;
}

export interface ResolvedComponent {
  kind: ComponentKind;
  exportName: string;
  path: string;
  root: string;
  canonicalIdentity: string;
  packageName: string;
}

export function resolveComponent(reference: string, context: ComponentContext): ResolvedComponent {
  const parsed = parseComponentReference(reference);
  const owned = parsed.source === "self" ? context.self
    : parsed.source === "dependency" ? context.dependencies?.get(parsed.dependency)
      : context.installed?.get(parsed.alias);
  if (!owned) throw new Error(`unresolved package component reference: ${reference}`);
  if (parsed.source === "dependency" && !context.self?.manifest.dependencies?.[parsed.dependency]) {
    throw new Error(`undeclared package dependency: ${parsed.dependency}`);
  }
  const path = owned.manifest.exports[parsed.kind]?.[parsed.exportName];
  if (!path) throw new Error(`unknown package export: ${reference}`);
  for (const requirement of owned.manifest.requires ?? []) {
    if (!(context.hostCapabilities ?? hostCapabilities).has(requirement)) {
      throw new Error(`${reference} requires unsupported host capability ${requirement}`);
    }
  }
  return deepFreeze({ kind: parsed.kind, exportName: parsed.exportName, path,
    root: owned.root, packageName: owned.manifest.name,
    canonicalIdentity: `${owned.manifest.name}#${parsed.kind}/${parsed.exportName}` });
}

export function assertDependencyGraph(nodes: ReadonlyMap<string, { name: string; dependencies?: Readonly<Record<string, string>> }>): void {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error(`package dependency cycle at ${key}`);
    if (done.has(key)) return;
    const node = nodes.get(key);
    if (!node) throw new Error(`missing package dependency: ${key}`);
    visiting.add(key);
    for (const target of Object.values(node.dependencies ?? {})) visit(target);
    visiting.delete(key); done.add(key);
  };
  for (const key of nodes.keys()) visit(key);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function fingerprintComponent(pkg: LoadedPackageManifest, kind: ComponentKind, name: string): Promise<string> {
  const path = pkg.manifest.exports[kind]?.[name];
  if (!path) throw new Error(`unknown package export: ${kind}/${name}`);
  const files = pkg.files.filter((file) => file === path || file.startsWith(`${path}/`));
  if (!files.length) throw new Error(`uncovered package export: ${kind}/${name}`);
  const hash = createHash("sha256");
  for (const file of files) {
    const local = file === path ? "." : file.slice(path.length + 1);
    const bytes = await readFile(join(pkg.root, file));
    const mode = (await stat(join(pkg.root, file))).mode & 0o111;
    let content: Buffer | string = bytes;
    if (kind === "tools" && file.endsWith("/tool.json")) {
      const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      delete manifest.version;
      content = canonical(manifest);
    } else if (kind === "skills" && file.endsWith("/SKILL.md")) {
      const folder = path.split("/").at(-1)!;
      const skill = parseSkillMarkdown(bytes.toString("utf8"), folder, file);
      content = canonical({ name: skill.name, description: skill.description, markdown: skill.markdown });
    }
    hash.update(local).update("\0").update(String(mode)).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}
