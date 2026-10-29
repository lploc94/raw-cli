import { createAgent, type AgentOptions, type AgentSession } from "../agent.js";
import type { RuntimeConfig } from "../config.js";
import { createProvider } from "../llm/client.js";
import { runtimeAgentOptions } from "../sessions/runtime.js";
import type { RuntimeTools } from "../tools/plugins/runtime.js";
import { AcpBackendAgent, AcpBackendProvider, type AcpLaunch, type AcpLaunchResolver, type BackendProvider } from "./acp-agent.js";
import { AgyBackendProvider } from "./agy.js";
import { claudeLaunch } from "./claude.js";
import { codexLaunch } from "./codex.js";
import { BACKEND_LABELS, type BackendKind } from "./config.js";
import type { SessionAgent } from "./types.js";

/** What a host hands to the factory: the loaded agent, its tools, and the host's own channels and persistence. */
export interface SessionAgentContext {
  runtime: RuntimeConfig;
  tools: RuntimeTools;
  cwd: string;
  host: Pick<AgentOptions, "persistence" | "processes" | "interactions" | "interactionAdapter" | "approve" | "deliverQueuedInputs">;
  /** The environment a backend CLI starts with; the process environment by default. */
  env?: NodeJS.ProcessEnv;
}

export type SessionAgentFactory = (context: SessionAgentContext) => SessionAgent;

/** How each ACP backend kind starts; a kind without one is not available yet. */
const ACP_LAUNCHES: Partial<Record<BackendKind, (runtime: RuntimeConfig, cwd: string, deps: { env?: NodeJS.ProcessEnv }) => AcpLaunchResolver>> = { claude: claudeLaunch, codex: codexLaunch };

/** Raw's own loop for an agent with a model; an external CLI for an agent with a `backend`. */
export const createSessionAgent: SessionAgentFactory = (context) => {
  const { runtime, tools, cwd, host } = context;
  if (runtime.backend?.kind === "agy") return createAgySessionAgent(context);
  if (runtime.backend) {
    const launch = ACP_LAUNCHES[runtime.backend.kind]?.(runtime, cwd, context.env ? { env: context.env } : {});
    if (!launch) throw new Error(`the ${BACKEND_LABELS[runtime.backend.kind]} backend is not available yet`);
    return createAcpSessionAgent(context, launch);
  }
  if (!runtime.modelConfig) throw new Error("provider and model are required");
  return createAgent({ ...runtimeAgentOptions(runtime, tools, createProvider(runtime.modelConfig), cwd), ...host });
};

/**
 * An ACP backend session: Raw's loop keeps history, operations and turn state, and its provider runs the CLI. The CLI
 * owns its tools and context; Raw's loop gets only the tools offered through the bridge, and no hook, compaction or step limit.
 */
export function createAcpSessionAgent(context: SessionAgentContext, launch: AcpLaunch | AcpLaunchResolver): AcpBackendAgent {
  const { runtime, cwd, host } = context;
  const spec = runtime.backend!;
  return backendSession(context, (binding) => new AcpBackendProvider({ agentName: runtime.agentName ?? spec.kind, spec, cwd, launch,
    ...(runtime.systemPrompt !== undefined ? { systemPrompt: runtime.systemPrompt } : {}),
    autoApprove: runtime.autoApprove, ...(host.approve ? { approve: host.approve } : {}), binding }));
}

/** An agy backend session: as an ACP one, with agy run once per turn over its stream-json mode. */
export function createAgySessionAgent(context: SessionAgentContext): AcpBackendAgent {
  const { runtime, cwd } = context;
  const spec = runtime.backend!;
  return backendSession(context, (binding) => new AgyBackendProvider({ agentName: runtime.agentName ?? spec.kind, spec, cwd,
    ...(context.env ? { env: context.env } : {}), ...(runtime.systemPrompt !== undefined ? { systemPrompt: runtime.systemPrompt } : {}),
    promptGiven: runtime.backendPromptGiven === true, binding }));
}

function backendSession({ runtime, tools, cwd, host }: SessionAgentContext,
  provide: (binding: () => AgentSession["persistenceBinding"]) => BackendProvider): AcpBackendAgent {
  let session: AgentSession | undefined;
  const provider = provide(() => session?.persistenceBinding);
  // The registry holds only the bridged tools (createRuntimeTools); the CLI reaches them through the Raw bridge.
  session = createAgent({ provider, cwd, system: runtime.systemPrompt ?? "", configPath: runtime.configPath,
    ...(tools ? { registry: tools.registry, toolSourceDigest: tools.toolSourceDigest, selectedSkills: tools.skills } : {}),
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
