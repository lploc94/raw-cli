import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalConfigPath, configFilePath, type LoadConfigOptions } from "../config.js";
import { packageRoot } from "../package-root.js";
import { copyOwnedTree } from "../packages/files.js";
import { withPackageWriteLock } from "../packages/lock.js";
import { loadPackageManifest } from "../packages/manifest.js";
import { listInstalledPackages, resolveInstalledPackage } from "../packages/store.js";
import { parseSkillMarkdown } from "../skills/frontmatter.js";
import { compileToolSchema, parseToolManifest } from "../tools/plugins/manifest.js";
import { parseHookManifest } from "../hooks/manifest.js";
import { mutateConfig, readManagedConfig } from "./config.js";
import { record } from "./agents.js";
import { contained, ManagementError, ownedPath, readText, relativeFile, saveOwnedText, validText, type TextSnapshot } from "./files.js";

export type EditableComponentKind = "tools" | "skills" | "hooks";
export interface ComponentInfo {
  id: string;
  kind: EditableComponentKind;
  name: string;
  description: string;
  source: "builtin" | "local" | "agent" | "package" | "linked";
  readOnly: boolean;
  validation: "valid" | "invalid";
  diagnostic?: string;
  usedBy: string[];
  usageAvailable: boolean;
  files: string[];
  manifest?: Record<string, unknown>;
  bodyBytes?: number;
}
interface Asset { id: string; folder: string; name: string; source: ComponentInfo["source"]; readOnly: boolean }
const folderPattern = /^[a-z][a-z0-9_-]*$/;

