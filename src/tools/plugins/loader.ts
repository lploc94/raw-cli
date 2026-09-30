import type { VariableContext } from "../../vars/contract.js";
import { parseToolManifest, compileToolSchema } from "./manifest.js";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../../package-root.js";
import type { ToolContext } from "../primitives.js";
import type { ToolRegistration } from "../registry.js";
import type { ToolManifest, ToolPlugin } from "./contract.js";
import type { SelectedSkill } from "../../skills/contract.js";
import { selectedToolSnapshot } from "./snapshot.js";
import type { PackageAsset } from "../../packages/resolve-agent.js";

const bundledNames = new Set(["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill", "list_vars", "read_var", "todo", "ask_user", "process"]);

export interface LoadToolPluginsOptions {
  selectedIds: readonly string[];
  configPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  globalConfigRoot?: string;
  skills?: readonly SelectedSkill[];
  vars?: VariableContext;
  packageTools?: Readonly<Record<string, PackageAsset>>;
  /** Receives non-fatal manifest notes such as an unknown panel icon. */
  onWarning?: (message: string) => void;
}

export function bundledToolsRoot(): string {
  return join(packageRoot(), "dist", "tools", "builtin");
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix);
}

function parseId(id: string): { scope: "builtin" | "local" | "agent"; folder: string } {
  const match = /^(builtin|local|agent)\/([a-z][a-z0-9_-]*)$/.exec(id);
  if (!match) throw new Error(`invalid tool id: ${id}`);
  return { scope: match[1] as "builtin" | "local" | "agent", folder: match[2]! };
}

async function selectedManifest(id: string, root: string, direct?: PackageAsset, warn?: (message: string) => void): Promise<{
  id: string; manifest: ToolManifest; entryPath: string; sourceDigest: string;
  validateSchema: (args: unknown) => string | undefined;
}> {
  const folder = direct?.name ?? parseId(id).folder;
  let realRoot: string;
  let realFolder: string;
  let realManifest: string;
  let realEntry: string;
  try {
    realRoot = await realpath(root);
    realFolder = await realpath(direct?.folder ?? join(root, folder));
    if (!inside(realRoot, realFolder)) throw new Error("folder escape");
    realManifest = await realpath(join(realFolder, "tool.json"));
    realEntry = await realpath(join(realFolder, "index.mjs"));
  } catch (error) {
    throw new Error(`missing or escaping selected tool ${id}: ${(error as Error).message}`);
  }
  if (!inside(realFolder, realManifest) || !inside(realFolder, realEntry)) throw new Error(`selected tool entry escapes folder: ${id}`);
  let manifest: ToolManifest;
  let manifestBytes: Buffer;
  try { manifestBytes = await readFile(realManifest); manifest = parseToolManifest(JSON.parse(manifestBytes.toString("utf8")), id, folder, warn); }
  catch (error) { throw new Error(`invalid selected tool manifest ${id}: ${(error as Error).message}`); }
  const validateSchema = compileToolSchema(manifest);
  const snapshot = await selectedToolSnapshot(direct?.canonicalIdentity ?? id, realFolder, manifest, manifestBytes,
    !direct && parseId(id).scope === "builtin");
  return { id, manifest, entryPath: snapshot.entryPath, sourceDigest: snapshot.sourceDigest, validateSchema };
}

function toolRoots(options: LoadToolPluginsOptions): Record<"builtin" | "local" | "agent", string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalBase = env.XDG_CONFIG_HOME ? resolve(cwd, env.XDG_CONFIG_HOME) : join(options.home ?? homedir(), ".config");
  return { builtin: bundledToolsRoot(), local: join(options.globalConfigRoot ?? join(globalBase, "raw"), "tools"),
    agent: join(dirname(resolve(cwd, options.configPath)), "tools") };
}

/**
 * Reads only the `tool.json` manifests of the selected tools: no entry module is imported or snapshotted, so a tool
 * that throws on import, or whose entry is missing, still yields its declarations. A tool that cannot be read is skipped.
 */
export async function readToolManifests(options: LoadToolPluginsOptions): Promise<Array<{ id: string; manifest: ToolManifest }>> {
  const roots = toolRoots(options);
  const found: Array<{ id: string; manifest: ToolManifest }> = [];
  for (const id of options.selectedIds) {
    try {
      const direct = options.packageTools?.[id];
      const parsed = direct ? undefined : parseId(id);
      const folder = direct?.name ?? parsed!.folder;
      const folderPath = direct?.folder ?? join(roots[parsed!.scope], folder);
      const manifest = parseToolManifest(JSON.parse(await readFile(await realpath(join(folderPath, "tool.json")), "utf8")), id, folder, options.onWarning);
      found.push({ id, manifest });
    } catch { /* selection errors are reported by loadToolPlugins when the runtime starts */ }
  }
  return found;
}

