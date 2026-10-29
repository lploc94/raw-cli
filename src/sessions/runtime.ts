import { createAgent, type AgentOptions } from "../agent.js";
import { loadConfig, type RuntimeConfig } from "../config.js";
import { createProvider } from "../llm/client.js";
import type { ProviderAdapter } from "../llm/types.js";
import { applyRequestOverride } from "../request-controls.js";
import { createRuntimeTools, type RuntimeTools } from "../tools/plugins/runtime.js";
import { AcpBackendAgent, measureBackend } from "../backends/acp-agent.js";
import { createSessionAgent } from "../backends/factory.js";
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

export const attachSessionRuntime: AttachSessionRuntime = async (options) => {
  const { store, operation, owner, signal, session } = options;
  const runtime = await loadConfig({ configPath: operation.configPath, flags: { agent: operation.agentName },
    cwd: session.cwd, requireModel: true, ...(options.env ? { env: options.env } : {}) });
  if (signal.aborted) throw new Error("startup aborted");
  if (runtime.backend) return attachBackendRuntime(runtime, options);
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
    return { agent, modelConfig, compact: runtime.compact, compactOptions,
      capabilities: { tools: [...runtime.toolIds], skills: [...runtime.skillIds], vars: runtime.variableConfig.variables.map((item) => item.name) },
      close: () => tools.mcp.close() };
  } catch (error) { await tools.mcp.close(); throw error; }
};

/** An external backend's runtime: its own CLI per attached runtime, stopped with it (Fixed decision 8). */
async function attachBackendRuntime(runtime: RuntimeConfig, options: Parameters<AttachSessionRuntime>[0]): Promise<SessionRuntime> {
  const { store, operation, owner, signal, session } = options;
  const tools = await createRuntimeTools({ runtime, cwd: session.cwd, signal, ...(options.env ? { env: options.env } : {}) });
  for (const warning of tools.warnings) process.stderr.write(`raw: ${warning}\n`);
  try {
    if (signal.aborted) throw new Error("startup aborted");
    const agent = createSessionAgent({ runtime, tools, cwd: session.cwd, host: {
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.interactions ? { interactions: options.interactions } : {}), deliverQueuedInputs: true,
      persistence: { store, sessionId: session.id, surface: "web", owner, ownership: "host", operationId: operation.id } } });
    await agent.start(agent.transcript.length ? "resume" : "create", undefined, signal);
    const agentName = runtime.agentName ?? runtime.backend!.kind;
    return { agent, ...(agent instanceof AcpBackendAgent ? { measure: (measure: MeasureOptions) => measureBackend(agent, agentName, measure) } : {}),
      capabilities: { tools: [...runtime.toolIds], skills: [...runtime.skillIds], vars: runtime.variableConfig.variables.map((item) => item.name) },
      close: () => tools.mcp.close() };
  } catch (error) { await tools.mcp.close(); throw error; }
}
