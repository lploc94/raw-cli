import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { applyPackageInputs, parseInputSchema } from "./inputs.js";
import { parseComponentReference, parseSelectionReference } from "./references.js";
import { resolveInstalledDependency, resolveInstalledPackage, type PackageStoreOptions } from "./store.js";
import { hostCapabilities } from "./contract.js";

type JsonObject = Record<string, unknown>;
export interface PackageAsset { folder: string; name: string; canonicalIdentity: string; as?: string }
export interface PackageSelections { agent: JsonObject; tools: Readonly<Record<string, PackageAsset>>;
  skills: Readonly<Record<string, PackageAsset>> }
type Installed = Awaited<ReturnType<typeof resolveInstalledPackage>>;
export interface PackageResolutionContext { packages: Map<string, Installed> }
export function createPackageResolutionContext(): PackageResolutionContext { return { packages: new Map() }; }
async function installed(options: PackageStoreOptions, alias: string, context?: PackageResolutionContext): Promise<Installed> {
  const saved = context?.packages.get(alias);
  if (saved) return saved;
  const value = await resolveInstalledPackage({ ...options, alias });
  context?.packages.set(alias, value);
  return value;
}

function record(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as JsonObject;
}

function selectedInputs(definition: unknown, schemaValue: unknown, supplied: JsonObject, configPath: string,
  permitted: ReadonlySet<string>): JsonObject {
  const sites: string[] = [];
  const used = new Set<string>();
  const scan = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, index) => scan(item, `${path}[${index}]`)); return; }
    const item = value as JsonObject;
    if (Object.hasOwn(item, "$input")) {
      if (Object.keys(item).length !== 1 || typeof item.$input !== "string") throw new Error(`invalid package input reference at ${path}`);
      if (!permitted.has(path.split(/[.[]/)[0]!)) throw new Error(`package input is not allowed at site: ${path}`);
      used.add(item.$input); sites.push(path); return;
    }
    for (const [key, child] of Object.entries(item)) scan(child, path ? `${path}.${key}` : key);
  };
  scan(definition, "");
  if (!used.size) return structuredClone(definition) as JsonObject;
  const schema = parseInputSchema(schemaValue ?? { type: "object", properties: {} });
  const properties = Object.fromEntries([...used].map((name) => {
    if (!schema.properties[name]) throw new Error(`undeclared package input: ${name}`);
    return [name, schema.properties[name]];
  }));
  const projected = parseInputSchema({ type: "object", properties,
    required: (schema.required ?? []).filter((name) => used.has(name)) });
  const selected = Object.fromEntries(Object.entries(supplied).filter(([name]) => used.has(name)));
  return applyPackageInputs(definition, projected, selected, sites, dirname(configPath)) as JsonObject;
}

export function validatePackageAgentBinding(binding: unknown): JsonObject & { from: string; model: string } {
  const local = record(binding, "package agent binding");
  for (const key of Object.keys(local)) if (!["from", "model", "inputs", "overrides"].includes(key)) {
    throw new Error(`unknown package agent binding field: ${key}`);
  }
  if (typeof local.from !== "string") throw new Error("package agent binding requires from");
  const parsed = parseComponentReference(local.from);
  if (parsed.source !== "installed" || parsed.kind !== "agents") throw new Error(`invalid package agent binding: ${local.from}`);
  if (typeof local.model !== "string" || !local.model.trim()) throw new Error("package agent binding requires model");
  if (local.inputs !== undefined) record(local.inputs, "package agent inputs");
  if (local.overrides !== undefined) {
    for (const key of Object.keys(record(local.overrides, "package agent overrides"))) {
      if (!["request", "max_steps", "max_output_bytes", "request_timeout_ms", "cache", "compact", "tools", "skills", "vars", "system_prompt", "system_prompt_file"].includes(key)) {
        throw new Error(`unsupported package agent override: ${key}`);
      }
    }
  }
  return local as JsonObject & { from: string; model: string };
}

