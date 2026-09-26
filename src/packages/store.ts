import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packPackage, unpackPackage, validatePackageArchive } from "./archive.js";
import { loadPackageManifest, type LoadedPackageManifest } from "./manifest.js";
import { withPackageWriteLock } from "./lock.js";
import type { RawPackageManifest, ComponentKind } from "./contract.js";
import { applyPackageInputs, parseInputSchema } from "./inputs.js";

export interface PackageStoreOptions { configPath: string; dataHome?: string; env?: NodeJS.ProcessEnv }
export interface PackageEntry {
  digest: string | null;
  name: string;
  version: string;
  source: { kind: "directory" | "archive" | "link"; path: string };
  dependencies: Readonly<Record<string, string>>;
}
interface PackageIndex { schema_version: 1; installations: Record<string, PackageEntry> }
export interface InstallPackageOptions extends PackageStoreOptions {
  source: string;
  alias: string;
  faultAt?: "after-stage" | "before-index-commit";
}
export interface PackageAliasOptions extends PackageStoreOptions { alias: string }
export interface ForkPackageOptions extends PackageAliasOptions { out: string }

const aliasPattern = /^[a-z][a-z0-9_-]*$/;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const emptyIndex = (): PackageIndex => ({ schema_version: 1, installations: Object.create(null) });
const indexPath = (options: PackageStoreOptions) => `${resolve(options.configPath)}.packages.lock.json`;
const dataRoot = (options: PackageStoreOptions) => join(options.dataHome
  ?? (options.env ?? process.env).XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "raw", "packages", "sha256");

function checkedAlias(alias: string): void { if (!aliasPattern.test(alias)) throw new Error(`invalid package alias: ${alias}`); }

function readIndex(options: PackageStoreOptions): PackageIndex {
  const path = indexPath(options);
  if (!existsSync(path)) return emptyIndex();
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`invalid package lock: ${path}`); }
  if (!parsed || typeof parsed !== "object" || (parsed as PackageIndex).schema_version !== 1
    || !(parsed as PackageIndex).installations || typeof (parsed as PackageIndex).installations !== "object") {
    throw new Error(`invalid package lock: ${path}`);
  }
  return parsed as PackageIndex;
}

