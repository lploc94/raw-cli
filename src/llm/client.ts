import type { ProviderAdapter, ResolvedModelConfig, ProviderRequest, ProviderTurn } from "./types.js";
import { createOpenAiProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createResponsesProvider } from "./responses.js";

export class ProviderError extends Error {
  readonly error?: { code?: unknown; type?: unknown; message?: unknown } | undefined;
  constructor(public readonly code: string, message: string, details?: { code?: unknown; type?: unknown; message?: unknown }) {
    super(message);
    this.name = "ProviderError";
    if (details !== undefined) this.error = details;
  }
}

/** Maximum safe 32-bit signed timer value in Node.js (`2^31 - 1` ms), used to disable SDK-internal timers. */
export const MAX_TIMER_MS = 2147483647;
/** Retries after a transient failure that happened before the provider committed any output delta. */
export const PROVIDER_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60000;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
export const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "EAI_FAIL", "ENOTFOUND",
  "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_INFO",
]);
const TERMINAL_QUOTA_CODES = new Set([
  "insufficient_quota", "billing_hard_limit_reached", "quota_exceeded",
  "daily_limit_exceeded", "monthly_limit_exceeded", "spend_limit_reached",
  "credit_balance_too_low", "account_deactivated", "billing_not_active",
]);
const HARD_TERMINAL_QUOTA_PATTERN = /\b(?:billing[_ ]hard[_ ]limit|credit balance is too low|out of credits|monthly spend limit|daily limit exceeded)\b|PerDay|PerMonth|QuotaFailure"[\s\S]*?"subject"\s*:\s*"billing"/i;
const SOFT_QUOTA_PATTERN = /\b(?:insufficient[_ ]quota|exceeded your current quota|plan and billing)\b/i;
const TRANSIENT_RATE_PATTERN = /\b(?:per minute|per second|rpm|tpm|ipm|tokens per min|requests per min|concurrent|try again in \d+\s*(?:ms|millisecond|s|sec|second|m|min|minute))\b|PerMinute|PerSecond|"retryDelay"\s*:\s*"\d+(?:\.\d+)?s"/i;
const TRANSIENT_SSE_CODES = new Set([
  "overloaded_error", "rate_limit_error", "rate_limit_exceeded", "server_error", "api_error",
]);

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === target && typeof v === "string") return v;
  }
  return undefined;
}

function extractErrorFields(error: unknown): { codes: string[]; message: string } {
  if (!error || typeof error !== "object") return { codes: [], message: "" };
  const obj = error as Record<string, unknown>;
  const inner = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : undefined;
  const nested = inner?.error && typeof inner.error === "object" ? inner.error as Record<string, unknown> : undefined;
  const codes = [obj.code, obj.type, inner?.code, inner?.type, nested?.code, nested?.type]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  const message = [obj.message, inner?.message, nested?.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return { codes, message };
}

export function isTerminalQuotaError(error: unknown): boolean {
  const { codes, message } = extractErrorFields(error);
  for (const code of codes) {
    if (TERMINAL_QUOTA_CODES.has(code)) return true;
  }
  if (HARD_TERMINAL_QUOTA_PATTERN.test(message)) return true;
  if (SOFT_QUOTA_PATTERN.test(message) && !TRANSIENT_RATE_PATTERN.test(message)) return true;
  return false;
}

export function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const shouldRetry = readHeader((error as { headers?: unknown }).headers, "x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "false") return false;
  if (shouldRetry === "true") return true;
  if (isTerminalQuotaError(error)) return false;

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status) || status >= 500;

  if (error instanceof ProviderError) {
    if (error.code === "incomplete_stream") return true;
    const { codes } = extractErrorFields(error);
    return codes.some((c) => TRANSIENT_SSE_CODES.has(c));
  }

  const { codes } = extractErrorFields(error);
  if (codes.some((c) => TRANSIENT_SSE_CODES.has(c))) return true;

  const visited = new Set<object>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const node = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (node.name === "APIConnectionError" || node.name === "APIConnectionTimeoutError") return true;
    if (typeof node.code === "string" && RETRYABLE_CODES.has(node.code)) return true;
    if (typeof node.message === "string" && /^(?:fetch failed|terminated|other side closed|socket hang up|exception posting request to model)\b/i.test(node.message)) {
      return true;
    }
    if (node.cause && typeof node.cause === "object") queue.push(node.cause);
    if (Array.isArray(node.errors)) {
      for (const child of node.errors) {
        if (child && typeof child === "object") queue.push(child);
      }
    }
  }
  return false;
}