export async function resolvePackageAgentBinding(binding: unknown, options: PackageStoreOptions,
  context?: PackageResolutionContext): Promise<JsonObject> {
  const local = validatePackageAgentBinding(binding);
  const parsed = parseComponentReference(local.from);
  if (parsed.source !== "installed") throw new Error("expected installed package reference");
  const model = local.model;
  const selected = await installed(options, parsed.alias, context);
  for (const capability of selected.manifest.requires ?? []) if (!hostCapabilities.has(capability)) {
    throw new Error(`${local.from} requires unsupported host capability ${capability}`);
  }
  const path = selected.manifest.exports.agents?.[parsed.exportName];
  if (!path) throw new Error(`unknown package agent export: ${local.from}`);
  const source = record(JSON.parse(await readFile(join(selected.root, path), "utf8")), `package agent ${local.from}`);
  if (source.model !== undefined) throw new Error(`package agent must not define recipient model: ${local.from}`);
  const inputs = local.inputs === undefined ? {} : record(local.inputs, "package agent inputs");
  const definition = selectedInputs(source, selected.manifest.inputs, inputs, options.configPath,
    new Set(["system_prompt", "system_prompt_file", "request", "max_steps", "max_output_bytes",
      "request_timeout_ms", "cache", "compact"]));
  if (typeof definition.system_prompt_file === "string") {
    if (!isAbsolute(definition.system_prompt_file)) definition.system_prompt_file = join(selected.root, definition.system_prompt_file);
  }
  for (const block of ["tools", "skills"] as const) {
    const selection = (definition[block] as { use?: unknown } | undefined)?.use;
    if (!Array.isArray(selection)) continue;
    (definition[block] as { use: unknown[] }).use = selection.map((item) => {
      const ref = typeof item === "string" ? item : (item as { ref?: unknown } | undefined)?.ref;
      if (typeof ref !== "string") return item;
      const translated = ref.startsWith("#") ? `pkg/${parsed.alias}/${ref.slice(1)}`
        : ref.startsWith("dep:") ? (() => {
          const dependency = parseComponentReference(ref);
          if (dependency.source !== "dependency") throw new Error(`invalid dependency reference: ${ref}`);
          return `pkgdep/${parsed.alias}/${dependency.dependency}/${dependency.kind}/${dependency.exportName}`;
        })() : ref;
      return typeof item === "string" ? translated : { ...(item as JsonObject), ref: translated };
    });
  }
  const overrides = local.overrides === undefined ? {} : record(local.overrides, "package agent overrides");
  if (Object.hasOwn(overrides, "system_prompt")) delete definition.system_prompt_file;
  if (Object.hasOwn(overrides, "system_prompt_file")) delete definition.system_prompt;
  return { ...definition, ...overrides, model };
}

export async function resolvePackageSelections(agent: unknown, options: PackageStoreOptions,
  context?: PackageResolutionContext): Promise<PackageSelections> {
  const effective = structuredClone(record(agent, "agent"));
  const assets: { tools: Record<string, PackageAsset>; skills: Record<string, PackageAsset> } = {
    tools: Object.create(null), skills: Object.create(null),
  };
  for (const kind of ["tools", "skills"] as const) {
    const block = effective[kind] as { use?: unknown } | undefined;
    if (!block || !Array.isArray(block.use)) continue;
    const ids: string[] = [];
    for (const item of block.use) {
      const reference = typeof item === "string" ? item :
        typeof (item as { ref?: unknown } | undefined)?.ref === "string"
          && String((item as { ref: string }).ref).startsWith("pkgdep/")
          ? item as { ref: string; as?: string; inputs?: JsonObject } : parseSelectionReference(item);
      const ref = typeof reference === "string" ? reference : reference.ref;
      if (!ref.startsWith("pkg/") && !ref.startsWith("pkgdep/")) { ids.push(ref); continue; }
      const dependency = /^pkgdep\/([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_-]*)\/(tools|skills)\/([a-z][a-z0-9_-]*)$/.exec(ref);
      const parsed = dependency ? undefined : parseComponentReference(ref);
      if (dependency ? dependency[3] !== kind : parsed?.source !== "installed" || parsed.kind !== kind) {
        throw new Error(`invalid selected ${kind} export: ${ref}`);
      }
      const selected = dependency ? await resolveInstalledDependency({ ...options, alias: dependency[1]!, dependency: dependency[2]!,
        parent: await installed(options, dependency[1]!, context) })
        : await installed(options, (parsed as { alias: string }).alias, context);
      const exportName = dependency ? dependency[4]! : parsed!.exportName;
      const path = selected.manifest.exports[kind]?.[exportName];
      if (!path) throw new Error(`unknown package export: ${ref}`);
      for (const capability of selected.manifest.requires ?? []) if (!hostCapabilities.has(capability)) {
        throw new Error(`${ref} requires unsupported host capability ${capability}`);
      }
      assets[kind][ref] = { folder: join(selected.root, path), name: basename(path),
        canonicalIdentity: `${selected.manifest.name}#${kind}/${exportName}`,
        ...(typeof reference === "string" || reference.as === undefined ? {} : { as: reference.as }) };
      ids.push(ref);
    }
    block.use = ids;
  }
  return { agent: effective, tools: assets.tools, skills: assets.skills };
}

