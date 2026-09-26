import { randomUUID } from "node:crypto";
import { canonicalConfigPath, loadMcpCheckConfig, loadVariableConfigAsync, parseConfigSource, parseToolPolicyRules } from "../config.js";
import { editAgent, editModel, patchRecord, record, type ResourceEdit } from "../management/agents.js";
import { initializeConfig, mutateConfig, readManagedConfig, saveConfigText, type ManagedConfig } from "../management/config.js";
import { ComponentManager, type EditableComponentKind } from "../management/components.js";
import { assertRevision, ManagementError } from "../management/files.js";
import { connectMcpServers } from "../tools/mcp-client.js";
import { ToolRegistry } from "../tools/registry.js";
import { createVariableResolver } from "../vars/resolver.js";
import { DashboardError, textField } from "./errors.js";
import type { DashboardContext, DashboardRoute } from "./server.js";

export interface ConfigView {
  path: string; canonicalPath: string; canonical: boolean; revision: string; exists: boolean; valid: boolean; diagnostic?: string;
  defaultAgent?: string; agents: string[]; models: string[]; vars: string[]; providers: string[]; mcp: string[];
  sessions?: unknown;
}
export interface CheckView {
  id: string; kind: "var" | "mcp"; name: string; agent: string; state: "running" | "completed" | "error" | "cancelled";
  startedAt: string; finishedAt?: string; result?: unknown; error?: string;
}
export function managementInput(value: unknown, label = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DashboardError(400, "invalid_input", `${label} must be an object`);
  return value as Record<string, unknown>;
}
export const revisionField = (body: Record<string, unknown>) => textField(body.revision, "revision", 128);
export async function managementAction<T>(work: () => Promise<T> | T): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof DashboardError || error instanceof ManagementError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DashboardError(404, "not_found", "Source file or component not found");
    throw new DashboardError(422, "invalid_input", error instanceof Error ? error.message : String(error));
  }
}
export function createManagementRoutes(context: DashboardContext): DashboardRoute[] {
  const options = { cwd: context.cwd, configPath: context.configPath, env: context.env };
  const components = new ComponentManager(options);
  const view = (config: ManagedConfig): ConfigView => ({ path: config.path, canonicalPath: canonicalConfigPath(options), canonical: config.canonical,
    revision: config.revision, exists: config.exists, valid: !!config.data, ...(config.diagnostic ? { diagnostic: config.diagnostic } : {}),
    ...(typeof config.data?.default_agent === "string" ? { defaultAgent: config.data.default_agent } : {}),
    agents: Object.keys(record(config.data?.agents)), models: Object.keys(record(config.data?.models)), vars: Object.keys(record(config.data?.vars)),
    providers: Object.keys(record(config.data?.var_providers)), mcp: Object.keys(record(record(config.data?.mcp).servers)),
    ...(config.data?.sessions === undefined ? {} : { sessions: config.data.sessions }) });
  let preparingChecks = 0;
  const checks = new Map<string, { row: CheckView; controller: AbortController; done: Promise<void> }>();
  const sweep = () => {
    for (const [id, check] of checks) if (check.row.finishedAt && Date.now() - Date.parse(check.row.finishedAt) > 300_000) checks.delete(id);
    if (checks.size >= 100) for (const [id, check] of checks) if (check.row.state !== "running") { checks.delete(id); break; }
  };
  context.onClose(async () => { for (const check of checks.values()) check.controller.abort(); await Promise.allSettled([...checks.values()].map(c => c.done)); checks.clear(); });
  const startCheck = async (body: Record<string, unknown>): Promise<CheckView> => {
    const config = await readManagedConfig(options); assertRevision(revisionField(body), config);
    if (body.kind !== "var" && body.kind !== "mcp") throw new DashboardError(400, "invalid_input", "kind must be var or mcp");
    const agent = textField(body.agent, "agent"), name = textField(body.name, "name");
    if (!Object.hasOwn(record(config.data?.agents), agent)) throw new DashboardError(422, "invalid_input", "Select an existing agent for this check");
    sweep(); if (preparingChecks + [...checks.values()].filter(c => c.row.state === "running").length >= 8) throw new DashboardError(409, "busy", "Eight checks are already running");
    const row: CheckView = { id: randomUUID(), kind: body.kind, agent, name, state: "running", startedAt: new Date().toISOString() };
    const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, context.signal, AbortSignal.timeout(30_000)]);
    preparingChecks++;
    try {
    // Capture validated definitions before acknowledging. Checks own that snapshot even if config changes later.
    const variableConfig = row.kind === "var" ? await loadVariableConfigAsync({ ...options, flags: { agent } }) : undefined;
    const mcp = row.kind === "mcp" ? await loadMcpCheckConfig({ ...options, flags: { agent } }, name) : undefined;
    assertRevision(config.revision, await readManagedConfig(options));
    const done = (async () => {
      try {
        if (variableConfig) row.result = await createVariableResolver({ config: variableConfig, env: context.env }).read(name, { signal });
        else if (mcp) {
          const connection = await connectMcpServers({ servers: { [name]: { ...mcp.server, tools: "*" } },
            cwd: context.cwd, signal, timeoutMs: 30_000, canonicalIdentities: mcp.identity ? { [name]: mcp.identity } : {} });
          try { row.result = { tools: connection.catalog.map(tool => ({ ...tool,
            identity: connection.registry.canonicalIdentity(tool.alias), definition: connection.registry.definitions().find(def => def.name === tool.alias) })) }; }
          finally { await connection.close(); }
        }
        if (signal.aborted) { delete row.result; row.state = "cancelled"; }
        else if (Buffer.byteLength(JSON.stringify(row.result)) > 1024 * 1024) { delete row.result; row.state = "error"; row.error = "Check result exceeds 1 MiB"; }
        else row.state = "completed";
      } catch (error) { row.state = signal.aborted ? "cancelled" : "error"; row.error = error instanceof Error ? error.message : String(error); }
      finally { row.finishedAt = new Date().toISOString(); }
    })();
    checks.set(row.id, { row, controller, done }); return structuredClone(row);
    } finally { preparingChecks--; }
  };
  return [async (request, response) => {
    const url = new URL(request.url!, "http://localhost"); const path = url.pathname; const method = request.method;
    if (!/^\/api\/(?:config|agents|models|components|policy|checks|diagnostics)(?:\/|$)/.test(path)) return false;
    return managementAction(async () => {
      const send = (value: unknown, status = 200) => { context.json(response, status, value); return true; };
      if (path === "/api/config" && method === "GET") return send(view(await readManagedConfig(options)));
      if (path === "/api/config/initialize" && method === "POST") return send(view(await initializeConfig(options)), 201);
      if (path === "/api/config/document" && method === "GET") {
        const { data: _data, ...document } = await readManagedConfig(options); return send(document);
      }
      if (path === "/api/config/document" && method === "PUT") {
        const body = await context.readJson(request); if (typeof body.source !== "string") throw new DashboardError(400, "invalid_input", "source must be text");
        return send(view(await saveConfigText({ ...options, expectedRevision: revisionField(body) }, body.source)));
      }
      if (path === "/api/config/validate" && method === "POST") {
        const body = await context.readJson(request); if (typeof body.source !== "string") throw new DashboardError(400, "invalid_input", "source must be text");
        parseConfigSource(body.source, options); return send({ valid: true, level: "static" });
      }
      if (path === "/api/config" && method === "PATCH") {
        const body = await context.readJson(request), patch = managementInput(body.patch, "patch");
        return send(view(await mutateConfig({ ...options, expectedRevision: revisionField(body) }, data => {
          const next = patchRecord(data, patch); for (const key of Object.keys(data)) delete data[key]; Object.assign(data, next);
        })));
      }
      const resource = /^\/api\/(agents|models)(?:\/([^/]+))?$/.exec(path);
      if (resource) {
        const kind = resource[1] as "agents" | "models";
        if (method === "GET" && resource[2]) {
          const config = await readManagedConfig(options); const name = decodeURIComponent(resource[2]);
          const resources = record(config.data?.[kind]);
          if (!Object.hasOwn(resources, name)) throw new DashboardError(404, "not_found", `${kind} entry not found`);
          const value = structuredClone(record(resources[name]));
          if (kind === "agents") return send({ value, revision: config.revision });
          const credential = { present: typeof value.api_key === "string", ...(typeof value.api_key_env === "string" ? { env: value.api_key_env } : {}) };
          delete value.api_key; delete value.api_key_env; return send({ value, revision: config.revision, credential });
        }
        if (method === "POST" && !resource[2]) {
          const body = await context.readJson(request), name = textField(body.name, "name"), action = body.action;
          if (!["create", "patch", "duplicate", "rename", "delete", "default"].includes(String(action))) throw new DashboardError(400, "invalid_input", "Invalid resource action");
          const edit: Record<string, unknown> = { action, name };
          if (action === "create" || action === "patch") {
            edit.value = structuredClone(managementInput(body.value)); const value = edit.value as Record<string, unknown>;
            if (kind === "models") {
              if (Object.hasOwn(value, "api_key") || Object.hasOwn(value, "api_key_env")) throw new DashboardError(400, "invalid_input", "Use a credential keep/set/clear operation");
              const credential = body.credential === undefined ? { mode: "keep" } : managementInput(body.credential, "credential");
              if (credential.mode === "set") {
                const env = credential.env !== undefined; const selected = textField(env ? credential.env : credential.value, "credential", 16384);
                value.api_key = env ? null : selected; value.api_key_env = env ? selected : null;
              } else if (credential.mode === "clear") { value.api_key = null; value.api_key_env = null; }
              else if (credential.mode !== "keep") throw new DashboardError(400, "invalid_input", "credential.mode must be keep, set or clear");
              if (action === "create") { if (value.api_key === null) delete value.api_key; if (value.api_key_env === null) delete value.api_key_env; }
            }
          }
          if (action === "rename" || action === "duplicate") edit.newName = textField(body.newName, "newName");
          return send(view(await (kind === "agents" ? editAgent : editModel)({ ...options, expectedRevision: revisionField(body) }, edit as ResourceEdit)));
        }
      }
      const component = /^\/api\/components\/(tools|skills)(?:\/([^/]+)(?:\/(file|selection))?)?$/.exec(path);
      if (component) {
        const kind = component[1] as EditableComponentKind, id = component[2] ? decodeURIComponent(component[2]) : undefined;
        if (method === "GET" && !id) return send(await components.list(kind));
        if (method === "GET" && id && !component[3]) return send(await components.inspect(kind, id));
        if (id && component[3] === "file") {
          const file = textField(url.searchParams.get("path"), "path");
          if (method === "GET") return send(await components.readFile(kind, id, file));
          if (method === "PUT") {
            const body = await context.readJson(request); if (typeof body.source !== "string") throw new DashboardError(400, "invalid_input", "source must be text");
            return send(await components.saveFile(kind, id, file, revisionField(body), body.source));
          }
        }
        if (method === "POST" && !id) {
          const body = await context.readJson(request), newId = textField(body.id, "id");
          if (body.cloneFrom !== undefined) return send(await components.clone(kind, textField(body.cloneFrom, "cloneFrom"), newId), 201);
          const files = managementInput(body.files, "files");
          if (Object.values(files).some(v => typeof v !== "string")) throw new DashboardError(400, "invalid_input", "files must contain text values");
          return send(await components.create(kind, newId, files as Record<string, string>), 201);
        }
        if (method === "POST" && id && component[3] === "selection") {
          const body = await context.readJson(request); if (typeof body.selected !== "boolean") throw new DashboardError(400, "invalid_input", "selected must be boolean");
          return send(view(await components.attach(kind, id, textField(body.agent, "agent"), revisionField(body), body.selected)));
        }
        if (method === "DELETE" && id && !component[3]) { await components.remove(kind, id); return send({ removed: true }); }
      }
      if (path === "/api/policy/test" && method === "POST") {
        const body = await context.readJson(request); const identity = textField(body.identity, "identity"); const args = managementInput(body.args, "args");
        if (!Array.isArray(body.rules)) throw new DashboardError(400, "invalid_input", "rules must be an array");
        const registry = new ToolRegistry(parseToolPolicyRules(body.rules));
        const exposed = registry.policyEffect(identity) !== "deny";
        return send({ effect: exposed ? registry.policyEffect(identity, args) : "deny", exposed, level: "sample; no tool dispatch or schema binding" });
      }
      if (path === "/api/checks" && method === "POST") return send(await startCheck(await context.readJson(request)), 202);
      const check = /^\/api\/checks\/([^/]+)(\/cancel)?$/.exec(path);
      if (check && (method === "GET" && !check[2] || method === "POST" && check[2])) {
        sweep(); const entry = checks.get(check[1]!); if (!entry) throw new DashboardError(404, "not_found", "Check expired or belongs to a previous dashboard process");
        if (method === "POST") entry.controller.abort(); return send(entry.row);
      }
      if (path === "/api/diagnostics" && method === "GET") {
        const config = await readManagedConfig(options);
        return send({ apiVersion: 1, node: process.version, platform: process.platform, architecture: process.arch,
          config: { path: config.path, exists: config.exists, valid: !!config.data, canonical: config.canonical,
            agents: Object.keys(record(config.data?.agents)).length, models: Object.keys(record(config.data?.models)).length },
          store: { available: !!context.store, listedRecentSessions: context.store?.listSessions({ limit: 100 }).items.length ?? null,
            countLimit: 100 }, listener: "127.0.0.1", restart: "Change port/config with raw dashboard startup flags" });
      }
      return false;
    });
  }];
}
