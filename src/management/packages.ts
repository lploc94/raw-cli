import { dirname } from "node:path";
import { validateEffectiveConfigData } from "../config.js";
import { createPackageResolutionContext, resolvePackageDefinition, resolvePackageDefinitions, resolvePackageSelections } from "../packages/resolve-agent.js";
import { parseComponentReference } from "../packages/references.js";
import { parseVariableDefinitions } from "../vars/config.js";
import { record } from "./agents.js";
import { mutateConfig, type ConfigEditOptions } from "./config.js";
import { ComponentManager } from "./components.js";
import { ManagementError } from "./files.js";

export interface AttachPackageComponent { from: string; agent?: string; name?: string; inputs?: Record<string, unknown>; as?: string }
export async function attachPackageComponent(options: ConfigEditOptions & { configPath: string }, edit: AttachPackageComponent) {
  const ref = parseComponentReference(edit.from);
  if (ref.source !== "installed" || ref.kind === "agents") throw new ManagementError("invalid_input", "Choose an installed component export");
  return mutateConfig(options, async data => {
    const agents = record(data.agents), agentName = edit.agent;
    const selected = agentName ? record(agents[agentName]) : undefined;
    if (agentName && !Object.hasOwn(agents, agentName)) throw new ManagementError("not_found", "agent not found");
    if (selected?.from && ["tools", "skills", "vars"].includes(ref.kind)) throw new ManagementError("invalid_input", "Edit this package agent's complete selection override explicitly in Agent JSON");
    const context = createPackageResolutionContext();
    let probe = structuredClone(selected ?? { tools: { use: [] } });
    if (ref.kind === "tools" || ref.kind === "skills") {
      if (!selected) throw new ManagementError("invalid_input", "Choose an agent for this selection");
      const info = await new ComponentManager(options).inspect(ref.kind, edit.from);
      if (info.validation !== "valid") throw new ManagementError("invalid_input", info.diagnostic ?? "invalid component");
      if (ref.kind === "skills" && (info.bodyBytes ?? 0) > Number(selected.max_output_bytes ?? 8192)) throw new ManagementError("invalid_input", "skill body exceeds the agent's max_output_bytes");
      const block = record(selected[ref.kind]), use = Array.isArray(block.use) ? [...block.use] : [];
      if (use.some(v => (typeof v === "string" ? v : record(v).ref) === edit.from)) throw new ManagementError("conflict", "component already selected; edit its binding in Agent JSON");
      use.push(edit.as || Object.keys(edit.inputs ?? {}).length ? { ref: edit.from, ...(edit.as ? { as: edit.as } : {}), ...(edit.inputs ? { inputs: edit.inputs } : {}) } : edit.from);
      selected[ref.kind] = { ...block, use };
      if (ref.kind === "skills") { const tools = record(selected.tools); selected.tools = { ...tools, use: [...new Set([...(Array.isArray(tools.use) ? tools.use : []), "builtin/list_skills", "builtin/load_skill"])] }; }
      probe = structuredClone(selected);
    } else {
      const name = edit.name;
      if (!name || !/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) throw new ManagementError("invalid_input", "Choose a valid local binding name");
      const parent = ref.kind === "mcp" ? record(record(data.mcp).servers) : record(data[ref.kind]);
      if (Object.hasOwn(parent, name)) throw new ManagementError("conflict", "binding name already exists");
      parent[name] = { from: edit.from, ...(Object.keys(edit.inputs ?? {}).length ? { inputs: edit.inputs } : {}) };
      if (ref.kind === "mcp") data.mcp = { ...record(data.mcp), servers: parent }; else data[ref.kind] = parent;
      if (ref.kind === "vars") {
        if (selected) selected.vars = [...new Set([...(Array.isArray(selected.vars) ? selected.vars : []), name])];
        probe = { tools: { use: [] }, vars: [name] };
      } else if (ref.kind === "var_providers") {
        const definition = await resolvePackageDefinition(edit.from, edit.inputs ?? {}, options, "var_providers", context);
        parseVariableDefinitions({}, { [name]: definition.value }, dirname(options.configPath));
      }
    }
    const resolved = await resolvePackageSelections(probe, options, context);
    const { mcpIdentities: _identity, mcpSources: _sources, ...definitions } = await resolvePackageDefinitions(resolved.agent, data, options, undefined, context, undefined,
      ref.kind === "mcp" ? [edit.name!] : []);
    validateEffectiveConfigData({ ...data, ...definitions, agents: selected && (ref.kind === "tools" || ref.kind === "skills") ? { [agentName!]: resolved.agent } : {}, default_agent: undefined });
  });
}
