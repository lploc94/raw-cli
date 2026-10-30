import { createAgent, type AgentOptions } from "../agent.js";
import { loadConfig, type RuntimeConfig } from "../config.js";
import { createProvider } from "../llm/client.js";
import type { ProviderAdapter } from "../llm/types.js";
import { applyRequestOverride } from "../request-controls.js";
import { createRuntimeTools, type RuntimeTools } from "../tools/plugins/runtime.js";
import { AcpBackendAgent, AcpBackendProvider, backendResidentKey, measureBackend } from "../backends/acp-agent.js";
import { createSessionAgent, type SessionAgentFactory } from "../backends/factory.js";
import type { MeasureOptions } from "./metrics.js";
import type { AttachSessionRuntime, SessionRuntime } from "./operations.js";

export function runtimeAgentOptions(runtime: RuntimeConfig, tools: RuntimeTools, provider: ProviderAdapter, cwd: string): AgentOptions {
  return { provider, registry: tools.registry, whitelist: tools.selectedNames,
    toolSourceDigest: tools.toolSourceDigest, selectedSkills: tools.skills, cwd,
    ...(tools.hooks ? { hooks: tools.hooks } : {}),
    system: runtime.systemPrompt, configPath: runtime.configPath, maxSteps: runtime.maxSteps,
    maxOutputBytes: runtime.maxOutputBytes, requestTimeoutMs: runtime.requestTimeoutMs,
    autoApprove: runtime.autoApprove, compact: runtime.compact };
}

export const attachSessionRuntime: AttachSessionRuntime = (options) => attachSessionRuntimeWith(createSessionAgent)(options);

/** The host's runtime, with `factory` building a backend agent's session (a test runs a scripted CLI through it). */
export const attachSessionRuntimeWith = (factory: SessionAgentFactory): AttachSessionRuntime => async (options) => {
  const { store, operation, owner, signal, session } = options;
  const runtime = await loadConfig({ configPath: operation.configPath, flags: { agent: operation.agentName },
    cwd: session.cwd, requireModel: true, ...(options.env ? { env: options.env } : {}) });
  if (signal.aborted) throw new Error("startup aborted");
  if (runtime.backend) return attachBackendRuntime(runtime, options, factory);
  // Raw's own loop replaces a kept CLI adapter: it is stopped, and what it leaves is recorded once the agent runs.
  const notices = [...(options.notices ?? []), ...await releaseResident(options.resident, undefined, options.carry)];
  const modelConfig = applyRequestOverride(runtime.modelConfig!, options.request ?? {});
  const provider = createProvider(modelConfig);
  const tools = await createRuntimeTools({ runtime, cwd: session.cwd, signal, ...(options.env ? { env: options.env } : {}) });
  for (const warning of tools.warnings) process.stderr.write(`raw: ${warning}\n`);
  try {
    if (signal.aborted) throw new Error("startup aborted");
    const compactOptions = { keepRecentTurns: runtime.compact.keepRecentTurns, maxOutputTokens: runtime.compact.maxOutputTokens,
      ...(runtime.compact.maxOutputTokensDefaulted ? { maxOutputTokensDefaulted: true } : {}),
      ...(runtime.compact.keepRecentTokens !== undefined ? { keepRecentTokens: runtime.compact.keepRecentTokens } : {}),
      ...(runtime.compact.instructions ? { instructions: runtime.compact.instructions } : {}),
      ...(operation.kind === "compact" ? { provider: createProvider(runtime.resolveCompactModelConfig()) } : {}) };
    const agent = createAgent({ ...runtimeAgentOptions(runtime, tools, provider, session.cwd),
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.interactions ? { interactions: options.interactions } : {}), deliverQueuedInputs: true,
      persistence: { store, sessionId: session.id, surface: "web", owner, ownership: "host", operationId: operation.id } });
    await agent.start(agent.transcript.length ? "resume" : "create", undefined, signal);
    for (const text of notices) store.appendOwnedHistory(session.id, owner, "backend_notice", { text, operationId: operation.id });
    return { agent, modelConfig, compact: runtime.compact, compactOptions,
      capabilities: { tools: [...runtime.toolIds], skills: [...runtime.skillIds], vars: runtime.variableConfig.variables.map((item) => item.name) },
      close: () => tools.mcp.close() };
  } catch (error) { await tools.mcp.close(); throw error; }
};

