import type { ApiMethod, ModelRequestOptions, ProviderName, ResolvedModelConfig } from "./llm/types.js";

export type RequestKind = ModelRequestOptions["kind"];

// Single source of the request values: `requestSpec` (config.ts) validates against these lists and the dashboard advertises them.
export const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const OPENAI_TIERS = ["auto", "default", "flex", "fast", "priority"] as const;
export const DEEPSEEK_EFFORTS = ["low", "high", "max"] as const;
export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ANTHROPIC_TIERS = ["auto", "standard_only"] as const;
export const GOOGLE_LEVELS = ["minimal", "low", "medium", "high"] as const;

export function requestKind(provider: ProviderName, method: ApiMethod): RequestKind {
  if (provider === "openai" && (method === "openai-chat-completions" || method === "openai-responses")) return "openai";
  if (provider === "deepseek" && method === "openai-chat-completions") return "deepseek";
  if (provider === "anthropic" && method === "anthropic-messages") return "anthropic";
  if (provider === "google" && method === "google-generate-content") return "google";
  return "generic";
}

export interface RequestOption { value: string; label: string; hint?: string }
export interface RequestControl {
  id: "effort" | "serviceTier";
  label: string;
  kind: "level" | "choice";
  options: RequestOption[];
  /** The value configured on the agent, if any. */
  current?: string;
}
export interface RequestOverride { effort?: string; serviceTier?: string }

export class RequestOverrideError extends Error {
  constructor(message: string) { super(message); this.name = "RequestOverrideError"; }
}

const levels = (values: readonly string[]): RequestOption[] => values.map((value) => ({ value, label: value }));
const OPENAI_TIER_HINTS: Record<(typeof OPENAI_TIERS)[number], string> = {
  auto: "Use the project's service tier setting.",
  default: "Standard processing and price.",
  flex: "Slower and lower cost; capacity may be limited.",
  fast: "Faster responses.",
  priority: "Fastest and most reliable; higher cost.",
};
const ANTHROPIC_TIER_HINTS: Record<(typeof ANTHROPIC_TIERS)[number], string> = {
  auto: "Use priority capacity when it is available.",
  standard_only: "Standard capacity only; no priority pricing.",
};
const tierOptions = (values: readonly string[], hints: Record<string, string>): RequestOption[] =>
  values.map((value) => ({ value, label: value, hint: hints[value]! }));

/** What a turn may override for this provider; empty when the provider has no such settings. */
export function requestControls(provider: ProviderName, method: ApiMethod, current?: Readonly<ModelRequestOptions>): RequestControl[] {
  const kind = requestKind(provider, method);
  const withCurrent = (control: RequestControl, value: string | undefined): RequestControl => value === undefined ? control : { ...control, current: value };
  const from = current?.kind === kind ? current : undefined;
  if (kind === "openai") {
    const o = from as Extract<ModelRequestOptions, { kind: "openai" }> | undefined;
    return [withCurrent({ id: "effort", label: "Reasoning", kind: "level", options: levels(OPENAI_EFFORTS) }, o?.reasoningEffort),
      withCurrent({ id: "serviceTier", label: "Service tier", kind: "choice", options: tierOptions(OPENAI_TIERS, OPENAI_TIER_HINTS) }, o?.serviceTier)];
  }
  if (kind === "anthropic") {
    const o = from as Extract<ModelRequestOptions, { kind: "anthropic" }> | undefined;
    return [withCurrent({ id: "effort", label: "Effort", kind: "level", options: levels(ANTHROPIC_EFFORTS) }, o?.effort),
      withCurrent({ id: "serviceTier", label: "Service tier", kind: "choice", options: tierOptions(ANTHROPIC_TIERS, ANTHROPIC_TIER_HINTS) }, o?.serviceTier)];
  }
  if (kind === "deepseek") {
    const o = from as Extract<ModelRequestOptions, { kind: "deepseek" }> | undefined;
    return [withCurrent({ id: "effort", label: "Reasoning", kind: "level", options: levels(DEEPSEEK_EFFORTS) }, o?.reasoningEffort)];
  }
  if (kind === "google") {
    const o = from as Extract<ModelRequestOptions, { kind: "google" }> | undefined;
    return [withCurrent({ id: "effort", label: "Thinking", kind: "level", options: levels(GOOGLE_LEVELS) }, o?.thinkingLevel)];
  }
  return [];
}

/** Validates a client override against the controls advertised for the agent. */
export function parseRequestOverride(raw: unknown, controls: readonly RequestControl[]): RequestOverride {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RequestOverrideError("request must be an object");
  const result: RequestOverride = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "effort" && key !== "serviceTier") throw new RequestOverrideError(`request.${key} is not a request control`);
    const control = controls.find((entry) => entry.id === key);
    if (!control) throw new RequestOverrideError(`request.${key}: this agent has no request controls for it (no request controls offered by its provider)`);
    if (typeof value !== "string" || !control.options.some((option) => option.value === value))
      throw new RequestOverrideError(`request.${key} must be one of ${control.options.map((option) => option.value).join(", ")}`);
    result[key] = value;
  }
  return result;
}

/** A new frozen model config whose `request` carries the override; the input is never mutated. */
export function applyRequestOverride(model: Readonly<ResolvedModelConfig>, override: RequestOverride): Readonly<ResolvedModelConfig> {
  if (override.effort === undefined && override.serviceTier === undefined) return model;
  const kind = requestKind(model.provider, model.method);
  if (kind === "generic") return model;
  const base = model.request?.kind === kind ? model.request : { kind } as ModelRequestOptions;
  let next: ModelRequestOptions;
  if (base.kind === "openai") {
    next = { ...base, ...(override.effort ? { reasoningEffort: override.effort as (typeof OPENAI_EFFORTS)[number] } : {}),
      ...(override.serviceTier ? { serviceTier: override.serviceTier as (typeof OPENAI_TIERS)[number] } : {}) };
  } else if (base.kind === "anthropic") {
    next = { ...base, ...(override.effort ? { effort: override.effort as (typeof ANTHROPIC_EFFORTS)[number] } : {}),
      ...(override.serviceTier ? { serviceTier: override.serviceTier as (typeof ANTHROPIC_TIERS)[number] } : {}) };
  } else if (base.kind === "deepseek") {
    next = { ...base, ...(override.effort ? { thinking: "enabled" as const, reasoningEffort: override.effort as (typeof DEEPSEEK_EFFORTS)[number] } : {}) };
  } else if (base.kind === "google") {
    const { thinkingBudget: _budget, ...rest } = base;
    next = override.effort ? { ...rest, thinkingLevel: override.effort as (typeof GOOGLE_LEVELS)[number] } : base;
  } else return model;
  return Object.freeze({ ...model, request: Object.freeze(next) });
}