export async function resolvePackageDefinition(reference: string, inputs: unknown, options: PackageStoreOptions,
  kind: "vars" | "var_providers" | "mcp", context?: PackageResolutionContext): Promise<{ value: JsonObject; scope: string; root: string;
    canonicalIdentity: string }> {
  const dependency = /^pkgdep\/([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_-]*)\/(vars|var_providers|mcp)\/([a-z][a-z0-9_-]*)$/.exec(reference);
  const parsed = dependency ? undefined : parseComponentReference(reference);
  if (dependency ? dependency[3] !== kind : parsed?.source !== "installed" || parsed.kind !== kind) {
    throw new Error(`invalid ${kind} package binding: ${reference}`);
  }
  const selected = dependency ? await resolveInstalledDependency({ ...options, alias: dependency[1]!, dependency: dependency[2]!,
    parent: await installed(options, dependency[1]!, context) })
    : await installed(options, (parsed as { alias: string }).alias, context);
  const exportName = dependency ? dependency[4]! : parsed!.exportName;
  const path = selected.manifest.exports[kind]?.[exportName];
  if (!path) throw new Error(`unknown package export: ${reference}`);
  for (const capability of selected.manifest.requires ?? []) if (!hostCapabilities.has(capability)) {
    throw new Error(`${reference} requires unsupported host capability ${capability}`);
  }
  const source = record(JSON.parse(await readFile(join(selected.root, path), "utf8")), reference);
  const supplied = inputs === undefined ? {} : record(inputs, `${reference} inputs`);
  const permitted = kind === "vars" ? new Set(["source", "cache_ttl_ms"])
    : kind === "var_providers" ? new Set(["command", "args", "cwd", "timeout_ms", "max_output_bytes"])
      : new Set(["command", "args", "env", "url", "headers"]);
  return { value: selectedInputs(source, selected.manifest.inputs, supplied, options.configPath, permitted),
    scope: dependency ? `pkgdep/${dependency[1]}/${dependency[2]}` : `pkg/${(parsed as { alias: string }).alias}`,
    root: selected.root, canonicalIdentity: `${selected.manifest.name}#${kind}/${exportName}` };
}

