import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseHookManifest } from "./manifest.js";
import { snapshotHook } from "./snapshot.js";
import type { SelectedHook } from "./contract.js";
import type { PackageAsset } from "../packages/resolve-agent.js";

export interface LoadSelectedHooksOptions {
  selectedIds: readonly string[];
  configPath: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  globalConfigRoot?: string;
  packageHooks?: Readonly<Record<string, PackageAsset>>;
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix);
}
async function ownedFile(folder: string, value: string, id: string): Promise<string> {
  if (!value.startsWith("./") || value.includes("\\")) throw new Error(`invalid hook asset path: ${id}`);
  const path = await realpath(resolve(folder, value));
  if (!inside(folder, path) || !(await stat(path)).isFile()) throw new Error(`hook asset escapes or is not a file: ${id}`);
  return path;
}

export async function loadSelectedHooks(options: LoadSelectedHooksOptions): Promise<readonly SelectedHook[]> {
  if (!options.selectedIds.length) return Object.freeze([]);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalBase = env.XDG_CONFIG_HOME ? resolve(cwd, env.XDG_CONFIG_HOME) : join(options.home ?? homedir(), ".config");
  const roots = { local: join(options.globalConfigRoot ?? join(globalBase, "raw"), "hooks"),
    agent: join(dirname(resolve(cwd, options.configPath)), "hooks") };
  const seen = new Set<string>();
  const result: SelectedHook[] = [];
  for (const id of options.selectedIds) {
    if (seen.has(id)) throw new Error(`duplicate selected hook: ${id}`);
    seen.add(id);
    const direct = options.packageHooks?.[id];
    const match = direct ? undefined : /^(local|agent)\/([a-z][a-z0-9_-]*)$/.exec(id);
    if (!direct && !match) throw new Error(`invalid hook id: ${id}`);
    const root = await realpath(direct ? dirname(direct.folder) : roots[match![1] as "local" | "agent"]);
    const folder = await realpath(direct?.folder ?? join(root, match![2]!));
    if (!inside(root, folder)) throw new Error(`selected hook escapes root: ${id}`);
    const manifestPath = await realpath(join(folder, "hook.json"));
    if (!inside(folder, manifestPath) || !(await stat(manifestPath)).isFile()) throw new Error(`hook manifest escapes folder: ${id}`);
    const bytes = await readFile(manifestPath);
    if (bytes.length > 65536) throw new Error(`hook manifest is too large: ${id}`);
    let source: unknown;
    try { source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error(`invalid hook manifest JSON: ${id}`); }
    const manifest = parseHookManifest(source, id, direct?.name ?? match![2]!);
    const command = manifest.command.startsWith("./") ? await ownedFile(folder, manifest.command, id) : manifest.command;
    const args = await Promise.all(manifest.args.map((arg) => arg.startsWith("./") ? ownedFile(folder, arg, id) : arg));
    const frozen = await snapshotHook(folder, resolve(cwd, options.configPath), id);
    const relocate = (path: string) => {
      if (!isAbsolute(path)) return path;
      const suffix = relative(folder, path);
      return inside(folder, path) ? join(frozen, suffix) : path;
    };
    result.push(Object.freeze({ ...manifest, id, folder: frozen, command: relocate(command), args: args.map(relocate) }));
  }
  return Object.freeze(result);
}
