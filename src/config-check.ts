import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "./backends/adapters.js";
import { classifyForBackend } from "./backends/compat.js";
import { BACKEND_LABELS } from "./backends/config.js";
import { loadConfig, missingCredentialEnv, parseConfigSource, readConfigDocumentRoot, redact, type LoadConfigOptions } from "./config.js";

export interface AgentCheck {
  name: string;
  /** `alias (method)`, from the agent's `model`. */
  runsOn: string;
  /** What a run degrades on: settings a CLI skips, a CLI that is not installed, a missing API key. */
  warnings: string[];
  /** What makes loading this agent fail, the same rule every run applies. */
  error?: string;
}

export interface ConfigCheckReport {
  /** A document error: no agent can load, so no agent is reported. */
  errors: string[];
  agents: AgentCheck[];
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Check a config as a run would load it, without running anything: no model request, MCP server, CLI or package write.
 * `options.configSource` checks that text in the active config's place. Each agent is loaded alone from a document that
 * holds only it, so one broken agent does not hide the others (loading validates every agent of the document it gets).
 */
export async function checkConfig(options: LoadConfigOptions = {}): Promise<ConfigCheckReport> {
  const env = options.env ?? process.env;
  let data: Record<string, unknown>;
  let agents: Record<string, unknown>;
  try {
    data = readConfigDocumentRoot(options).data;
    if (data.agents !== undefined && !isObject(data.agents)) throw new Error("agents must be an object");
    agents = (data.agents ?? {}) as Record<string, unknown>;
    // Every section but agents, checked once for all of them.
    const { default_agent: _default, ...rest } = data;
    parseConfigSource(JSON.stringify({ ...rest, agents: {} }), options, true);
    if (data.default_agent !== undefined && (typeof data.default_agent !== "string" || !Object.hasOwn(agents, data.default_agent))) {
      throw new Error(`unknown agent: ${String(data.default_agent)}`);
    }
  } catch (error) { return { errors: [message(error)], agents: [] }; }
  const models = isObject(data.models) ? data.models : {};
  const scratch = await mkdtemp(join(tmpdir(), "raw-check-"));
  try {
    const report: ConfigCheckReport = { errors: [], agents: [] };
    for (const [name, agent] of Object.entries(agents)) {
      const alias = isObject(agent) && typeof agent.model === "string" ? agent.model : undefined;
      const model = alias !== undefined && Object.hasOwn(models, alias) && isObject(models[alias]) ? models[alias] : undefined;
      const check: AgentCheck = { name, runsOn: alias === undefined ? "?" : `${alias} (${String(model?.method ?? "?")})`, warnings: [] };
      report.agents.push(check);
      try {
        const runtime = await loadConfig({ ...options, configSource: JSON.stringify({ ...data, agents: { [name]: agent }, default_agent: name }),
          flags: { ...options.flags, agent: name }, requireModel: false, packageScratchDir: scratch });
        if (runtime.backend) {
          check.warnings.push(...classifyForBackend(runtime).warnings);
          const command = runtime.backend.executable ?? runtime.backend.kind;
          if (!findExecutable(command, env, options.cwd ?? process.cwd())) {
            check.warnings.push(`${BACKEND_LABELS[runtime.backend.kind]} is not installed (looked for ${command}${/[\\/]/.test(command) ? "" : " on PATH"})`);
          }
        } else if (runtime.modelConfig) {
          const missing = missingCredentialEnv(runtime.modelConfig, env);
          if (missing) check.warnings.push(`no API key: set ${missing}, or api_key or api_key_env on model ${runtime.modelConfig.modelAlias}`);
        }
      } catch (error) { check.error = message(error); }
    }
    return report;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** The report as `raw config check` prints it, and its exit code: 1 when anything errors, warnings alone keep 0. */
export function formatConfigCheck(report: ConfigCheckReport): { text: string; exitCode: number } {
  const width = Math.max(8, ...report.agents.map((agent) => agent.name.length + 2));
  const lines = report.errors.map((error) => `${"error".padEnd(8)}${"config".padEnd(width)}${redact(error)}`);
  for (const agent of report.agents) {
    lines.push(`${(agent.error ? "error" : "ok").padEnd(8)}${agent.name.padEnd(width)}${redact(agent.error ?? agent.runsOn)}`);
    for (const warning of agent.warnings) lines.push(`        warning: ${redact(warning)}`);
  }
  const errors = report.errors.length + report.agents.filter((agent) => agent.error).length;
  const warnings = report.agents.reduce((sum, agent) => sum + agent.warnings.length, 0);
  lines.push(`${report.agents.length} agents, ${errors} errors, ${warnings} warnings`);
  return { text: `${lines.join("\n")}\n`, exitCode: errors ? 1 : 0 };
}
