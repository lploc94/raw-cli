import { mutateConfig, type ConfigEditOptions } from "./config.js";
import { ManagementError } from "./files.js";

export type ResourceEdit = { action: "create"; name: string; value: Record<string, unknown> }
  | { action: "patch"; name: string; value: Record<string, unknown> }
  | { action: "duplicate"; name: string; newName: string }
  | { action: "rename"; name: string; newName: string }
  | { action: "delete"; name: string }
  | { action: "default"; name: string };
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validName(name: string): void {
  if (typeof name !== "string" || !name.trim()) throw new ManagementError("invalid_input", "name must be a nonempty string");
}

export function editAgent(options: ConfigEditOptions, edit: ResourceEdit) {
  return mutateConfig(options, (data) => {
    validName(edit.name); const agents = Object.assign(Object.create(null) as Record<string, unknown>, record(data.agents)); data.agents = agents;
    const exists = Object.hasOwn(agents, edit.name);
    if (edit.action === "create") {
      if (exists) throw new ManagementError("conflict", "agent already exists");
      agents[edit.name] = structuredClone(edit.value); return;
    }
    if (!exists) throw new ManagementError("not_found", "agent not found");
    if (edit.action === "default") { data.default_agent = edit.name; return; }
    if (edit.action === "delete") {
      if (data.default_agent === edit.name) throw new ManagementError("in_use", "select a replacement default agent first");
      delete agents[edit.name]; return;
    }
    if (edit.action === "rename" || edit.action === "duplicate") {
      validName(edit.newName); if (Object.hasOwn(agents, edit.newName)) throw new ManagementError("conflict", "agent already exists");
      agents[edit.newName] = structuredClone(agents[edit.name]);
      if (edit.action === "rename") { delete agents[edit.name]; if (data.default_agent === edit.name) data.default_agent = edit.newName; }
      return;
    }
    const current = record(agents[edit.name]);
    agents[edit.name] = patchRecord(current, edit.value);
    const patched = agents[edit.name] as Record<string, unknown>;
    // Setting one prompt source drops the other; a null only removes its own key.
    if (edit.value.system_prompt != null) delete patched.system_prompt_file;
    if (edit.value.system_prompt_file != null) delete patched.system_prompt;
  });
}
export function patchRecord(current: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const result = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete result[key]; else Object.defineProperty(result, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
export function editModel(options: ConfigEditOptions, edit: ResourceEdit) {
  return mutateConfig(options, (data) => {
    validName(edit.name); const models = Object.assign(Object.create(null) as Record<string, unknown>, record(data.models)); data.models = models;
    if (edit.action === "default") throw new ManagementError("invalid_input", "models have no default; select a default agent");
    if (edit.action === "create") {
      if (Object.hasOwn(models, edit.name)) throw new ManagementError("conflict", "model already exists");
      models[edit.name] = structuredClone(edit.value); return;
    }
    if (!Object.hasOwn(models, edit.name)) throw new ManagementError("not_found", "model not found");
    if (edit.action === "patch") { models[edit.name] = patchRecord(record(models[edit.name]), edit.value); return; }
    const used = Object.values(record(data.agents)).filter((agent) => record(agent).model === edit.name);
    if (edit.action === "delete") {
      if (used.length) throw new ManagementError("in_use", "model is used by agents; change their model first");
      delete models[edit.name]; return;
    }
    validName(edit.newName); if (Object.hasOwn(models, edit.newName)) throw new ManagementError("conflict", "model already exists");
    models[edit.newName] = structuredClone(models[edit.name]);
    if (edit.action === "rename") { delete models[edit.name]; for (const agent of used) record(agent).model = edit.newName; }
  });
}
