export type ProviderName =
  | "openai"
  | "openai-compatible"
  | "openrouter"
  | "ollama"
  | "anthropic"
  | "google";

export interface CacheOptions {
  mode?: "auto" | "no-hints";
  key?: string;
  retention?: string;
  backend?: "generic" | "llama.cpp";
}

export interface ProviderProfile {
  name: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  cache?: Readonly<CacheOptions>;
}

import type { ToolDefinition } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentError?: string;
  rawArguments?: string;
  syntheticId?: boolean;
}

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ModelToolCall[]; opaque?: unknown }
  | { role: "tool"; callId: string; name: string; result: ToolResult };

export interface ProviderRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  onTextDelta?: (delta: string) => void;
  onUsage?: (raw: unknown) => void;
  cacheKey?: string;
}

export interface ProviderTurn {
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  opaque?: unknown;
  usage?: unknown;
}

export interface ProviderAdapter {
  readonly profile: Readonly<ProviderProfile>;
  generate(request: ProviderRequest): Promise<ProviderTurn>;
}