async function writeIndex(options: PackageStoreOptions, index: PackageIndex): Promise<void> {
  const target = indexPath(options);
  await mkdir(dirname(target), { recursive: true });
  const staged = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(staged, JSON.stringify(index, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(staged, target);
  } catch (error) { await rm(staged, { force: true }); throw error; }
}

async function publishArchive(archive: string, options: PackageStoreOptions, depth = 0,
  faultAt?: InstallPackageOptions["faultAt"]): Promise<{
  digest: string; root: string; manifest: RawPackageManifest;
}> {
  if (depth > 4) throw new Error("package dependency nesting exceeds limit");
  const report = await validatePackageArchive(archive);
  const bytes = await readFile(archive);
  const hash = digest(bytes);
  const target = join(dataRoot(options), hash);
  await mkdir(dataRoot(options), { recursive: true });
  if (!existsSync(target)) {
    const stage = join(dataRoot(options), `.stage-${randomUUID()}`);
    try {
      await mkdir(stage, { recursive: true });
      await unpackPackage(archive, join(stage, "content"));
      if (faultAt === "after-stage") throw new Error("injected package fault after stage");
      await writeFile(join(stage, "artifact.rawpkg"), bytes, { flag: "wx" });
      try { await rename(stage, target); }
      catch (error) {
        if (!existsSync(target)) throw error;
        await rm(stage, { recursive: true, force: true });
      }
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  }
  const stored = await readFile(join(target, "artifact.rawpkg"));
  if (digest(stored) !== hash) throw new Error(`corrupt installed artifact: ${hash}`);
  const root = join(target, "content");
  for (const dependency of Object.values(report.manifest.dependencies ?? {})) {
    const child = await publishArchive(join(root, dependency.archive), options, depth + 1);
    if (child.digest !== dependency.digest || child.manifest.name !== dependency.name || child.manifest.version !== dependency.version) {
      throw new Error(`installed dependency identity mismatch: ${dependency.name}`);
    }
  }
  return { digest: hash, root, manifest: report.manifest };
}

async function prepareSource(options: InstallPackageOptions): Promise<{
  published: Awaited<ReturnType<typeof publishArchive>>;
  source: PackageEntry["source"];
}> {
  const sourcePath = resolve(options.source);
  const info = await stat(sourcePath);
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "archive" : undefined;
  if (!kind) throw new Error(`invalid package source: ${sourcePath}`);
  let archive = sourcePath;
  if (kind === "directory") {
    await mkdir(dataRoot(options), { recursive: true });
    archive = join(dataRoot(options), `.source-${randomUUID()}.rawpkg`);
    await packPackage(sourcePath, archive);
  }
  try {
    return { published: await publishArchive(archive, options, 0, options.faultAt), source: { kind, path: sourcePath } };
  } finally { if (kind === "directory") await rm(archive, { force: true }); }
}

function entry(published: Awaited<ReturnType<typeof publishArchive>>, source: PackageEntry["source"]): PackageEntry {
  return { digest: published.digest, name: published.manifest.name, version: published.manifest.version, source,
    dependencies: Object.fromEntries(Object.entries(published.manifest.dependencies ?? {}).map(([alias, item]) => [alias, item.digest])) };
}

export function listInstalledPackages(options: PackageStoreOptions): Readonly<Record<string, PackageEntry>> {
  return structuredClone(readIndex(options).installations);
}

export async function installPackage(options: InstallPackageOptions): Promise<PackageEntry> {
  checkedAlias(options.alias);
  const prepared = await prepareSource(options);
  return withPackageWriteLock(indexPath(options), async () => {
    const index = readIndex(options);
    const previous = index.installations[options.alias];
    if (previous) {
      if (previous.digest === prepared.published.digest) return previous;
      throw new Error(`package alias collision: ${options.alias}; use update`);
    }
    const next = entry(prepared.published, prepared.source);
    index.installations[options.alias] = next;
    if (options.faultAt === "before-index-commit") throw new Error("injected package fault before index commit");
    await writeIndex(options, index);
    return next;
  });
}

function configReferences(options: PackageStoreOptions, alias: string): string[] {
  let document: unknown;
  try { document = JSON.parse(readFileSync(resolve(options.configPath), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!document || typeof document !== "object") return [];
  const root = document as Record<string, unknown>;
  const found: string[] = [];
  const add = (value: unknown, path: string): void => {
    if (typeof value === "string" && value.startsWith(`pkg/${alias}/`)) found.push(`${path}: ${value}`);
  };
  const selections = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => add(typeof item === "string" ? item : (item as { ref?: unknown } | undefined)?.ref, `${path}[${index}]`));
  };
  for (const [name, raw] of Object.entries((root.agents ?? {}) as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const agent = raw as { from?: unknown; tools?: { use?: unknown }; skills?: { use?: unknown }; vars?: unknown };
    add(agent.from, `agents.${name}.from`);
    selections(agent.tools?.use, `agents.${name}.tools.use`);
    selections(agent.skills?.use, `agents.${name}.skills.use`);
    selections(agent.vars, `agents.${name}.vars`);
  }
  for (const key of ["vars", "var_providers"] as const) {
    for (const [name, raw] of Object.entries((root[key] ?? {}) as Record<string, unknown>)) {
      add((raw as { from?: unknown } | undefined)?.from, `${key}.${name}.from`);
    }
  }
  const servers = ((root.mcp as { servers?: Record<string, unknown> } | undefined)?.servers ?? {});
  for (const [name, raw] of Object.entries(servers)) add((raw as { from?: unknown } | undefined)?.from, `mcp.servers.${name}.from`);
  return found;
}

async function validateAffectedBindings(options: PackageStoreOptions, alias: string, manifest: RawPackageManifest,
  packageRoot: string): Promise<void> {
  for (const reference of configReferences(options, alias)) {
    const match = /pkg\/[a-z][a-z0-9_-]*\/(agents|skills|tools|vars|var_providers|mcp)\/([a-z][a-z0-9_-]*)$/.exec(reference);
    if (!match || !manifest.exports[match[1] as ComponentKind]?.[match[2]!]) {
      throw new Error(`package update would break current binding ${reference}`);
    }
  }
  let document: { agents?: Record<string, { from?: string; inputs?: Record<string, unknown> }> };
  try { document = JSON.parse(readFileSync(resolve(options.configPath), "utf8")) as typeof document; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const [name, binding] of Object.entries(document.agents ?? {})) {
    const match = new RegExp(`^pkg/${alias}/agents/([a-z][a-z0-9_-]*)$`).exec(binding.from ?? "");
    if (!match) continue;
    const path = manifest.exports.agents?.[match[1]!];
    if (!path) continue;
    const agent = JSON.parse(await readFile(join(packageRoot, path), "utf8")) as {
      vars?: unknown; tools?: { use?: unknown };
    };
    const definitions: unknown[] = [agent];
    if (Array.isArray(agent.vars)) for (const reference of agent.vars) {
      if (typeof reference !== "string") continue;
      const varName = /^#vars\/([a-z][a-z0-9_-]*)$/.exec(reference)?.[1];
      const varPath = varName ? manifest.exports.vars?.[varName] : undefined;
      if (!varPath) continue;
      const variable = JSON.parse(await readFile(join(packageRoot, varPath), "utf8")) as { source?: { name?: unknown } };
      definitions.push(variable);
      const providerName = typeof variable.source?.name === "string" ? variable.source.name : undefined;
      const providerPath = providerName ? manifest.exports.var_providers?.[providerName] : undefined;
      if (providerPath) definitions.push(JSON.parse(await readFile(join(packageRoot, providerPath), "utf8")));
    }
    if (Array.isArray(agent.tools?.use)) for (const item of agent.tools.use) {
      if (typeof item !== "string") continue;
      const server = /^mcp\/([a-z][a-z0-9_-]*)\//.exec(item)?.[1];
      const serverPath = server ? manifest.exports.mcp?.[server] : undefined;
      if (serverPath) definitions.push(JSON.parse(await readFile(join(packageRoot, serverPath), "utf8")));
    }
    const used = new Set<string>();
    const scan = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(scan); return; }
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 1 && typeof record.$input === "string") { used.add(record.$input); return; }
      Object.values(record).forEach(scan);
    };
    definitions.forEach(scan);
    if (!used.size) continue;
    const full = parseInputSchema(manifest.inputs ?? { type: "object", properties: {} });
    const properties = Object.fromEntries([...used].map((id) => {
      const property = full.properties[id];
      if (!property) throw new Error(`package update needs undeclared input ${id} for agent ${name}`);
      return [id, property];
    }));
    const schema = parseInputSchema({ type: "object", properties,
      required: (full.required ?? []).filter((id) => used.has(id)) });
    const supplied = Object.fromEntries(Object.entries(binding.inputs ?? {}).filter(([id]) => used.has(id)));
    try { applyPackageInputs({}, schema, supplied, [], dirname(resolve(options.configPath))); }
    catch (error) { throw new Error(`package update input mismatch for agent ${name}: ${(error as Error).message}`); }
  }
}

