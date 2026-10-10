import type { ProviderAdapter, ResolvedModelConfig, ProviderRequest, ProviderTurn } from "./types.js";
import { createOpenAiProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createResponsesProvider } from "./responses.js";

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ProviderError"; }
}

/** Retries after a transient failure that happened before the provider streamed anything. */
export const PROVIDER_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60000;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status) || status >= 500;
  const name = (error as { name?: unknown }).name;
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  const code = (error as { code?: unknown }).code ?? ((error as { cause?: { code?: unknown } }).cause)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

/** Server-requested delay from retry-after-ms / retry-after headers, when present and sane. */
function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown })?.headers;
  const read = (name: string): string | undefined => {
    if (!headers || typeof headers !== "object") return undefined;
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  const ms = Number(read("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, RETRY_MAX_MS);
  const seconds = read("retry-after");
  if (seconds === undefined) return undefined;
  const parsed = Number(seconds);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed * 1000, RETRY_MAX_MS);
  const date = Date.parse(seconds);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), RETRY_MAX_MS) : undefined;
}

/**
 * Runs one provider request. `timeoutMs` bounds silence, not length: the timer restarts whenever the adapter reports
 * stream activity through `touch`, so a long answer that keeps streaming is never cut off, while a stalled connection
 * or a request that never starts is. Transient failures (rate limits, overload, 5xx, dropped connections) that happen
 * before any stream event are retried with exponential backoff, honoring retry-after.
 */
export async function withProviderAbort<T = ProviderTurn>(request: Pick<ProviderRequest, "timeoutMs" | "signal">,
  run: (signal: AbortSignal, touch: () => void) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2147483647) {
    throw new ProviderError("invalid_timeout", "request timeout must be a positive integer within the timer range");
  }
  for (let attempt = 0; ; attempt++) {
    if (request.signal?.aborted) throw new ProviderError("aborted", "provider request aborted");
    const controller = new AbortController();
    let timedOut = false;
    let started = false;
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
    const touch = () => {
      started = true;
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
    };
    let failure: unknown;
    try {
      const turn = await run(controller.signal, touch);
      if (controller.signal.aborted) throw new ProviderError(timedOut ? "timeout" : "aborted", timedOut ? "provider request timed out" : "provider request aborted");
      return turn;
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError(timedOut ? "timeout" : "aborted", timedOut ? "provider request timed out" : "provider request aborted");
      failure = error;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
    if (started || attempt >= PROVIDER_RETRIES || !retryable(failure)) throw failure;
    const delay = retryAfterMs(failure) ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt * (0.75 + Math.random() / 2));
    await new Promise<void>((resolve) => {
      const wait = setTimeout(done, delay);
      function done() { clearTimeout(wait); request.signal?.removeEventListener("abort", done); resolve(); }
      request.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export function createProvider(modelConfig: Readonly<ResolvedModelConfig>): ProviderAdapter {
  if (modelConfig.method === "anthropic-messages") return createAnthropicProvider(modelConfig);
  if (modelConfig.method === "google-generate-content") return createGoogleProvider(modelConfig);
  if (modelConfig.method === "openai-chat-completions") return createOpenAiProvider(modelConfig);
  if (modelConfig.method === "openai-responses") return createResponsesProvider(modelConfig);
  throw new ProviderError("unsupported_method", `unsupported API method: ${String(modelConfig.method)}`);
}
