import type { RuntimeConfig } from "../../config.js";
import { connectMcpServers, type McpConnection, type McpServerConfig } from "../mcp-client.js";
import { ToolRegistry } from "../registry.js";
import { loadToolPlugins } from "./loader.js";

export interface RuntimeTools {
  registry: ToolRegistry;
  mcp: McpConnection;
  selectedNames: readonly string[];
}

export async function createRuntimeTools(options: {
  runtime: RuntimeConfig;
  cwd: string;
  signal?: AbortSignal;
  discoverableMcp?: Readonly<Record<string, McpServerConfig>>;
}): Promise<RuntimeTools> {
  const { runtime, cwd, signal } = options;
  if (signal?.aborted) throw new Error("tool startup aborted");
  if (runtime.toolIds.includes("builtin/view_image") && runtime.profile?.vision !== true) {
    throw new Error("builtin/view_image requires a vision model");
  }
  const localIds = runtime.toolIds.filter((id) => !id.startsWith("mcp/"));
  const plugins = await loadToolPlugins({ selectedIds: localIds, configPath: runtime.configPath, cwd });
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
    return { registry, mcp, selectedNames: Object.freeze(names) };
  } catch (error) { await mcp.close(); throw error; }
}