/** An external backend's runtime: its own CLI per attached runtime, stopped with it (Fixed decision 8). */
async function attachBackendRuntime(runtime: RuntimeConfig, options: Parameters<AttachSessionRuntime>[0], factory: SessionAgentFactory): Promise<SessionRuntime> {
  const { store, operation, owner, signal, session } = options;
  const notices = [...(options.notices ?? [])];
  const spec = runtime.backend!;
  const key = backendResidentKey({ agentName: runtime.agentName ?? spec.kind, spec, cwd: session.cwd,
    autoApprove: runtime.autoApprove, ...(runtime.systemPrompt !== undefined ? { systemPrompt: runtime.systemPrompt } : {}) });
  const resident = options.resident?.residentKey === key ? options.resident : undefined;
  notices.push(...await releaseResident(options.resident, resident, options.carry));
  const tools = await createRuntimeTools({ runtime, cwd: session.cwd, signal, ...(options.env ? { env: options.env } : {}) });
  for (const warning of tools.warnings) process.stderr.write(`raw: ${warning}\n`);
  try {
    if (signal.aborted) throw new Error("startup aborted");
    const agent = factory({ runtime, tools, cwd: session.cwd, ...(options.env ? { env: options.env } : {}), ...(resident ? { resident } : {}), host: {
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.interactions ? { interactions: options.interactions } : {}), deliverQueuedInputs: true,
      persistence: { store, sessionId: session.id, surface: "web", owner, ownership: "host", operationId: operation.id } } });
    await agent.start(agent.transcript.length ? "resume" : "create", undefined, signal);
    // The dashboard's choice for this turn only; the runner checks each value against what the CLI offers then.
    if (options.request?.backend && agent instanceof AcpBackendAgent) agent.setTurnOverride(options.request.backend);
    // The dashboard shows a startup warning in the chat, once per session; the server's stderr still has every start.
    if (agent instanceof AcpBackendAgent && notices.length) agent.provider.noticeNextTurn(notices);
    if (agent instanceof AcpBackendAgent && tools.warnings.length) {
      const shown = store.backendNoticeTexts(session.id);
      agent.provider.noticeNextTurn(tools.warnings.filter((warning) => !shown.has(warning)));
    }
    const agentName = runtime.agentName ?? runtime.backend!.kind;
    const provider = agent instanceof AcpBackendAgent && agent.provider instanceof AcpBackendProvider ? agent.provider : undefined;
    return { agent, ...(agent instanceof AcpBackendAgent ? { measure: (measure: MeasureOptions) => measureBackend(agent, agentName, measure, runtime.backend) } : {}),
      ...(provider && agent instanceof AcpBackendAgent ? { backend: { provider, detach: () => agent.detach() } } : {}),
      capabilities: { tools: [...runtime.toolIds], skills: [...runtime.skillIds], vars: runtime.variableConfig.variables.map((item) => item.name) },
      close: () => tools.mcp.close() };
  } catch (error) { await tools.mcp.close(); throw error; }
}

/**
 * A kept adapter serves only the agent it was started for: unless it is `kept`, it is stopped with its tasks. Returns its
 * notices and the stop's, given to `carry` first so they outlive an attach that fails after it.
 */
async function releaseResident(resident: AcpBackendProvider | undefined, kept: AcpBackendProvider | undefined,
  carry: ((notices: readonly string[]) => void) | undefined): Promise<string[]> {
  if (!resident || resident === kept) return [];
  const names = resident.backgroundTasks().filter((task) => task.state === "running" || task.state === "paused").map((task) => task.name);
  const notices = resident.drainNotices();
  if (names.length) notices.push(`${resident.label} stopped ${names.length} background task(s) because the agent changed: ${names.join(", ")}`);
  carry?.(notices);
  await resident.close();
  return notices;
}
