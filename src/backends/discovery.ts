import type { RuntimeConfig } from "../config.js";
import { AcpBackendProvider, type AcpLaunchResolver } from "./acp-agent.js";
import { findExecutable } from "./adapters.js";
import { BACKEND_LABELS } from "./config.js";
import { AGY_MISSING, agyCatalog, agyDefaultModel } from "./agy.js";
import { claudeLaunch } from "./claude.js";
import { codexLaunch } from "./codex.js";
import { offeredFromAgyCatalog, type BackendOffered } from "./options.js";

/** What the dashboard shows before a session runs: the options, and a warning when the CLI could not be asked. */
export interface BackendDiscovery { offered: BackendOffered; warning?: string }

const found = new Map<string, Promise<BackendDiscovery>>();

/**
 * What the agent's backend offers for model, effort and mode, asked once per dashboard process and agent setup (a
 * throwaway conversation for Claude Code and Codex, `agy models` for agy). Display only: the runner checks a chosen value
 * in the session at turn time (Fixed decision 6). A discovery that fails is not kept, so the next request asks again.
 * It runs within the agent's `request_timeout_ms`, the adapter's install included, and stops when `signal` aborts (the
 * dashboard closing); it settles once what it started has exited.
 */
export function discoverBackendOptions(runtime: RuntimeConfig, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<BackendDiscovery> {
  const spec = runtime.backend!;
  const key = JSON.stringify([runtime.configPath, runtime.agentName, spec, runtime.systemPrompt ?? null, env.PATH ?? ""]);
  let discovery = found.get(key);
  if (!discovery) {
    discovery = discover(runtime, cwd, env, signal).catch((error: unknown): BackendDiscovery =>
      ({ offered: {}, warning: error instanceof Error ? error.message : String(error) }));
    found.set(key, discovery);
    void discovery.then((result) => { if (result.warning && found.get(key) === discovery) found.delete(key); });
  }
  return discovery;
}

async function discover(runtime: RuntimeConfig, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<BackendDiscovery> {
  const spec = runtime.backend!;
  const ms = runtime.requestTimeoutMs;
  const deadline = AbortSignal.timeout(ms);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const late = `the CLI did not answer within ${ms} ms (request_timeout_ms); models and efforts are not listed`;
  const current = { ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}), ...(spec.mode ? { mode: spec.mode } : {}) };
  if (spec.kind === "agy") {
    const executable = findExecutable(spec.executable ?? "agy", env, cwd);
    if (!executable) throw new Error(`agy is not available: ${AGY_MISSING}`);
    const catalog = await agyCatalog(executable, env, ms, stop);
    const offered = offeredFromAgyCatalog(catalog, current, agyDefaultModel(env), current.model);
    if (catalog) return { offered };
    return { offered, warning: deadline.aborted ? `agy: ${late}` : "agy models could not be read; models and efforts are not listed" };
  }
  const resolve = spec.kind === "claude" ? claudeLaunch(runtime, cwd, { env }) : codexLaunch(runtime, cwd, { env });
  // The install a cancelled discovery leaves behind is awaited too, so nothing it started outlives the discovery.
  let building: Promise<unknown> | undefined;
  const launch: AcpLaunchResolver = (context) => { const started = resolve(context); building = started; return started; };
  const provider = new AcpBackendProvider({ agentName: runtime.agentName ?? spec.kind, spec, cwd, launch, autoApprove: false,
    ...(runtime.systemPrompt !== undefined ? { systemPrompt: runtime.systemPrompt } : {}), diagnostic: () => {} });
  try {
    const { offered, notices } = await provider.discover(ms, stop);
    return { offered, ...(notices.length ? { warning: notices.join("\n") } : {}) };
  } catch (error) {
    if (deadline.aborted) throw new Error(`${BACKEND_LABELS[spec.kind]}: ${late}`);
    throw error;
  } finally { await building?.catch(() => {}); }
}
