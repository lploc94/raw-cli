import { createAgent, type AgentOptions } from "../agent.js";
import type { RuntimeConfig } from "../config.js";
import { createProvider } from "../llm/client.js";
import { runtimeAgentOptions } from "../sessions/runtime.js";
import type { RuntimeTools } from "../tools/plugins/runtime.js";
import type { SessionAgent } from "./types.js";

/** What a host hands to the factory: the loaded agent, its tools, and the host's own channels and persistence. */
export interface SessionAgentContext {
  runtime: RuntimeConfig;
  tools: RuntimeTools;
  cwd: string;
  host: Pick<AgentOptions, "persistence" | "processes" | "interactions" | "interactionAdapter" | "approve" | "deliverQueuedInputs">;
}

export type SessionAgentFactory = (context: SessionAgentContext) => SessionAgent;

/** Raw's own loop for an agent with a model; an external CLI for an agent with a `backend`. */
export const createSessionAgent: SessionAgentFactory = ({ runtime, tools, cwd, host }) => {
  if (runtime.backend) throw new Error("external backends are not available yet");
  if (!runtime.modelConfig) throw new Error("provider and model are required");
  return createAgent({ ...runtimeAgentOptions(runtime, tools, createProvider(runtime.modelConfig), cwd), ...host });
};

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