export async function updatePackage(options: InstallPackageOptions): Promise<PackageEntry> {
  checkedAlias(options.alias);
  const prepared = await prepareSource(options);
  return withPackageWriteLock(indexPath(options), async () => {
    const index = readIndex(options);
    if (!index.installations[options.alias]) throw new Error(`unknown package alias: ${options.alias}`);
    await validateAffectedBindings(options, options.alias, prepared.published.manifest, prepared.published.root);
    const next = entry(prepared.published, prepared.source);
    if (index.installations[options.alias]!.digest === next.digest) return index.installations[options.alias]!;
    index.installations[options.alias] = next;
    if (options.faultAt === "before-index-commit") throw new Error("injected package fault before index commit");
    await writeIndex(options, index);
    return next;
  });
}

export async function removePackage(options: PackageAliasOptions): Promise<void> {
  checkedAlias(options.alias);
  await withPackageWriteLock(indexPath(options), async () => {
    const index = readIndex(options);
    if (!index.installations[options.alias]) throw new Error(`unknown package alias: ${options.alias}`);
    const dependents = configReferences(options, options.alias);
    if (dependents.length) throw new Error(`package ${options.alias} is used by ${dependents.join(", ")}`);
    delete index.installations[options.alias];
    await writeIndex(options, index);
  });
}

export async function linkPackage(options: InstallPackageOptions): Promise<PackageEntry> {
  checkedAlias(options.alias);
  const source = resolve(options.source);
  const loaded = await loadPackageManifest(source);
  return withPackageWriteLock(indexPath(options), async () => {
    const index = readIndex(options);
    if (index.installations[options.alias]) throw new Error(`package alias collision: ${options.alias}`);
    const linked: PackageEntry = { digest: null, name: loaded.manifest.name, version: loaded.manifest.version,
      source: { kind: "link", path: source },
      dependencies: Object.fromEntries(Object.entries(loaded.manifest.dependencies ?? {}).map(([alias, item]) => [alias, item.digest])) };
    index.installations[options.alias] = linked;
    await writeIndex(options, index);
    return linked;
  });
}

export async function resolveInstalledPackage(options: PackageAliasOptions): Promise<{
  digest: string; root: string; manifest: RawPackageManifest;
}> {
  checkedAlias(options.alias);
  const installed = readIndex(options).installations[options.alias];
  if (!installed) throw new Error(`unknown package alias: ${options.alias}`);
  if (installed.source.kind === "link") {
    const prepared = await prepareSource({ ...options, source: installed.source.path });
    return prepared.published;
  }
  if (!installed.digest) throw new Error(`installed package has no artifact digest: ${options.alias}`);
  const root = join(dataRoot(options), installed.digest, "content");
  const manifest: LoadedPackageManifest = await loadPackageManifest(root);
  return { digest: installed.digest, root, manifest: manifest.manifest };
}

export async function forkPackage(options: ForkPackageOptions): Promise<string> {
  const source = await resolveInstalledPackage(options);
  const out = resolve(options.out);
  if (existsSync(out) && (await readdir(out)).length) throw new Error(`fork destination is not empty: ${out}`);
  await mkdir(dirname(out), { recursive: true });
  await cp(source.root, out, { recursive: true });
  return out;
}
