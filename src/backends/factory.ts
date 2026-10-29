import { createAgent, type AgentOptions, type AgentSession } from "../agent.js";
import type { RuntimeConfig } from "../config.js";
import { createProvider } from "../llm/client.js";
import { runtimeAgentOptions } from "../sessions/runtime.js";
import type { RuntimeTools } from "../tools/plugins/runtime.js";
import { AcpBackendAgent, AcpBackendProvider, type AcpLaunch } from "./acp-agent.js";
import { BACKEND_LABELS, type BackendKind } from "./config.js";
import type { SessionAgent } from "./types.js";

/** What a host hands to the factory: the loaded agent, its tools, and the host's own channels and persistence. */
export interface SessionAgentContext {
  runtime: RuntimeConfig;
  tools: RuntimeTools;
  cwd: string;
  host: Pick<AgentOptions, "persistence" | "processes" | "interactions" | "interactionAdapter" | "approve" | "deliverQueuedInputs">;
}

export type SessionAgentFactory = (context: SessionAgentContext) => SessionAgent;

/** How each ACP backend kind starts; a kind without one is not available yet. */
const ACP_LAUNCHES: Partial<Record<BackendKind, (runtime: RuntimeConfig) => AcpLaunch>> = {};

/** Raw's own loop for an agent with a model; an external CLI for an agent with a `backend`. */
export const createSessionAgent: SessionAgentFactory = (context) => {
  const { runtime, tools, cwd, host } = context;
  if (runtime.backend) {
    const launch = ACP_LAUNCHES[runtime.backend.kind]?.(runtime);
    if (!launch) throw new Error(`the ${BACKEND_LABELS[runtime.backend.kind]} backend is not available yet`);
    return createAcpSessionAgent(context, launch);
  }
  if (!runtime.modelConfig) throw new Error("provider and model are required");
  return createAgent({ ...runtimeAgentOptions(runtime, tools, createProvider(runtime.modelConfig), cwd), ...host });
};

/**
 * An ACP backend session: Raw's loop keeps history, operations and turn state, and its provider runs the CLI. The CLI
 * owns its tools and context, so no Raw tool, hook, compaction or step limit is configured on the loop.
 */
export function createAcpSessionAgent({ runtime, cwd, host }: SessionAgentContext, launch: AcpLaunch): AcpBackendAgent {
  const spec = runtime.backend!;
  let session: AgentSession | undefined;
  const provider = new AcpBackendProvider({ agentName: runtime.agentName ?? spec.kind, spec, cwd, launch,
    ...(runtime.systemPrompt !== undefined ? { systemPrompt: runtime.systemPrompt } : {}),
    autoApprove: runtime.autoApprove, ...(host.approve ? { approve: host.approve } : {}),
    binding: () => session?.persistenceBinding });
  session = createAgent({ provider, cwd, system: runtime.systemPrompt ?? "", configPath: runtime.configPath,
    maxOutputBytes: runtime.maxOutputBytes, requestTimeoutMs: runtime.requestTimeoutMs, autoApprove: runtime.autoApprove, ...host });
  return new AcpBackendAgent(session, provider);
}

/** The fields a saved session records about what runs it. */
export function sessionIdentity(runtime: RuntimeConfig): { agentName?: string; modelId?: string; provider?: string; method?: string;
  endpoint?: string } {
  if (runtime.backend) {
    return { ...(runtime.agentName ? { agentName: runtime.agentName } : {}), modelId: runtime.backend.model ?? "default",
      provider: `backend:${runtime.backend.kind}`, method: runtime.backend.kind === "agy" ? "stream-json" : "acp" };
  }
  const model = runtime.modelConfig;
  if (!model) return runtime.agentName ? { agentName: runtime.agentName } : {};
  return { agentName: model.agentName, modelId: model.model, provider: model.provider, method: model.method,
    ...(model.baseUrl ? { endpoint: model.baseUrl } : {}) };
}
