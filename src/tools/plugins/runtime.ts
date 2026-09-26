import { createVariableResolver } from "../../vars/resolver.js";
import type { VariableContext } from "../../vars/contract.js";
import type { RuntimeConfig } from "../../config.js";
import { connectMcpServers, type McpConnection, type McpServerConfig } from "../mcp-client.js";
import { ToolRegistry } from "../registry.js";
import { loadToolPlugins } from "./loader.js";
import { loadSelectedSkills } from "../../skills/loader.js";
import type { SelectedSkill } from "../../skills/contract.js";
import { createHash } from "node:crypto";

export interface RuntimeTools {
  vars: VariableContext;
  registry: ToolRegistry;
  mcp: McpConnection;
  selectedNames: readonly string[];
  skills: readonly SelectedSkill[];
  toolSourceDigest: string;
}

export async function createRuntimeTools(options: {
  runtime: RuntimeConfig;
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  discoverableMcp?: Readonly<Record<string, McpServerConfig>>;
}): Promise<RuntimeTools> {
  const { runtime, cwd, signal } = options;
  if (signal?.aborted) throw new Error("tool startup aborted");
  if (runtime.toolIds.includes("builtin/view_image") && runtime.modelConfig?.vision !== true) {
    throw new Error("builtin/view_image requires a vision model");
  }
  const localIds = runtime.toolIds.filter((id) => !id.startsWith("mcp/"));
  const skills = await loadSelectedSkills({ selectedIds: runtime.skillIds, configPath: runtime.configPath,
    maxOutputBytes: runtime.maxOutputBytes, cwd, globalConfigRoot: runtime.globalConfigRoot,
    packageSkills: runtime.packageSkills });
  if (runtime.toolIds.includes("builtin/list_skills")
    && Buffer.byteLength(JSON.stringify({ skills: skills.map(({ name, description }) => ({ name, description })) })) > runtime.maxOutputBytes) {
    throw new Error("selected skill catalog exceeds max_output_bytes");
  }
  const vars = createVariableResolver({ config: runtime.variableConfig, ...(options.env ? { env: options.env } : {}) });
  if (runtime.toolIds.includes("builtin/list_vars") && Buffer.byteLength(JSON.stringify({ vars: vars.list() })) > runtime.maxOutputBytes) {
    throw new Error("selected variable catalog exceeds max_output_bytes");
  }
  const plugins = await loadToolPlugins({ selectedIds: localIds, configPath: runtime.configPath, cwd, skills, vars,
    globalConfigRoot: runtime.globalConfigRoot, packageTools: runtime.packageTools });
  if (signal?.aborted) throw new Error("tool startup aborted");
  const registry = new ToolRegistry(runtime.toolRules);
  for (const plugin of plugins) registry.register(plugin.registration);
  const specs: Record<string, McpServerConfig> = Object.assign(Object.create(null), runtime.mcpServers);
  for (const [name, source] of Object.entries(options.discoverableMcp ?? {})) {
    if (Object.hasOwn(runtime.availableMcpServers, name)) throw new Error(`duplicate MCP server: ${name}`);
    const selected = runtime.toolIds.filter((id) => id.startsWith(`mcp/${name}/`)).map((id) => id.slice(`mcp/${name}/`.length));
    specs[name] = { ...source, tools: selected };
  }
  for (const id of runtime.toolIds) {
    if (id.startsWith("mcp/") && !Object.hasOwn(specs, id.split("/")[1]!)) throw new Error(`unknown MCP server: ${id.split("/")[1]}`);
  }
  const mcp = await connectMcpServers({ servers: specs, registry, cwd, timeoutMs: runtime.requestTimeoutMs,
    canonicalIdentities: runtime.packageMcpIdentities,
    ...(signal ? { signal } : {}) });
  try {
    const names: string[] = [];
    for (const id of runtime.toolIds) {
      if (id.startsWith("mcp/")) {
        const [, server, originalName] = id.split("/");
        const item = mcp.catalog.find((tool) => tool.server === server && tool.originalName === originalName);
        if (!item) throw new Error(`unknown MCP tool: ${id}`);
        names.push(item.alias);
      } else {
        names.push(plugins.find((plugin) => plugin.id === id)!.registration.name);
      }
    }
    if (new Set(names).size !== names.length) throw new Error("duplicate model-visible tool name");
    const toolSourceDigest = createHash("sha256").update(JSON.stringify(runtime.toolIds.map((id) =>
      id.startsWith("mcp/") ? { id, source: runtime.availableMcpServers[id.split("/")[1]!],
        identity: runtime.packageMcpIdentities[id.split("/")[1]!] }
        : { id: runtime.packageTools[id]?.canonicalIdentity ?? id,
          source: plugins.find((plugin) => plugin.id === id)!.sourceDigest }))).digest("hex");
    return { vars, registry, mcp, selectedNames: Object.freeze(names), skills, toolSourceDigest };
  } catch (error) { await mcp.close(); throw error; }
}