export async function resolvePackageDefinitions(agent: JsonObject, root: JsonObject, options: PackageStoreOptions,
  originAlias?: string, context?: PackageResolutionContext, inheritedInputs?: JsonObject, inspectMcpNames: readonly string[] = []): Promise<JsonObject & {
  mcpIdentities: Record<string, string>; mcpSources: Record<string, { root: string; identity: string }> }> {
  const data = structuredClone(root);
  const vars = { ...((data.vars ?? {}) as JsonObject) };
  const providers = { ...((data.var_providers ?? {}) as JsonObject) };
  const servers = { ...(((data.mcp as { servers?: JsonObject } | undefined)?.servers ?? {})) };
  const mcpIdentities: Record<string, string> = Object.create(null);
  const mcpSources: Record<string, { root: string; identity: string }> = Object.create(null);
  const rawSelected = Array.isArray(agent.vars) ? agent.vars : [];
  const selectedVars: string[] = [];
  for (const raw of rawSelected) {
    const reference = typeof raw === "string" ? raw : (raw as { ref?: unknown } | undefined)?.ref;
    if (typeof reference !== "string") throw new Error("invalid selected variable");
    const full = reference.startsWith("#") && originAlias ? `pkg/${originAlias}/${reference.slice(1)}`
      : reference.startsWith("dep:") && originAlias ? (() => {
        const dependency = parseComponentReference(reference);
        if (dependency.source !== "dependency") throw new Error(`invalid variable dependency: ${reference}`);
        return `pkgdep/${originAlias}/${dependency.dependency}/${dependency.kind}/${dependency.exportName}`;
      })() : reference;
    if (!full.startsWith("pkg/") && !full.startsWith("pkgdep/")) { selectedVars.push(full); continue; }
    const dependency = /^pkgdep\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*\/vars\/([a-z][a-z0-9_-]*)$/.exec(full);
    const parsed = dependency ? undefined : parseComponentReference(full);
    if (!dependency && (parsed?.source !== "installed" || parsed.kind !== "vars")) throw new Error(`invalid variable export: ${full}`);
    const name = typeof raw === "string" ? dependency?.[1] ?? parsed!.exportName
      : String((raw as { as?: unknown }).as ?? dependency?.[1] ?? parsed!.exportName);
    if (Object.hasOwn(vars, name)) throw new Error(`duplicate selected variable: ${name}`);
    vars[name] = { from: full, inputs: typeof raw === "string" ? inheritedInputs ?? {}
      : (raw as { inputs?: unknown }).inputs ?? {} };
    selectedVars.push(name);
  }
  agent.vars = selectedVars;
  for (const name of selectedVars) {
    const binding = vars[name] as { from?: unknown; inputs?: unknown } | undefined;
    if (!binding || typeof binding.from !== "string") continue;
    const item = await resolvePackageDefinition(binding.from, binding.inputs, options, "vars", context);
    const value = item.value;
    const source = value.source as { kind?: unknown; name?: unknown; path?: unknown } | undefined;
    if (source?.kind === "file" && typeof source.path === "string" && !isAbsolute(source.path)) {
      source.path = join(item.root, source.path);
    }
    if (source?.kind === "provider" && typeof source.name === "string" && source.name !== "system.time"
      && !Object.hasOwn(providers, source.name)) {
      providers[source.name] = { from: `${item.scope}/var_providers/${source.name}`, inputs: binding.inputs ?? {} };
    }
    vars[name] = value;
  }
  for (const [name, value] of Object.entries(vars)) {
    if (!selectedVars.includes(name) && typeof (value as { from?: unknown } | undefined)?.from === "string") {
      delete vars[name];
    }
  }
  for (const [name, binding] of Object.entries(providers)) {
    const from = (binding as { from?: unknown } | undefined)?.from;
    if (typeof from !== "string") continue;
    const selected = selectedVars.some((varName) => (vars[varName] as { source?: { name?: unknown } } | undefined)?.source?.name === name);
    if (!selected) { delete providers[name]; continue; }
    const item = await resolvePackageDefinition(from, (binding as { inputs?: unknown }).inputs, options, "var_providers", context);
    const value = item.value;
    if (typeof value.command === "string" && value.command.includes("/") && !isAbsolute(value.command)) {
      value.command = join(item.root, value.command);
    }
    if (Array.isArray(value.args)) value.args = value.args.map((arg) =>
      typeof arg === "string" && !arg.startsWith("-") && !isAbsolute(arg) && !arg.includes("://")
        && arg.includes("/") && existsSync(join(item.root, arg))
        ? join(item.root, arg) : arg);
    providers[name] = value;
  }
  const selectedMcp = new Set<string>(inspectMcpNames);
  const toolUse = (agent.tools as { use?: unknown } | undefined)?.use;
  if (Array.isArray(toolUse)) for (const id of toolUse) {
    if (typeof id === "string" && id.startsWith("mcp/")) selectedMcp.add(id.split("/")[1]!);
  }
  for (const name of selectedMcp) {
    if (!Object.hasOwn(servers, name) && originAlias) servers[name] = { from: `pkg/${originAlias}/mcp/${name}`,
      inputs: inheritedInputs ?? {} };
  }
  for (const [name, binding] of Object.entries(servers)) {
    const from = (binding as { from?: unknown } | undefined)?.from;
    if (typeof from !== "string") continue;
    if (!selectedMcp.has(name)) { delete servers[name]; continue; }
    const item = await resolvePackageDefinition(from, (binding as { inputs?: unknown }).inputs, options, "mcp", context);
    const value = item.value;
    if (typeof value.command === "string" && value.command.includes("/") && !isAbsolute(value.command)) {
      value.command = join(item.root, value.command);
    }
    if (Array.isArray(value.args)) value.args = value.args.map((arg) =>
      typeof arg === "string" && !arg.startsWith("-") && !isAbsolute(arg) && !arg.includes("://")
        && arg.includes("/") && existsSync(join(item.root, arg))
        ? join(item.root, arg) : arg);
    servers[name] = value;
    mcpIdentities[name] = item.canonicalIdentity;
    mcpSources[name] = { root: item.root, identity: item.canonicalIdentity };
    const rules = (agent.tools as { rules?: unknown } | undefined)?.rules;
    if (Array.isArray(rules)) for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const match = (rule as { match?: unknown }).match;
      if (typeof match === "string" && match.startsWith(`mcp/${name}/`) && !/[?*]/.test(match)) {
        (rule as { match: string }).match = `${item.canonicalIdentity}/${match.slice(`mcp/${name}/`.length)}`;
      }
    }
  }
  return { vars, var_providers: providers, mcp: { servers }, mcpIdentities, mcpSources };
}
