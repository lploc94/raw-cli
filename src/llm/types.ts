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
