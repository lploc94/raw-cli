import type { ProviderAdapter, ResolvedModelConfig, ProviderRequest, ProviderTurn } from "./types.js";
import { createOpenAiProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createResponsesProvider } from "./responses.js";

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ProviderError"; }
}

export async function withProviderAbort(request: ProviderRequest, run: (signal: AbortSignal) => Promise<ProviderTurn>): Promise<ProviderTurn> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2147483647) {
    throw new ProviderError("invalid_timeout", "request timeout must be a positive integer within the timer range");
  }
  if (request.signal?.aborted) throw new ProviderError("aborted", "provider request aborted");
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) controller.abort(request.signal.reason);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
  try {
    const turn = await run(controller.signal);
    if (controller.signal.aborted) throw new ProviderError(timedOut ? "timeout" : "aborted", timedOut ? "provider request timed out" : "provider request aborted");
    return turn;
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError(timedOut ? "timeout" : "aborted", timedOut ? "provider request timed out" : "provider request aborted");
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export function createProvider(modelConfig: Readonly<ResolvedModelConfig>): ProviderAdapter {
  if (modelConfig.method === "anthropic-messages") return createAnthropicProvider(modelConfig);
  if (modelConfig.method === "google-generate-content") return createGoogleProvider(modelConfig);
  if (modelConfig.method === "openai-chat-completions") return createOpenAiProvider(modelConfig);
  if (modelConfig.method === "openai-responses") return createResponsesProvider(modelConfig);
  throw new ProviderError("unsupported_method", `unsupported API method: ${String(modelConfig.method)}`);
}
