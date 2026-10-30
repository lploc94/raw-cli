import { BACKEND_LABELS, CLI_METHODS, isCliMethod } from "../../src/backends/config.js";

/** The model methods that name a coding CLI, with the label the dashboard shows for each. */
export const CLI_CONNECTIONS = Object.entries(CLI_METHODS).map(([method, kind]) => ({ method, label: `${BACKEND_LABELS[kind]} CLI` }));

/** Model keys only an API connection has: a CLI keeps its own endpoint and context. */
const API_ONLY_MODEL_KEYS = ["base_url", "context_window_tokens", "max_output_tokens", "vision"];

export interface CredentialEdit { mode: string; env?: string; value?: string }

/**
 * A model draft after its method changes. To a CLI: the API-only keys go and the stored credential is cleared (the draft
 * never holds it, so `keep` would leave it in the file, where a CLI model rejects it). Back to an API method: `executable`
 * goes and the credential is kept as it is in the file.
 */
export function switchModelMethod(value: Record<string, unknown>, credential: CredentialEdit, method: string): {
  value: Record<string, unknown>; credential: CredentialEdit;
} {
  const next: Record<string, unknown> = { ...value, method };
  if (isCliMethod(method)) {
    for (const key of API_ONLY_MODEL_KEYS) delete next[key];
    return { value: next, credential: { mode: "clear" } };
  }
  if (isCliMethod(value.method)) {
    delete next.executable;
    return { value: next, credential: { mode: "keep" } };
  }
  return { value: next, credential };
}

/**
 * An agent draft after its Model select changes. From a CLI model to an API model, `request` and `system_prompt_mode` go:
 * a CLI agent's request holds the CLI's own effort and mode words and settings the CLI skipped, and API request keys and
 * values differ per destination, so none is safe to carry over. Any other switch changes only `model`.
 */
export function switchAgentModel(agent: Record<string, unknown>, alias: string, isCli: (alias: unknown) => boolean): {
  value: Record<string, unknown>; cleared: boolean;
} {
  const next: Record<string, unknown> = { ...agent, model: alias };
  if (!isCli(agent.model) || isCli(alias)) return { value: next, cleared: false };
  const cleared = next.request !== undefined || next.system_prompt_mode !== undefined;
  delete next.request;
  delete next.system_prompt_mode;
  return { value: next, cleared };
}
