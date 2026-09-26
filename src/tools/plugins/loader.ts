import type { VariableContext } from "../../vars/contract.js";
import AjvDraft7 from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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

const bundledNames = new Set(["read_file", "write_file", "bash", "view_image", "list_skills", "load_skill", "list_vars", "read_var"]);
const manifestKeys = ["api_version", "id", "version", "name", "description", "input_schema", "entry"];

export interface LoadToolPluginsOptions {
  selectedIds: readonly string[];
  configPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  globalConfigRoot?: string;
  skills?: readonly SelectedSkill[];
  vars?: VariableContext;
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

function manifestFrom(value: unknown, expectedId: string): ToolManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid tool manifest: ${expectedId}`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !manifestKeys.includes(key))
    || manifestKeys.some((key) => !Object.hasOwn(item, key))
    || item.api_version !== 1 || item.id !== parseId(expectedId).folder
    || typeof item.version !== "string" || !/^\d+\.\d+\.\d+$/.test(item.version)
    || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(item.name)
    || typeof item.description !== "string" || !item.description.trim()
    || item.entry !== "./index.mjs" || !item.input_schema || typeof item.input_schema !== "object"
    || Array.isArray(item.input_schema)) throw new Error(`invalid tool manifest: ${expectedId}`);
  return item as unknown as ToolManifest;
}

function checkSchemaReferences(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) checkSchemaReferences(item); return; }
  const record = value as Record<string, unknown>;
  if (record.$async !== undefined) throw new Error("async tool schema is unsupported");
  if (record.$ref !== undefined && (typeof record.$ref !== "string" || !record.$ref.startsWith("#/"))) {
    throw new Error("remote tool schema reference is unsupported");
  }
  for (const item of Object.values(record)) checkSchemaReferences(item);
}

function compileSchema(manifest: ToolManifest): (args: unknown) => string | undefined {
  checkSchemaReferences(manifest.input_schema);
  if (manifest.input_schema.type !== "object") throw new Error(`unsupported tool schema: ${manifest.name}`);
  const declared = manifest.input_schema.$schema;
  const draft7 = typeof declared === "string" && /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(declared);
  if (declared !== undefined && !draft7 && declared !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error(`unsupported tool schema draft: ${manifest.name}`);
  }
  const ajv = draft7 ? new AjvDraft7.default({ strict: true, allErrors: true }) : new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  let validate: ReturnType<typeof ajv.compile>;
  try { validate = ajv.compile(manifest.input_schema); }
  catch { throw new Error(`unsupported tool schema: ${manifest.name}`); }
  if ((validate as typeof validate & { $async?: boolean }).$async) throw new Error(`async tool schema is unsupported: ${manifest.name}`);
  return (args) => validate(args) ? undefined : `invalid arguments: ${ajv.errorsText(validate.errors)}`;
}

async function selectedManifest(id: string, root: string): Promise<{
  id: string; manifest: ToolManifest; entryPath: string; sourceDigest: string;
  validateSchema: (args: unknown) => string | undefined;
}> {
  const { folder } = parseId(id);
  let realRoot: string;
  let realFolder: string;
  let realManifest: string;
  let realEntry: string;
  try {
    realRoot = await realpath(root);
    realFolder = await realpath(join(root, folder));
    if (!inside(realRoot, realFolder)) throw new Error("folder escape");
    realManifest = await realpath(join(realFolder, "tool.json"));
    realEntry = await realpath(join(realFolder, "index.mjs"));
  } catch (error) {
    throw new Error(`missing or escaping selected tool ${id}: ${(error as Error).message}`);
  }
  if (!inside(realFolder, realManifest) || !inside(realFolder, realEntry)) throw new Error(`selected tool entry escapes folder: ${id}`);
  let manifest: ToolManifest;
  let manifestBytes: Buffer;
  try { manifestBytes = await readFile(realManifest); manifest = manifestFrom(JSON.parse(manifestBytes.toString("utf8")), id); }
  catch (error) { throw new Error(`invalid selected tool manifest ${id}: ${(error as Error).message}`); }
  const validateSchema = compileSchema(manifest);
  const snapshot = await selectedToolSnapshot(id, realFolder, manifest, manifestBytes, parseId(id).scope === "builtin");
  return { id, manifest, entryPath: snapshot.entryPath, sourceDigest: snapshot.sourceDigest, validateSchema };
}

export async function loadToolPlugins(options: LoadToolPluginsOptions): Promise<ToolPlugin[]> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalBase = env.XDG_CONFIG_HOME ? resolve(cwd, env.XDG_CONFIG_HOME) : join(options.home ?? homedir(), ".config");
  const roots = { builtin: bundledToolsRoot(), local: join(options.globalConfigRoot ?? join(globalBase, "raw"), "tools"),
    agent: join(dirname(resolve(cwd, options.configPath)), "tools") };
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const prepared: Array<Awaited<ReturnType<typeof selectedManifest>>> = [];
  for (const id of options.selectedIds) {
    if (seenIds.has(id)) throw new Error(`duplicate tool id: ${id}`);
    seenIds.add(id);
    const parsed = parseId(id);
    if (parsed.scope === "builtin" && !bundledNames.has(parsed.folder)) throw new Error(`unknown bundled tool: ${id}`);
    const item = await selectedManifest(id, roots[parsed.scope]);
    if (seenNames.has(item.manifest.name)) throw new Error(`duplicate tool name: ${item.manifest.name}`);
    seenNames.add(item.manifest.name);
    prepared.push(item);
  }
  const result: ToolPlugin[] = [];
  for (const item of prepared) {
    let entry: { handler?: unknown; validateArgs?: unknown };
    try { entry = await import(`${pathToFileURL(item.entryPath).href}?raw_source=${item.sourceDigest}`) as typeof entry; }
    catch { throw new Error(`selected tool entry failed to load: ${item.id}`); }
    if (typeof entry.handler !== "function" || (entry.validateArgs !== undefined && typeof entry.validateArgs !== "function")) {
      throw new Error(`invalid selected tool handler or validator: ${item.id}`);
    }
    const semantic = entry.validateArgs as ((args: unknown) => unknown) | undefined;
    const registration: ToolRegistration = {
      name: item.manifest.name, canonicalName: item.id,
      description: item.manifest.description, inputSchema: item.manifest.input_schema,
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
