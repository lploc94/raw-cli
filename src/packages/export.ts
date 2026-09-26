import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { readConfigDocument } from "../config.js";
import type { RawPackageManifest } from "./contract.js";
import { copyOwnedFile, copyOwnedTree } from "./files.js";
import { inspectPackage, type PackageReport } from "./inspect.js";
import { createPackageResolutionContext, resolvePackageAgentBinding, resolvePackageDefinitions,
  resolvePackageSelections } from "./resolve-agent.js";
import { resolveInstalledPackage } from "./store.js";
export { inspectPackage } from "./inspect.js";

export interface ExportAgentOptions {
  configPath: string;
  agentName: string;
  out: string;
  name: string;
  version: string;
  includeLiterals?: boolean;
  includeFiles?: readonly string[];
  draft?: boolean;
  globalConfigRoot?: string;
}
export interface ExportAgentReport extends PackageReport { agent: string; unresolved: readonly string[] }

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${where}`);
  return value as Record<string, unknown>;
}
function names(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`invalid ${where}`);
  return value as string[];
}

export async function exportAgentPackage(options: ExportAgentOptions): Promise<{ root: string; report: ExportAgentReport }> {
  const document = readConfigDocument({ configPath: options.configPath });
  const configDir = dirname(document.path);
  const globalConfigRoot = options.globalConfigRoot ?? (process.env.XDG_CONFIG_HOME
    ? join(resolve(process.cwd(), process.env.XDG_CONFIG_HOME), "raw") : join(homedir(), ".config", "raw"));
  const agents = record(document.data.agents, "agents");
  const configured = record(agents[options.agentName], `agent ${options.agentName}`);
  const packageContext = createPackageResolutionContext();
  const originAlias = typeof configured.from === "string"
    ? /^pkg\/([a-z][a-z0-9_-]*)\/agents\//.exec(configured.from)?.[1] : undefined;
  const installedRoot = originAlias ? await resolveInstalledPackage({ configPath: document.path, alias: originAlias }) : undefined;
  if (originAlias && installedRoot) packageContext.packages.set(originAlias, installedRoot);
  const packageRoot = installedRoot?.root;
  const bound = originAlias ? await resolvePackageAgentBinding(configured, { configPath: document.path }, packageContext) : configured;
  const resolved = await resolvePackageSelections(bound, { configPath: document.path }, packageContext);
  const source = resolved.agent;
  const definitions = await resolvePackageDefinitions(source, document.data, { configPath: document.path }, originAlias,
    packageContext, originAlias ? configured.inputs as Record<string, unknown> | undefined : undefined);
  const packageOwned = (path: string): boolean => packageRoot !== undefined
    && (path === packageRoot || path.startsWith(`${packageRoot}/`));
  const out = resolve(options.out);
  const unresolved: string[] = [];
  const checkAsset = async (path: string, label: string, directory: boolean, ownedRoot?: string): Promise<void> => {
    try {
      const found = await stat(path);
      if (directory ? !found.isDirectory() : !found.isFile()) unresolved.push(`${label}: ${path} has the wrong file type`);
      if (ownedRoot) {
        const inside = relative(await realpath(ownedRoot), await realpath(path));
        if (inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || isAbsolute(inside)) {
          unresolved.push(`${label}: ${path} escapes its owned root`);
        }
      }
    } catch { unresolved.push(`${label}: ${path} is missing or unreadable`); }
  };
  if (typeof source.system_prompt_file === "string") {
    const path = resolve(configDir, source.system_prompt_file);
    const external = isAbsolute(source.system_prompt_file) && !path.startsWith(`${configDir}/`);
    if (!external || packageOwned(path) || options.includeFiles?.some((item) => resolve(configDir, item) === path)) {
      await checkAsset(path, "system prompt", false, external ? undefined : configDir);
    }
  }
  const selectedToolIds = names(record(source.tools, "agent tools").use, "agent tools.use");
  const selectedSkillIds = source.skills === undefined ? [] : names(record(source.skills, "agent skills").use, "agent skills.use");
  for (const [kind, ids] of [["tools", selectedToolIds], ["skills", selectedSkillIds]] as const) for (const id of ids) {
    const match = /^(agent|local)\/([a-z][a-z0-9_-]*)$/.exec(id);
    const asset = kind === "tools" ? resolved.tools[id] : resolved.skills[id];
    if (!match && !asset) continue;
    const folder = asset?.name ?? match![2]!;
    const path = asset?.folder ?? (match![1] === "agent" ? join(configDir, kind, folder)
      : join(globalConfigRoot, kind, folder));
    await checkAsset(path, `selected ${kind.slice(0, -1)} ${id}`, true, dirname(path));
  }
  for (const path of options.includeFiles ?? []) await checkAsset(resolve(configDir, path), `included asset ${path}`, false);
  if (unresolved.length) {
    if (!options.draft) throw new Error(`unresolved export assets:\n${unresolved.join("\n")}`);
    const exports = { agents: [options.agentName], skills: [], tools: [], vars: [], var_providers: [], mcp: [] };
    return { root: out, report: { agent: options.agentName, name: options.name, version: options.version,
      exports, files: [], inputs: [], requires: [], prerequisites: [], unresolved } };
  }
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error(`export destination is not empty: ${out}`);
  const agent = structuredClone(source);
  delete agent.model;
  const files: string[] = [];
  const included = new Set((options.includeFiles ?? []).map((path) => resolve(configDir, path)));
  const includeFile = async (sourcePath: string, target: string): Promise<string | undefined> => {
    if (!included.has(resolve(configDir, sourcePath)) && !packageOwned(resolve(configDir, sourcePath))) return undefined;
    await copyOwnedFile(resolve(configDir, sourcePath), join(out, target));
    files.push(target);
    return target;
  };
  const exported: RawPackageManifest["exports"] = { agents: { [options.agentName]: `agents/${options.agentName}.json` } };
  const inputProperties: Record<string, Record<string, unknown>> = {};
  const inputRequired: string[] = [];
  const prerequisites = new Set<string>();
  const addInput = (id: string, kind: string, description: string): { $input: string } => {
    const key = id.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (Object.hasOwn(inputProperties, key)) throw new Error(`duplicate exported input name: ${key}`);
    inputProperties[key] = { type: kind === "var-source" || kind === "object" ? "object" : "string",
      ...(kind === "string" || kind === "object" ? {} : { "x-raw-kind": kind }), description };
    inputRequired.push(key);
    return { $input: key };
  };
  if (typeof agent.system_prompt_file === "string") {
    const sourcePath = resolve(configDir, agent.system_prompt_file);
    if (isAbsolute(agent.system_prompt_file) && !sourcePath.startsWith(`${configDir}/`)) {
      agent.system_prompt_file = await includeFile(sourcePath, `prompts/${options.agentName}.md`)
        ?? addInput("system_prompt_file", "file", "Recipient system prompt file");
    } else {
      const target = `prompts/${options.agentName}.md`;
      await copyOwnedFile(sourcePath, join(out, target));
      files.push(target);
      agent.system_prompt_file = target;
    }
  }
  const tools = record(agent.tools, "agent tools");
  const selection = names(tools.use, "agent tools.use");
  const emittedTools: Record<string, string> = {};
  for (let index = 0; index < selection.length; index++) {
    const id = selection[index]!;
    const match = /^(agent|local)\/([a-z][a-z0-9_-]*)$/.exec(id);
    const asset = resolved.tools[id];
    if (!match && !asset) continue;
    const folder = asset?.name ?? match![2]!;
    if (emittedTools[folder]) throw new Error(`duplicate exported tool path: ${folder}`);
    const sourceRoot = asset?.folder ?? (match![1] === "agent" ? join(configDir, "tools", folder)
      : join(globalConfigRoot, "tools", folder));
    const path = `tools/${folder}`;
    await copyOwnedTree(sourceRoot, join(out, path));
    emittedTools[folder] = path;
    files.push(path);
    selection[index] = `#tools/${folder}`;
    if (Array.isArray(tools.rules)) for (const rule of tools.rules) {
      if (rule && typeof rule === "object" && ((rule as { match?: unknown }).match === id
        || (asset && (rule as { match?: unknown }).match === asset.canonicalIdentity))) {
        (rule as { match: string }).match = `${options.name}#tools/${folder}`;
      }
    }
  }
  if (Object.keys(emittedTools).length) exported.tools = emittedTools;
  const skillSelection = agent.skills === undefined ? [] : names(record(agent.skills, "agent skills").use, "agent skills.use");
  const emittedSkills: Record<string, string> = {};
  for (let index = 0; index < skillSelection.length; index++) {
    const id = skillSelection[index]!;
    const match = /^(agent|local)\/([a-z][a-z0-9_-]*)$/.exec(id);
    const asset = resolved.skills[id];
    if (!match && !asset) continue;
    const folder = asset?.name ?? match![2]!;
    if (emittedSkills[folder]) throw new Error(`duplicate exported skill path: ${folder}`);
    const sourceRoot = asset?.folder ?? (match![1] === "agent" ? join(configDir, "skills", folder)
      : join(globalConfigRoot, "skills", folder));
    const path = `skills/${folder}`;
    await copyOwnedTree(sourceRoot, join(out, path));
    emittedSkills[folder] = path;
    files.push(path);
    skillSelection[index] = `#skills/${folder}`;
  }
  if (Object.keys(emittedSkills).length) exported.skills = emittedSkills;
  const selectedVars = agent.vars === undefined ? [] : names(agent.vars, "agent.vars");
  const varDefinitions = record(definitions.vars ?? document.data.vars ?? {}, "vars");
  const providerDefinitions = record(definitions.var_providers ?? document.data.var_providers ?? {}, "var_providers");
  const emittedVars: Record<string, string> = {};
  const emittedProviders: Record<string, string> = {};
  for (const name of selectedVars) {
    const variable = structuredClone(record(varDefinitions[name], `var ${name}`));
    const source = record(variable.source, `var ${name}.source`);
    if (source.kind === "literal" && !options.includeLiterals) {
      variable.source = addInput(`var_${name}_source`, "var-source", `Recipient source for ${name}`);
    } else if (source.kind === "env") {
      source.name = addInput(`var_${name}_env`, "env-name", `Recipient environment name for ${name}`);
    } else if (source.kind === "file") {
      source.path = await includeFile(String(source.path), `assets/vars/${name}-${basename(String(source.path))}`)
        ?? addInput(`var_${name}_file`, "file", `Recipient file for ${name}`);
    } else if (source.kind === "provider" && typeof source.name === "string" && source.name !== "system.time") {
      if (!options.includeLiterals && source.params && Object.keys(record(source.params, `var ${name}.source.params`)).length) {
        source.params = addInput(`var_${name}_params`, "object", `Recipient provider parameters for ${name}`);
      }
      const providerName = source.name;
      const provider = structuredClone(record(providerDefinitions[providerName], `var provider ${providerName}`));
      if (typeof provider.command === "string" && (isAbsolute(provider.command) || provider.command.includes("/"))) {
        provider.command = await includeFile(provider.command, `assets/providers/${providerName}/command-${basename(provider.command)}`)
          ?? addInput(`provider_${providerName}_command`, "file", `Recipient provider executable for ${providerName}`);
      } else if (typeof provider.command === "string") prerequisites.add(provider.command);
      if (Array.isArray(provider.args)) {
        provider.args = await Promise.all(provider.args.map(async (arg, index) => typeof arg === "string" && (arg.startsWith("./") || isAbsolute(arg))
          ? await includeFile(arg, `assets/providers/${providerName}/arg-${index}-${basename(arg)}`)
            ?? addInput(`provider_${providerName}_arg_${index}`, "file", `Recipient provider argument file ${index} for ${providerName}`) : arg));
      }
      if (provider.cwd !== undefined) {
        provider.cwd = addInput(`provider_${providerName}_cwd`, "directory", `Recipient working directory for ${providerName}`);
      }
      const providerPath = `var_providers/${providerName}.json`;
      await mkdir(dirname(join(out, providerPath)), { recursive: true });
      await writeFile(join(out, providerPath), JSON.stringify(provider, null, 2) + "\n");
      emittedProviders[providerName] = providerPath;
      files.push(providerPath);
    }
    const path = `vars/${name}.json`;
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), JSON.stringify(variable, null, 2) + "\n");
    emittedVars[name] = path;
    files.push(path);
  }
  if (Object.keys(emittedVars).length) exported.vars = emittedVars;
  if (Object.keys(emittedProviders).length) exported.var_providers = emittedProviders;
  agent.vars = selectedVars.map((name) => `#vars/${name}`);
  const mcpDefinitions = record((definitions.mcp as { servers?: unknown } | undefined)?.servers
    ?? (document.data.mcp as { servers?: unknown } | undefined)?.servers ?? {}, "mcp.servers");
  const emittedMcp: Record<string, string> = {};
  for (const id of selection) {
    const match = /^mcp\/([a-z][a-z0-9_-]*)\//.exec(id);
    if (!match) continue;
    const serverName = match[1]!;
    if (emittedMcp[serverName]) continue;
    const server = structuredClone(record(mcpDefinitions[serverName], `mcp server ${serverName}`));
    if (typeof server.command === "string") {
      if (server.command.includes("/") || isAbsolute(server.command)) server.command = await includeFile(server.command,
        `assets/mcp/${serverName}/command-${basename(server.command)}`)
          ?? addInput(`mcp_${serverName}_command`, "file", `Recipient MCP executable for ${serverName}`);
      else prerequisites.add(server.command);
    }
    if (typeof server.url === "string") server.url = addInput(`mcp_${serverName}_url`, "string", `Recipient MCP endpoint for ${serverName}`);
    if (Array.isArray(server.args)) server.args = await Promise.all(server.args.map(async (arg, index) => typeof arg === "string" && (arg.startsWith("./") || isAbsolute(arg))
      ? await includeFile(arg, `assets/mcp/${serverName}/arg-${index}-${basename(arg)}`)
        ?? addInput(`mcp_${serverName}_arg_${index}`, "file", `Recipient MCP argument file ${index} for ${serverName}`) : arg));
    for (const key of ["env", "headers"] as const) if (server[key] !== undefined) {
      const entries = record(server[key], `mcp ${serverName}.${key}`);
      server[key] = Object.fromEntries(Object.keys(entries).map((name) => [name,
        addInput(`mcp_${serverName}_${key}_${name.toLowerCase()}`, "string", `Recipient ${key} ${name} for ${serverName}`)]));
    }
    const path = `mcp/${serverName}.json`;
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), JSON.stringify(server, null, 2) + "\n");
    emittedMcp[serverName] = path;
    files.push(path);
  }
  if (Object.keys(emittedMcp).length) exported.mcp = emittedMcp;
  const agentPath = `agents/${options.agentName}.json`;
  await mkdir(dirname(join(out, agentPath)), { recursive: true });
  await writeFile(join(out, agentPath), JSON.stringify(agent, null, 2) + "\n");
  files.push(agentPath);
  const manifest: RawPackageManifest = { schema_version: 1, name: options.name, version: options.version,
    description: `Exported agent ${options.agentName}`, files, exports: exported,
    ...(inputRequired.length ? { inputs: { type: "object", properties: inputProperties, required: inputRequired } } : {}),
    requires: ["raw.agent/1", "raw.tool-api/1", "raw.skill/1"],
    ...(prerequisites.size ? { metadata: { external_executables: [...prerequisites].sort() } } : {}) };
  await writeFile(join(out, "raw-package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const report = await inspectPackage(out);
  return { root: out, report: { ...report, agent: options.agentName, unresolved } };
}
