export type ProviderName = string;
/** `acp`: an external backend CLI driven over the Agent Client Protocol (src/backends); never configurable on a model. */
export type ApiMethod = "openai-chat-completions" | "openai-responses" | "anthropic-messages" | "google-generate-content" | "acp";

interface RequestBase { maxOutputTokens?: number }
export type ModelRequestOptions =
  | (RequestBase & { kind: "openai"; serviceTier?: "auto" | "default" | "flex" | "fast" | "priority";
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      reasoningMode?: "standard" | "pro" })
  | (RequestBase & { kind: "deepseek"; thinking?: "enabled" | "disabled"; reasoningEffort?: "low" | "high" | "max" })
  | (RequestBase & { kind: "anthropic"; thinking?: { type: "adaptive" | "disabled" } | { type: "enabled"; budgetTokens: number };
      effort?: "low" | "medium" | "high" | "xhigh" | "max"; serviceTier?: "auto" | "standard_only" })
  | (RequestBase & { kind: "google"; thinkingLevel?: "minimal" | "low" | "medium" | "high"; thinkingBudget?: number })
  | (RequestBase & { kind: "generic" });

export interface CacheOptions {
  mode?: "auto" | "no-hints";
  key?: string;
  retention?: string;
  backend?: "generic" | "llama.cpp";
}

export interface ResolvedModelConfig {
  agentName: string;
  provider: ProviderName;
  method: ApiMethod;
  model: string;
  modelAlias?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  cache?: Readonly<CacheOptions>;
  request?: Readonly<ModelRequestOptions>;
}

import type { ToolDefinition } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import type { VisibleToolCall, VisibleToolResult } from "../sessions/visible.js";

/** What an external backend reports besides text (src/backends): its own tool calls and notices, shown and recorded only. */
export type ExternalTurnEvent =
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown>; display: VisibleToolCall }
  | { type: "tool_result"; id: string; name: string; result: ToolResult; display: VisibleToolResult; call: VisibleToolCall; started: boolean }
  | { type: "notice"; message: string };

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentError?: string;
  rawArguments?: string;
  syntheticId?: boolean;
}

export type UserBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg"; name?: string }
  | { type: "resource_link"; uri: string; name: string; title?: string | null; description?: string | null;
      mimeType?: string | null; size?: number | null; annotations?: unknown };

export type UserInput = string | readonly UserBlock[];
export type UserImageBlock = Extract<UserBlock, { type: "image" }>;

/** Decoded byte length of a base64 string without allocating the decoded buffer. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

export function renderUserInput(input: UserInput): string {
  if (typeof input === "string") return input;
  return input.map((block) => block.type === "text" ? block.text
    : block.type === "image" ? `\n[Image: ${block.mimeType}, ${base64ByteLength(block.data)} bytes]\n`
    : `\n[Resource link] ${JSON.stringify(block)}\n`).join("");
}

export function userInputHasImage(input: UserInput): boolean {
  return typeof input !== "string" && input.some((block) => block.type === "image");
}

/** Text that stands in for an image when the model cannot read images. */
export function imagePlaceholderText(block: UserImageBlock): string {
  const label = block.name ? `, ${JSON.stringify(block.name)}` : "";
  return `[Image omitted: ${block.mimeType}, ${base64ByteLength(block.data)} bytes${label}. The current model cannot read images, so this image was replaced by this text placeholder. Its content may be described in earlier assistant messages of this conversation; ask the user to describe it or to switch to a vision-capable agent if you need to see it.]`;
}

export type ModelMessage =
  | { role: "user"; content: UserInput }
  | { role: "assistant"; text: string; toolCalls: ModelToolCall[]; opaque?: unknown }
  /** `arguments`: the normalized arguments, when normalization changed the call (host-only; the raw call stays on the assistant message). */
  | { role: "tool"; callId: string; name: string; result: ToolResult; arguments?: Record<string, unknown> };

export interface ProviderRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** `maxOutputTokens` is a host default, not a configured cap: an adapter may lower it to a limit the API states. */
  maxOutputTokensAssumed?: boolean;
  /** Whether the model may call the tools it is given; unset sends no setting. See `toolChoiceKeepsCache`. */
  toolChoice?: "auto" | "none";
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onUsage?: (raw: unknown) => void;
  /** Tool calls the provider ran itself and notices about the run; only an external backend sends them. */
  onExternal?: (event: ExternalTurnEvent) => void;
  /** Runs one of `tools` for an external backend (the Raw bridge) inside this turn, recorded as Raw's own calls are. */
  runTool?: (call: { id: string; name: string; arguments: Record<string, unknown> }, signal: AbortSignal) => Promise<ToolResult>;
  cacheKey?: string;
}

export interface ProviderTurn {
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  /** The response stopped at the output token limit; text and any complete tool calls are partial but usable. */
  truncated?: boolean;
  opaque?: unknown;
  usage?: unknown;
}

/** Longest a provider stream may stay silent (including before its first event) before the request fails. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600000;

/** Argument error for a tool call whose JSON the output token limit cut off, telling the model how to recover. */
export function truncatedArgumentsError(name: string): string {
  return `tool ${name} arguments were cut off at the output token limit; call it again with smaller arguments, for example by splitting large content across several calls`;
}

/** A provider-native compaction request (docs/compaction-v2-design.md §6.9.1): `messages` are summarized, nothing is answered. */
export interface NativeCompactRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Replaces the provider's own summarization prompt, where the provider accepts one. */
  instructions?: string;
  maxOutputTokens?: number;
  onUsage?: (raw: unknown) => void;
  cacheKey?: string;
}

export interface NativeCompaction {
  /** What the provider returned, exactly: stored as the `opaque` of the message that replaces the summarized ones. */
  items: unknown[];
  /** The summary as readable text, when the provider returns one. */
  summary?: string;
  usage?: unknown;
}

export interface ProviderAdapter {
  readonly modelConfig: Readonly<ResolvedModelConfig>;
  generate(request: ProviderRequest): Promise<ProviderTurn>;
  /** Provider-native compaction, on the adapters whose API offers one. */
  compact?(request: NativeCompactRequest): Promise<NativeCompaction>;
}

/** Whether `message` holds a provider-native compaction result: an assistant message whose opaque items include one. */
export function isNativeCompaction(message: ModelMessage | undefined): boolean {
  return message?.role === "assistant" && Array.isArray(message.opaque)
    && message.opaque.some((item) => (item as { type?: unknown } | null)?.type === "compaction");
}
