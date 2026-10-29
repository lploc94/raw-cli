import type { RuntimeConfig } from "../config.js";
import { AcpBackendProvider } from "./acp-agent.js";
import { findExecutable } from "./adapters.js";
import { AGY_MISSING, agyCatalog, agyDefaultModel } from "./agy.js";
import { claudeLaunch } from "./claude.js";
import { codexLaunch } from "./codex.js";
import { offeredFromAgyCatalog, type BackendOffered } from "./options.js";

/** What the dashboard shows before a session runs: the options, and a warning when the CLI could not be asked. */
export interface BackendDiscovery { offered: BackendOffered; warning?: string }

/** How long a discovery may take; the dashboard shows no controls, and sending stays possible, past it. */
const DISCOVERY_MS = 30_000;
const found = new Map<string, Promise<BackendDiscovery>>();

/**
 * What the agent's backend offers for model, effort and mode, asked once per dashboard process and agent setup (a
 * throwaway conversation for Claude Code and Codex, `agy models` for agy). Display only: the runner checks a chosen value
 * in the session at turn time (Fixed decision 6). A discovery that fails is not kept, so the next request asks again.
 */
export function discoverBackendOptions(runtime: RuntimeConfig, cwd: string, env: NodeJS.ProcessEnv): Promise<BackendDiscovery> {
  const spec = runtime.backend!;
  const key = JSON.stringify([runtime.configPath, runtime.agentName, spec, runtime.systemPrompt ?? null, env.PATH ?? ""]);
  let discovery = found.get(key);
  if (!discovery) {
    discovery = discover(runtime, cwd, env).catch((error: unknown): BackendDiscovery =>
      ({ offered: {}, warning: error instanceof Error ? error.message : String(error) }));
    found.set(key, discovery);
    void discovery.then((result) => { if (result.warning && found.get(key) === discovery) found.delete(key); });
  }
  return discovery;
}

async function discover(runtime: RuntimeConfig, cwd: string, env: NodeJS.ProcessEnv): Promise<BackendDiscovery> {
  const spec = runtime.backend!;
  const current = { ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}), ...(spec.mode ? { mode: spec.mode } : {}) };
  if (spec.kind === "agy") {
    const executable = findExecutable(spec.executable ?? "agy", env, cwd);
    if (!executable) throw new Error(`agy is not available: ${AGY_MISSING}`);
    const catalog = await agyCatalog(executable, env, DISCOVERY_MS);
    const offered = offeredFromAgyCatalog(catalog, current, agyDefaultModel(env));
    return catalog ? { offered } : { offered, warning: "agy models could not be read; models and efforts are not listed" };
  }
  const launch = spec.kind === "claude" ? claudeLaunch(runtime, cwd, { env }) : codexLaunch(runtime, cwd, { env });
  const provider = new AcpBackendProvider({ agentName: runtime.agentName ?? spec.kind, spec, cwd, launch, autoApprove: false,
    ...(runtime.systemPrompt !== undefined ? { systemPrompt: runtime.systemPrompt } : {}), diagnostic: () => {} });
  const { offered, notices } = await provider.discover(DISCOVERY_MS);
  return { offered, ...(notices.length ? { warning: notices.join("\n") } : {}) };
}
