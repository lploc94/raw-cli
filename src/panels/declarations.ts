import type { RuntimeConfig } from "../config.js";
import { readToolManifests } from "../tools/plugins/loader.js";
import type { PanelDeclaration } from "./contract.js";
import { panelWarning } from "./validate.js";

export interface KnownPanel { owner: string; declaration: PanelDeclaration }

/** What the agent knows before any tool runs (docs/panels-design.md §13.1). */
export interface KnownPanels {
  /** Declared panels in the default order: `tool.json` panels first, then config MCP panels. */
  declared: KnownPanel[];
  /** Selected owners without declarations for their panels: MCP tools without config panels and ACP tools without `panels`. */
  implicitOwners: string[];
  /** Set by hosts that know the agent's tool policy: true when a `deny` rule hides this owner's tool actions (§11). */
  denied?: (owner: string) => boolean;
}

/** A tool registered by an ACP client for the current session; the runtime cannot know it from config. */
export interface KnownAcpTool { owner: string; declarations: readonly PanelDeclaration[] }

/**
 * The panel declarations of everything the agent selects. Only manifests and config are read: no tool entry is imported
 * and no MCP server is started. Order, per §13.1: (1) `tool.json` panels by the owner's position in `tools.use`, then the
 * `panels` order; (2) config MCP panels by the server's position in the selection, then the server's `panels` order.
 * Only one panel per agent keeps `acp_plan`; later ones are cleared with a warning.
 */
export async function knownPanelDeclarations(runtime: Pick<RuntimeConfig, "toolIds" | "configPath" | "globalConfigRoot" | "packageTools"
  | "availableMcpServers" | "packageMcpIdentities">, options: { cwd?: string; env?: NodeJS.ProcessEnv; onWarning?: (message: string) => void;
  acp?: readonly KnownAcpTool[] } = {}): Promise<KnownPanels> {
  const warn = options.onWarning ?? panelWarning;
  const local = runtime.toolIds.filter((id) => !id.startsWith("mcp/"));
  const manifests = new Map((await readToolManifests({ selectedIds: local, configPath: runtime.configPath,
    globalConfigRoot: runtime.globalConfigRoot, packageTools: runtime.packageTools, onWarning: warn,
    ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) }))
    .map((item) => [item.id, item.manifest] as const));
  const declared: KnownPanel[] = [];
  const implicitOwners: string[] = [];
  for (const id of local) {
    const owner = runtime.packageTools[id]?.canonicalIdentity ?? id;
    for (const declaration of manifests.get(id)?.panels ?? []) declared.push({ owner, declaration });
  }
  const servers: string[] = [];
  for (const id of runtime.toolIds) {
    if (!id.startsWith("mcp/")) continue;
    const server = id.split("/")[1];
    if (server && !servers.includes(server)) servers.push(server);
  }
  const selected = new Set(runtime.toolIds);
  const withDeclarations = new Set<string>();
  for (const server of servers) {
    const identity = runtime.packageMcpIdentities[server];
    for (const panel of runtime.availableMcpServers[server]?.panels ?? []) {
      if (!selected.has(`mcp/${server}/${panel.tool}`)) continue;
      const { tool, ...declaration } = panel;
      const owner = identity ? `${identity}/${tool}` : `mcp/${server}/${tool}`;
      withDeclarations.add(owner);
      declared.push({ owner, declaration });
    }
  }
  for (const id of runtime.toolIds) {
    if (!id.startsWith("mcp/")) continue;
    const [, server, tool] = id.split("/");
    if (!server || !tool) continue;
    const identity = runtime.packageMcpIdentities[server];
    const owner = identity ? `${identity}/${tool}` : id;
    if (!withDeclarations.has(owner)) implicitOwners.push(owner);
  }
  for (const tool of options.acp ?? []) {
    if (tool.declarations.length) for (const declaration of tool.declarations) declared.push({ owner: tool.owner, declaration });
    else implicitOwners.push(tool.owner);
  }
  let planOwner: string | undefined;
  const reconciled = declared.map(({ owner, declaration }) => {
    if (!declaration.acp_plan) return { owner, declaration };
    if (planOwner === undefined) { planOwner = `${owner}#${declaration.id}`; return { owner, declaration }; }
    warn(`panel ${owner}#${declaration.id}: acp_plan ignored, ${planOwner} already mirrors the ACP plan`);
    return { owner, declaration: { ...declaration, acp_plan: false } };
  });
  return { declared: reconciled, implicitOwners };
}

/**
 * A stored panel is stale when its owner is no longer selected by the agent (or, for an ACP owner, no longer registered
 * in this session) or its declaration no longer lists the panel id. Implicit owners are never stale while selected.
 */
export function isStalePanel(panelId: string, known: KnownPanels): boolean {
  const hash = panelId.lastIndexOf("#");
  const owner = panelId.slice(0, hash);
  if (known.implicitOwners.includes(owner)) return false;
  const local = panelId.slice(hash + 1);
  return !known.declared.some((item) => item.owner === owner && item.declaration.id === local);
}