const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/;
const ISO_8601_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseDateDelayMs(raw: string, now = Date.now()): number | undefined {
  const value = raw.trim();
  if (ASCTIME_DATE.test(value)) {
    const date = Date.parse(`${value} GMT`);
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
  }
  if (!IMF_FIXDATE.test(value) && !RFC850_DATE.test(value) && !ISO_8601_DATE.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function parseDurationOrDateMs(raw: string, now = Date.now()): number | undefined {
  const value = raw.trim();
  if (!value || value.startsWith("-")) return undefined;
  const dur = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i.exec(value);
  if (dur && (dur[1] || dur[2] || dur[3] || dur[4])) {
    const h = Number(dur[1] ?? 0);
    const m = Number(dur[2] ?? 0);
    const s = Number(dur[3] ?? 0);
    const ms = Number(dur[4] ?? 0);
    return Math.ceil(h * 3_600_000 + m * 60_000 + s * 1000 + ms);
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return Math.ceil(num * 1000);
  }
  return parseDateDelayMs(value, now);
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Server-requested delay from retry-after-ms / retry-after / 429 rate-limit reset headers, when present and sane. */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  const headers = (error as { headers?: unknown })?.headers;
  const msRaw = readHeader(headers, "retry-after-ms")?.trim();
  if (msRaw && /^\d+(?:\.\d+)?$/.test(msRaw)) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  }
  const secondsRaw = readHeader(headers, "retry-after")?.trim();
  if (secondsRaw !== undefined) {
    if (/^\d+(?:\.\d+)?$/.test(secondsRaw)) {
      const parsed = Number(secondsRaw);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed * 1000);
    }
    const dateDelay = parseDateDelayMs(secondsRaw, now);
    if (dateDelay !== undefined) return dateDelay;
  }
  if ((error as { status?: unknown })?.status !== 429) return undefined;
  const reqResetRaw = readHeader(headers, "x-ratelimit-reset-requests") ?? readHeader(headers, "anthropic-ratelimit-requests-reset");
  const tokResetRaw = readHeader(headers, "x-ratelimit-reset-tokens") ?? readHeader(headers, "anthropic-ratelimit-tokens-reset");
  const reqDelay = reqResetRaw !== undefined ? parseDurationOrDateMs(reqResetRaw, now) : undefined;
  const tokDelay = tokResetRaw !== undefined ? parseDurationOrDateMs(tokResetRaw, now) : undefined;
  if (reqDelay === undefined && tokDelay === undefined) return undefined;

  const reqRem = parseNonNegativeInt(readHeader(headers, "x-ratelimit-remaining-requests") ?? readHeader(headers, "anthropic-ratelimit-requests-remaining"));
  const tokRem = parseNonNegativeInt(readHeader(headers, "x-ratelimit-remaining-tokens") ?? readHeader(headers, "anthropic-ratelimit-tokens-remaining"));
  const { codes, message } = extractErrorFields(error);
  const text = [...codes, message].join(" ");
  const mentionsTokens = /\b(?:tokens?|tpm|itpm|otpm|input_tokens|output_tokens)\b/i.test(text);
  const mentionsRequests = /\b(?:requests?|rpm|concurrent)\b/i.test(text) && !mentionsTokens;

  const reqExhausted = reqDelay !== undefined && (reqRem === 0 || (reqRem === undefined && (mentionsRequests || (!mentionsTokens && tokDelay === undefined))));
  const tokLimiting = tokDelay !== undefined && (tokRem === 0 || mentionsTokens || (reqRem !== undefined && reqRem > 0) || (reqRem === undefined && !mentionsRequests));

  const applicable = [
    ...(reqExhausted ? [reqDelay] : []),
    ...(tokLimiting ? [tokDelay] : []),
  ];
  return applicable.length ? Math.max(...applicable) : undefined;
}

/**
 * Runs one provider request. `timeoutMs` bounds silence, not length: the timer restarts whenever the adapter reports
 * stream activity through `touch`, so a long answer that keeps streaming is never cut off, while a stalled connection
 * or a request that never starts is. Transient failures (rate limits, overload, 5xx, dropped connections, pre-output
 * SSE errors) that happen before any output delta is committed via `commit` are retried with exponential backoff,
 * honoring server retry headers up to `timeoutMs`.
 */
export async function withProviderAbort<T = ProviderTurn>(
  request: Pick<ProviderRequest, "timeoutMs" | "signal">,
  run: (signal: AbortSignal, touch: () => void, commit: () => void) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMER_MS) {
    throw new ProviderError("invalid_timeout", "request timeout must be a positive integer within the timer range");
  }
  for (let attempt = 0; ; attempt++) {
    if (request.signal?.aborted) throw new ProviderError("aborted", "provider request aborted");
    const controller = new AbortController();
    let timedOut = false;
    let committed = false;
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
    };
    const commit = () => {
      committed = true;
      touch();
    };
    let failure: unknown;
    try {
      const turn = await run(controller.signal, touch, commit);
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
    if (committed || attempt >= PROVIDER_RETRIES || !retryable(failure)) throw failure;
    const serverDelay = retryAfterMs(failure);
    if (serverDelay !== undefined && serverDelay > request.timeoutMs) throw failure;
    const delay = serverDelay ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt * (0.75 + Math.random() / 2));
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
