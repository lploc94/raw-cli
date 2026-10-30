import type { BackendKind } from "../../src/backends/config.js";

export const CLI_METHOD: Readonly<Record<BackendKind, string>> = { claude: "claude-code-cli", codex: "codex-cli", agy: "antigravity-cli" };

export interface CliAgentOptions {
  kind: BackendKind;
  /** The CLI's model name (`model_id`); absent means the CLI's default. */
  model?: string;
  effort?: string;
  mode?: string;
  executable?: string;
  system_prompt_mode?: "replace" | "append";
  /** Model alias; defaults to `cli-<kind>`. */
  alias?: string;
}

/** The config shape for an agent run by a CLI: a CLI model entry and an agent pointing at it by alias. */
export function cliAgent(options: CliAgentOptions, rest: Record<string, unknown> = {}): {
  alias: string; models: Record<string, Record<string, unknown>>; agent: Record<string, unknown>;
} {
  const alias = options.alias ?? `cli-${options.kind}`;
  const model = { method: CLI_METHOD[options.kind], ...(options.model === undefined ? {} : { model_id: options.model }),
    ...(options.executable === undefined ? {} : { executable: options.executable }) };
  const restRequest = rest.request && typeof rest.request === "object" ? rest.request as Record<string, unknown> : {};
  const request = { ...restRequest, ...(options.effort === undefined ? {} : { reasoning_effort: options.effort }),
    ...(options.mode === undefined ? {} : { mode: options.mode }) };
  const { request: _request, ...others } = rest;
  return { alias, models: { [alias]: model }, agent: { model: alias, ...others,
    ...(Object.keys(request).length ? { request } : {}),
    ...(options.system_prompt_mode === undefined ? {} : { system_prompt_mode: options.system_prompt_mode }) } };
}

/**
 * A config document in the current shape from one whose agents describe their CLI as `cli: {kind, model, effort, mode,
 * executable, system_prompt_mode}`: each such agent gets its own CLI model `<agent>-cli` and points at it.
 */
export function cliConfig<T extends Record<string, unknown>>(document: T): T {
  const models: Record<string, unknown> = { ...(document.models as Record<string, unknown> | undefined) };
  const agents: Record<string, unknown> = {};
  for (const [name, value] of Object.entries((document.agents ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!value || typeof value !== "object" || !value.cli) { agents[name] = value; continue; }
    const { cli, ...rest } = value;
    const built = cliAgent({ ...(cli as CliAgentOptions), alias: `${name}-cli` }, rest);
    Object.assign(models, built.models);
    agents[name] = built.agent;
  }
  return { ...document, models, agents } as T;
}
