import { RequestError } from "@agentclientprotocol/sdk";

export const rawErrors = {
  unknownSession: -32001,
  busy: -32002,
  capability: -32003,
  tool: -32004,
  timeout: -32005,
  cancelled: -32006,
  upstream: -32007,
  duplicate: -32008,
} as const;

export type RawCapability = "runtimeInfo" | "sessionConfigure" | "toolRegister" | "toolCall" | "sessionCompact" | "toolCancel" | "panelsV2" | "interactions";
export type RawCapabilities = Partial<Record<RawCapability, boolean>>;

const knownFlags: readonly RawCapability[] = ["runtimeInfo", "sessionConfigure", "toolRegister", "toolCall", "sessionCompact", "toolCancel", "panelsV2", "interactions"];

export function rawCapabilities(meta: unknown): RawCapabilities {
  if (meta === undefined || meta === null) return {};
  const root = object(meta, "_meta");
  if (root.raw === undefined || root.raw === null) return {};
  const raw = object(root.raw, "_meta.raw");
  const capabilities: RawCapabilities = {};
  for (const flag of knownFlags) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== "boolean") throw RequestError.invalidParams(undefined, `_meta.raw.${flag} must be boolean`);
    capabilities[flag] = raw[flag];
  }
  return capabilities;
}

export function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw RequestError.invalidParams(undefined, `${where} must be an object`);
  return value as Record<string, unknown>;
}

export function string(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw RequestError.invalidParams(undefined, `${where} must be a nonempty string`);
  return value;
}

export function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw RequestError.invalidParams(undefined, `${where} must be a string array`);
  }
  return value;
}

export function fields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const name of Object.keys(value)) if (!allowed.includes(name)) throw RequestError.invalidParams(undefined, `unknown ${where} field: ${name}`);
}

export function rawError(code: number, message: string): RequestError { return new RequestError(code, message); }

export async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(rawError(rawErrors.timeout, "reverse request timed out")), timeoutMs);
      if (signal) {
        onAbort = () => reject(rawError(rawErrors.cancelled, "reverse request cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let onAbort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(rawError(rawErrors.cancelled, "request cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