export class ComponentManager {
  readonly configPath: string;
  constructor(private readonly options: LoadConfigOptions) { this.configPath = configFilePath(options); }
  private root(kind: EditableComponentKind, scope: "builtin" | "local" | "agent"): string {
    if (kind !== "tools" && kind !== "skills" && kind !== "hooks") throw new ManagementError("invalid_input", "unsupported component kind");
    if (scope === "builtin") return join(packageRoot(), "dist", kind, "builtin");
    return join(scope === "local" ? dirname(canonicalConfigPath(this.options)) : dirname(this.configPath), kind);
  }
  private packageOptions() { return { configPath: this.configPath, ...(this.options.env ? { env: this.options.env } : {}) }; }
  private async package(alias: string) {
    const options = this.packageOptions(); const entry = listInstalledPackages(options)[alias];
    if (!entry) throw new ManagementError("not_found", "package alias not found");
    if (entry.source.kind === "link") {
      const loaded = await loadPackageManifest(entry.source.path);
      return { root: resolve(entry.source.path), manifest: loaded.manifest, linked: true };
    }
    return { ...await resolveInstalledPackage({ ...options, alias }), linked: false };
  }
  private async asset(kind: EditableComponentKind, id: string): Promise<Asset> {
    if (kind !== "tools" && kind !== "skills" && kind !== "hooks") throw new ManagementError("invalid_input", "unsupported component kind");
    const local = /^(builtin|local|agent)\/([a-z][a-z0-9_-]*)$/.exec(id);
    if (local) {
      const scope = local[1] as "builtin" | "local" | "agent"; const name = local[2]!;
      const root = await realpath(this.root(kind, scope)); const folder = await realpath(join(root, name));
      if (!contained(root, folder) || folder === root) throw new ManagementError("invalid_input", "component folder escapes root");
      return { id, folder, name, source: scope, readOnly: scope === "builtin" };
    }
    const pkg = /^pkg\/([a-z][a-z0-9_-]*)\/(tools|skills|hooks)\/([a-z][a-z0-9_-]*)$/.exec(id);
    if (!pkg || pkg[2] !== kind) throw new ManagementError("invalid_input", "invalid component ID");
    const installed = await this.package(pkg[1]!); const relative = installed.manifest.exports[kind]?.[pkg[3]!];
    if (!relative) throw new ManagementError("not_found", "package component not found");
    const folder = await realpath(join(installed.root, relative));
    if (!contained(await realpath(installed.root), folder)) throw new ManagementError("invalid_input", "package component escapes root");
    return { id, folder, name: basename(folder), source: installed.linked ? "linked" : "package", readOnly: !installed.linked };
  }
  private async files(folder: string): Promise<string[]> {
    const result: string[] = []; const root = await realpath(folder);
    const walk = async (path: string, prefix: string, parents: Set<string>): Promise<void> => {
      const actual = await realpath(path);
      if (!contained(root, actual) || parents.has(actual)) throw new ManagementError("invalid_input", "component file escapes folder or has a link cycle");
      const chain = new Set(parents); chain.add(actual);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name.startsWith(".raw-write-") || entry.name.endsWith(".mutex")) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const target = await ownedPath(root, relative);
        const info = await lstat(await realpath(target));
        if (info.isDirectory()) await walk(target, relative, chain);
        else if (info.isFile()) result.push(relative);
        else throw new ManagementError("invalid_input", "unsupported component file");
        if (result.length > 1000) throw new ManagementError("invalid_input", "component has more than 1000 files");
      }
    };
    await walk(root, "", new Set()); return result.sort();
  }
  private async validate(kind: EditableComponentKind, asset: Asset, override?: { path: string; source: string }) {
    const read = async (path: string) => {
      if (override?.path === path) return override.source;
      const value = await readText(await ownedPath(asset.folder, path));
      if (!value.exists) throw new ManagementError("not_found", `missing component file: ${path}`);
      return value.source;
    };
    if (kind === "tools") {
      const manifest = parseToolManifest(JSON.parse(await read("tool.json")), asset.id, asset.name);
      compileToolSchema(manifest); await read("index.mjs");
      return { name: manifest.name, description: manifest.description, manifest: manifest as unknown as Record<string, unknown> };
    }
    if (kind === "hooks") {
      const manifest = parseHookManifest(JSON.parse(await read("hook.json")), asset.id, asset.name);
      for (const path of [manifest.command, ...manifest.args]) if (path.startsWith("./")) await read(path.slice(2));
      return { name: manifest.name, description: manifest.events.map((event) => event.name).join(", "),
        manifest: manifest as unknown as Record<string, unknown> };
    }
    const skill = parseSkillMarkdown(await read("SKILL.md"), asset.name);
    return { name: skill.name, description: skill.description, bodyBytes: Buffer.byteLength(skill.markdown) };
  }
  private async usages(kind: EditableComponentKind, id: string): Promise<{ usedBy: string[]; usageAvailable: boolean }> {
    const config = await readManagedConfig(this.options);
    if (!config.data) return { usedBy: [], usageAvailable: !config.exists };
    const usedBy: string[] = []; let usageAvailable = true;
    const target = await this.asset(kind, id);
    for (const [name, raw] of Object.entries(record(config.data.agents))) {
      let agent = record(raw);
      if (typeof agent.from === "string") {
        const match = /^pkg\/([a-z][a-z0-9_-]*)\/agents\/([a-z][a-z0-9_-]*)$/.exec(agent.from);
        if (!match) { usageAvailable = false; continue; }
        try {
          const pkg = await this.package(match[1]!); const path = pkg.manifest.exports.agents?.[match[2]!];
          if (!path) { usageAvailable = false; continue; }
          const source = await readText(await ownedPath(pkg.root, path));
          const definition = JSON.parse(source.source) as Record<string, unknown>;
          const overrides = record(agent.overrides);
          const block = Object.hasOwn(overrides, kind) ? overrides[kind] : definition[kind];
          agent = { [kind]: block };
          const use = record(block).use;
          if (Array.isArray(use)) agent[kind] = { use: use.map((item) => {
            const ref = typeof item === "string" ? item : record(item).ref;
            return typeof ref === "string" && ref.startsWith("#") ? `pkg/${match[1]}/${ref.slice(1)}` : ref;
          }) };
        } catch { usageAvailable = false; continue; }
      }
      const use = record(agent[kind]).use;
      if (!Array.isArray(use)) continue;
      for (const value of use) {
        const ref = typeof value === "string" ? value : record(value).ref;
        if (ref === id) { usedBy.push(name); break; }
        if (typeof ref !== "string" || ref.startsWith("mcp/")) continue;
        try {
          if ((await this.asset(kind, ref)).folder === target.folder) { usedBy.push(name); break; }
        } catch { /* An unresolved other component cannot name this existing owned folder. */ }
      }
    }
    return { usedBy, usageAvailable };
  }
  async inspect(kind: EditableComponentKind, id: string): Promise<ComponentInfo> {
    const asset = await this.asset(kind, id); const usage = await this.usages(kind, id);
    const result: ComponentInfo = { id, kind, name: asset.name, description: "", source: asset.source, readOnly: asset.readOnly,
      validation: "valid", ...usage, files: [] };
    try { result.files = await this.files(asset.folder); Object.assign(result, await this.validate(kind, asset)); }
    catch (error) { result.validation = "invalid"; result.diagnostic = error instanceof Error ? error.message : String(error); }
    return result;
  }
  async list(kind: EditableComponentKind): Promise<ComponentInfo[]> {
    const rows: ComponentInfo[] = [];
    const add = async (id: string, source: ComponentInfo["source"]) => {
      try { rows.push(await this.inspect(kind, id)); }
      catch (error) { rows.push({ id, kind, name: id.split("/").at(-1)!, description: "", source, readOnly: source === "builtin" || source === "package",
        validation: "invalid", diagnostic: String(error), usedBy: [], usageAvailable: false, files: [] }); }
    };
    for (const scope of ["builtin", "local", "agent"] as const) {
      let entries;
      try { entries = await readdir(this.root(kind, scope), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) if (folderPattern.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        await add(`${scope}/${entry.name}`, scope);
      }
    }
    let installed: ReturnType<typeof listInstalledPackages>;
    try { installed = listInstalledPackages(this.packageOptions()); } catch { return rows; }
    for (const [alias, entry] of Object.entries(installed)) {
      try {
        const pkg = await this.package(alias);
        for (const name of Object.keys(pkg.manifest.exports[kind] ?? {})) await add(`pkg/${alias}/${kind}/${name}`, entry.source.kind === "link" ? "linked" : "package");
      } catch (error) { rows.push({ id: `pkg/${alias}`, kind, name: alias, description: "", source: "package", readOnly: true,
        validation: "invalid", diagnostic: String(error), usedBy: [], usageAvailable: false, files: [] }); }
    }
    return rows;
  }
  async readFile(kind: EditableComponentKind, id: string, path: string): Promise<TextSnapshot> {
    const asset = await this.asset(kind, id); const value = await readText(await ownedPath(asset.folder, path));
    if (!value.exists) throw new ManagementError("not_found", "component file not found"); return value;
  }
  async saveFile(kind: EditableComponentKind, id: string, path: string, revision: string, source: string): Promise<TextSnapshot> {
    const asset = await this.asset(kind, id);
    if (asset.readOnly) throw new ManagementError("read_only", "component is read-only; fork it first");
    return withPackageWriteLock(asset.folder, async () => {
      const target = await ownedPath(asset.folder, path, true);
      return saveOwnedText(target, source, revision, async () => {
        await ownedPath(asset.folder, path, true);
        if (path === "tool.json" || path === "SKILL.md" || path === "hook.json") await this.validate(kind, asset, { path, source });
      });
    });
  }
  private async publish(kind: EditableComponentKind, id: string, populate: (stage: string, name: string) => Promise<void>): Promise<ComponentInfo> {
    const match = /^(local|agent)\/([a-z][a-z0-9_-]*)$/.exec(id);
    if (!match) throw new ManagementError("invalid_input", "create a local/name or agent/name component");
    const scope = match[1] as "local" | "agent", name = match[2]!; const root = this.root(kind, scope);
    await mkdir(root, { recursive: true });
    await withPackageWriteLock(join(root, ".components"), async () => {
      const destination = join(root, name);
      try { await lstat(destination); throw new ManagementError("conflict", "component already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const stage = join(root, `.raw-create-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
      try {
        await populate(stage, name);
        await this.files(stage); await this.validate(kind, { id, folder: stage, name, source: scope, readOnly: false });
        try { await lstat(destination); throw new ManagementError("conflict", "component already exists"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rename(stage, destination);
      } finally { await rm(stage, { recursive: true, force: true }); }
    });
    return this.inspect(kind, id);
  }
  create(kind: EditableComponentKind, id: string, files: Record<string, string>): Promise<ComponentInfo> {
    return this.publish(kind, id, async (stage) => {
      if (Object.keys(files).length > 1000) throw new ManagementError("invalid_input", "too many component files");
      for (const [path, source] of Object.entries(files)) {
        relativeFile(path); validText(source); const target = join(stage, path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, source, { flag: "wx", mode: 0o600 });
      }
    });
  }
  async clone(kind: EditableComponentKind, sourceId: string, id: string): Promise<ComponentInfo> {
    const source = await this.asset(kind, sourceId);
    return this.publish(kind, id, async (stage, name) => {
      await copyOwnedTree(source.folder, stage);
      if (kind === "tools") {
        const file = join(stage, "tool.json"); const value = JSON.parse((await readText(file)).source) as Record<string, unknown>;
        value.id = name; value.name = name; await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      } else if (kind === "skills") {
        const file = join(stage, "SKILL.md"); const value = (await readText(file)).source;
        await writeFile(file, value.replace(/^name:.*$/m, `name: ${name.replaceAll("_", "-")}`), { mode: 0o600 });
      } else {
        const file = join(stage, "hook.json"); const value = JSON.parse((await readText(file)).source) as Record<string, unknown>;
        value.name = name; await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      }
    });
  }
  async attach(kind: EditableComponentKind, id: string, agentName: string, expectedRevision: string, selected = true) {
    const info = await this.inspect(kind, id);
    if (selected && info.validation !== "valid") throw new ManagementError("invalid_input", info.diagnostic ?? "invalid component");
    return mutateConfig({ ...this.options, expectedRevision }, (data) => {
      const agents = record(data.agents);
      if (!Object.hasOwn(agents, agentName)) throw new ManagementError("not_found", "agent not found");
      const agent = record(agents[agentName]);
      if (agent.from) throw new ManagementError("invalid_input", "edit the package binding's complete selection override explicitly");
      if (kind === "skills" && selected && (info.bodyBytes ?? 0) > Number(agent.max_output_bytes ?? 8192)) {
        throw new ManagementError("invalid_input", "skill body exceeds this agent's max_output_bytes; adjust its output cap before selecting");
      }
      const block = record(agent[kind]); const use = Array.isArray(block.use) ? [...block.use] : [];
      const matches = (item: unknown) => (typeof item === "string" ? item : record(item).ref) === id;
      if (selected && !use.some(matches)) use.push(id);
      agent[kind] = { ...block, use: selected ? use : use.filter((item) => !matches(item)) };
      if (kind === "skills" && selected) {
        const tools = record(agent.tools); const toolUse = Array.isArray(tools.use) ? [...tools.use] : [];
        for (const required of ["builtin/list_skills", "builtin/load_skill"]) if (!toolUse.includes(required)) toolUse.push(required);
        agent.tools = { ...tools, use: toolUse };
      }
    });
  }
  async remove(kind: EditableComponentKind, id: string): Promise<void> {
    const asset = await this.asset(kind, id);
    if (asset.readOnly || asset.source === "linked") throw new ManagementError("read_only", "remove package exports through package source management; fork builtins first");
    await withPackageWriteLock(this.configPath, async () => {
      const usage = await this.usages(kind, id);
      if (!usage.usageAvailable || usage.usedBy.length) throw new ManagementError("in_use", `detach component usages before removal: ${usage.usedBy.join(", ") || "unavailable config"}`);
      await withPackageWriteLock(asset.folder, async () => { await rm(asset.folder, { recursive: true }); });
    });
  }
}