export async function loadToolPlugins(options: LoadToolPluginsOptions): Promise<ToolPlugin[]> {
  const roots = toolRoots(options);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const prepared: Array<Awaited<ReturnType<typeof selectedManifest>>> = [];
  for (const id of options.selectedIds) {
    if (seenIds.has(id)) throw new Error(`duplicate tool id: ${id}`);
    seenIds.add(id);
    const direct = options.packageTools?.[id];
    const parsed = direct ? undefined : parseId(id);
    if (parsed?.scope === "builtin" && !bundledNames.has(parsed.folder)) throw new Error(`unknown bundled tool: ${id}`);
    const item = await selectedManifest(id, direct ? dirname(direct.folder) : roots[parsed!.scope], direct, options.onWarning);
    const visibleName = direct?.as ?? item.manifest.name;
    if (seenNames.has(visibleName)) throw new Error(`duplicate tool name: ${visibleName}`);
    seenNames.add(visibleName);
    prepared.push(item);
  }
  const result: ToolPlugin[] = [];
  for (const item of prepared) {
    let entry: { handler?: unknown; validateArgs?: unknown; describeEffects?: unknown };
    try { entry = await import(`${pathToFileURL(item.entryPath).href}?raw_source=${item.sourceDigest}`) as typeof entry; }
    catch { throw new Error(`selected tool entry failed to load: ${item.id}`); }
    if (typeof entry.handler !== "function" || (entry.validateArgs !== undefined && typeof entry.validateArgs !== "function")) {
      throw new Error(`invalid selected tool handler or validator: ${item.id}`);
    }
    if (item.manifest.effects_schema && typeof entry.describeEffects !== "function") throw new Error(`missing effects descriptor: ${item.id}`);
    const semantic = entry.validateArgs as ((args: unknown) => unknown) | undefined;
    const registration: ToolRegistration = {
      name: options.packageTools?.[item.id]?.as ?? item.manifest.name,
      canonicalName: options.packageTools?.[item.id]?.canonicalIdentity ?? item.id,
      description: item.manifest.description, inputSchema: item.manifest.input_schema,
      conditionSources: item.manifest.condition_sources ?? ["arguments"],
      ...(item.manifest.effects_schema ? { effectsSchema: item.manifest.effects_schema,
        describeEffects: entry.describeEffects as NonNullable<ToolRegistration["describeEffects"]> } : {}),
      ...(item.manifest.panels?.length ? { panels: item.manifest.panels } : {}),
      validateArgs(args) {
        let error: unknown;
        try { error = semantic?.(args); } catch { return "semantic validator failed"; }
        if (error !== undefined) return typeof error === "string" ? error : "semantic validator returned a non-string result";
        return item.validateSchema(args);
      },
      handler(args, context) {
        const pluginContext: ToolContext = {
          cwd: context.cwd, maxOutputBytes: context.maxOutputBytes,
          ...((options.vars ?? context.vars) ? { vars: options.vars ?? context.vars } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
          ...(context.bashPath ? { bashPath: context.bashPath } : {}),
          ...(context.panels ? { panels: context.panels } : {}), // onPanelUpdates stays host-only
          ...(context.effects ? { effects: context.effects } : {}),
          ...(item.id === "builtin/bash" && context.commandActivity ? { commandActivity: context.commandActivity } : {}),
          ...(context.processes ? { processes: context.processes } : {}),
          ...(context.interactions ? { interactions: context.interactions } : {}),
          ...((item.id === "builtin/list_skills" || item.id === "builtin/load_skill") && options.skills
            ? { skills: options.skills } : {}),
        };
        return (entry.handler as ToolRegistration["handler"])(args, pluginContext);
      },
    };
    result.push({ id: item.id, version: item.manifest.version, sourceDigest: item.sourceDigest, registration });
  }
  return result;
}

export async function loadBundledTools(names: readonly string[]): Promise<ToolRegistration[]> {
  const tools = await loadToolPlugins({ selectedIds: names.map((name) => `builtin/${name}`), configPath: join(packageRoot(), "config.json") });
  return tools.map((item) => item.registration);
}
