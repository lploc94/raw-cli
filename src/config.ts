import { parseVariableDefinitions, selectVariables } from "./vars/config.js";
import type { VariableConfig } from "./vars/contract.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { resolveSystemPrompt } from "./llm/prompt.js";
import { defaultCompactOutputTokens } from "./compact.js";
import { effectiveOutputTokens } from "./llm/output.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./llm/types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./tools/results.js";
import { ANTHROPIC_EFFORTS, ANTHROPIC_TIERS, DEEPSEEK_EFFORTS, GOOGLE_LEVELS, OPENAI_EFFORTS, OPENAI_TIERS, requestKind } from "./request-controls.js";
import type { ApiMethod, CacheOptions, ModelRequestOptions, ProviderName, ResolvedModelConfig } from "./llm/types.js";
import { parseMcpPanels, type McpServerConfig } from "./tools/mcp-client.js";
import type { ToolPolicyRule } from "./tools/registry.js";
import { compileWhen } from "./tools/policy.js";
import { createPackageResolutionContext, resolvePackageAgentBinding, resolvePackageDefinitions,
  resolvePackageSelections, validatePackageAgentBinding, type PackageAsset } from "./packages/resolve-agent.js";
import { parseSelectionReference } from "./packages/references.js";
import { parseUiDocument, resolveUiOptions, validateUiFlag, type UiOptions, type Density, type ReasoningDisplay, type ColorDisplay, type IconsDisplay, type ThemeName } from "./terminal/options.js";

type JsonObject = Record<string, unknown>;

const apiMethods = new Set<ApiMethod>(["openai-chat-completions", "openai-responses", "anthropic-messages", "google-generate-content"]);

export interface RawFlags {
  density?: Density;
  reasoning?: ReasoningDisplay;
  color?: ColorDisplay;
  icons?: IconsDisplay;
  theme?: ThemeName;
  agent?: string;
  configPath?: string;
  systemPrompt?: string;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  autoApprove?: boolean;
  host?: string;
  port?: number;
  continue?: boolean;
  resumeId?: string;
  allSessions?: boolean;
  json?: boolean;
  before?: string;
}

export type CliCommand = "help" | "version" | "config-init" | "config-list" | "task" | "interactive" | "acp"
  | "vars-list" | "vars-get"
  | "sessions-list" | "sessions-show" | "sessions-delete" | "sessions-stats" | "sessions-panels";

export interface CliArgs {
  variableName?: string;
  command: CliCommand;
  task?: string;
  flags: RawFlags;
  acpTransport?: "stdio" | "ws";
  sessionId?: string;
  panelId?: string;
}

export interface CompactSettings {
  keepRecentTurns: number;
  maxOutputTokens: number;
  triggerTokens?: number;
}

export interface RuntimeConfig {
  readonly variableConfig: VariableConfig;
  readonly ui: UiOptions;
  readonly agentName?: string;
  readonly modelConfig?: Readonly<ResolvedModelConfig>;
  readonly systemPrompt: string;
  readonly maxSteps: number;
  readonly maxOutputBytes: number;
  readonly requestTimeoutMs: number;
  readonly autoApprove: boolean;
  readonly compact: Readonly<CompactSettings>;
  readonly configPath: string;
  readonly globalConfigRoot: string;
  readonly sessionsRetentionDays: number;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly availableMcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly toolIds: readonly string[];
  readonly skillIds: readonly string[];
  readonly hookIds: readonly string[];
  readonly packageTools: Readonly<Record<string, PackageAsset>>;
  readonly packageSkills: Readonly<Record<string, PackageAsset>>;
  readonly packageHooks: Readonly<Record<string, PackageAsset>>;
  readonly packageMcpIdentities: Readonly<Record<string, string>>;
  readonly packageMcpSources: Readonly<Record<string, { root: string; identity: string }>>;
  readonly toolRules: readonly ToolPolicyRule[];
  resolveCompactModelConfig(): Readonly<ResolvedModelConfig>;
}

export interface LoadConfigOptions {
  flags?: RawFlags;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  configPath?: string;
  requireModel?: boolean;
}

export interface ConfigDocument {
  path: string;
  data: JsonObject;
  exists: boolean;
}

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function keys(value: JsonObject, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown ${context} field: ${key}`);
  }
}

function string(value: unknown, context: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${context} must be a nonempty string`);
  }
  return value;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be boolean`);
  return value;
}

function positive(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value;
}

function nonnegative(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a nonnegative integer`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, context: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${context} is unsupported`);
  }
  return value as T;
}

function checkDuplicates(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      if (!keyNode) throw new Error("invalid JSON config property");
      const name = getNodeValue(keyNode);
      if (typeof name !== "string") throw new Error("invalid JSON config property");
      if (seen.has(name)) throw new Error(`duplicate JSON config field: ${name}`);
      seen.add(name);
    }
  }
  for (const child of node.children ?? []) checkDuplicates(child);
}

export function configFilePath(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const chosen = options.configPath ?? options.flags?.configPath;
  if (chosen !== undefined) return resolve(cwd, string(chosen, "config path"));
  const base = env.XDG_CONFIG_HOME
    ? resolve(cwd, env.XDG_CONFIG_HOME)
    : join(options.home ?? homedir(), ".config");
  return join(base, "raw", "config.json");
}

export function canonicalConfigPath(options: LoadConfigOptions = {}): string {
  const { configPath: _path, flags, ...rest } = options;
  const { configPath: _flagPath, ...otherFlags } = flags ?? {};
  return configFilePath({ ...rest, flags: otherFlags });
}

function sessionsSpec(raw: unknown): number {
  if (raw === undefined) return 7;
  const value = object(raw, "sessions");
  keys(value, ["retention_days"], "sessions");
  return value.retention_days === undefined ? 7 : positive(value.retention_days, "sessions.retention_days");
}

function parseConfigDocument(options: LoadConfigOptions, validateAgents: boolean): ConfigDocument {
  const path = configFilePath(options);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !options.configPath && !options.flags?.configPath) {
      return { path, data: {}, exists: false };
    }
    throw new Error(`cannot read config file: ${path}`);
  }
  return parseConfigSource(source, options, validateAgents);
}

export function parseConfigSource(source: string, options: LoadConfigOptions = {}, validateAgents = true): ConfigDocument {
  const path = configFilePath(options);
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) throw new Error(`invalid JSON config: ${path}`);
  checkDuplicates(tree);
  const data = object(getNodeValue(tree), "config root");
  keys(data, ["default_agent", "models", "agents", "mcp", "sessions", "ui", "vars", "var_providers"], "config");
  parseUiDocument(data.ui);
  if (data.sessions !== undefined && path !== canonicalConfigPath(options)) {
    throw new Error("sessions settings are allowed only in the canonical global config");
  }
  sessionsSpec(data.sessions);
  if (validateAgents) validateDocument(data);
  return { path, data, exists: true };
}

export function readConfigDocument(options: LoadConfigOptions = {}): ConfigDocument {
  return parseConfigDocument(options, true);
}

export function readSessionRetentionDays(options: LoadConfigOptions = {}): number {
  const { configPath: _path, flags, ...rest } = options;
  const { configPath: _flagPath, ...otherFlags } = flags ?? {};
  const canonical = parseConfigDocument({ ...rest, flags: otherFlags }, false);
  return sessionsSpec(canonical.data.sessions);
}

function cacheOptions(value: unknown, provider: ProviderName, method: ApiMethod, context: string): CacheOptions {
  const data = object(value, context);
  keys(data, ["mode", "key", "retention", "backend"], context);
  const result: CacheOptions = {};
  if (data.mode !== undefined) result.mode = enumValue(data.mode, new Set(["auto", "no-hints"]), `${context}.mode`);
  if (data.key !== undefined) result.key = string(data.key, `${context}.key`);
  if (data.retention !== undefined) {
    if (provider !== "openai" && provider !== "anthropic") throw new Error(`${context}.retention is unsupported for ${provider}`);
    result.retention = string(data.retention, `${context}.retention`);
  }
  if (data.backend !== undefined) {
    result.backend = enumValue(data.backend, new Set(["generic", "llama.cpp"]), `${context}.backend`);
    if (result.backend === "llama.cpp" && method !== "openai-chat-completions") {
      throw new Error(`${context}.backend is unsupported for ${provider}`);
    }
  }
  if (result.key !== undefined && provider !== "openai") throw new Error(`${context}.key is unsupported for ${provider}`);
  return result;
}

interface ModelSpec {
  provider: ProviderName;
  method: ApiMethod;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision: boolean;
}

interface AgentSpec {
  modelAlias: string;
  toolIds: readonly string[];
  skillIds: readonly string[];
  hookIds: readonly string[];
  systemPrompt?: string;
  systemPromptFile?: string;
  toolRules: readonly ToolPolicyRule[];
  request?: ModelRequestOptions;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  cache?: CacheOptions;
  compact: CompactSettings;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(where + " must be a nonempty string array");
  return value as string[];
}

function argumentStrings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(where + " must be a string array");
  return value as string[];
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const data = object(value, where);
  for (const [key, item] of Object.entries(data)) if (!key || typeof item !== "string") throw new Error(where + " must contain string values");
  return data as Record<string, string>;
}

function mcpServersSpec(raw: unknown): Map<string, McpServerConfig> {
  if (raw === undefined) return new Map();
  const mcp = object(raw, "mcp");
  keys(mcp, ["servers"], "mcp");
  const servers = mcp.servers === undefined ? {} : object(mcp.servers, "mcp.servers");
  const result = new Map<string, McpServerConfig>();
  for (const [name, entry] of Object.entries(servers)) {
    string(name, "MCP server name");
    const where = "mcp.servers." + name;
    const spec = object(entry, where);
    const transport = enumValue(spec.transport, new Set<"stdio" | "streamable-http">(["stdio", "streamable-http"]), where + ".transport");
    if (transport === "stdio") {
      keys(spec, ["transport", "command", "args", "env", "panels"], where);
      result.set(name, { command: string(spec.command, where + ".command"),
        ...(spec.panels !== undefined ? { panels: parseMcpPanels(spec.panels, where + ".panels") } : {}),
        ...(spec.args !== undefined ? { args: argumentStrings(spec.args, where + ".args") } : {}),
        ...(spec.env !== undefined ? { env: stringMap(spec.env, where + ".env") } : {}) });
    } else {
      keys(spec, ["transport", "url", "headers", "panels"], where);
      result.set(name, { transport: "streamable-http", url: endpoint(spec.url, where + ".url"),
        ...(spec.panels !== undefined ? { panels: parseMcpPanels(spec.panels, where + ".panels") } : {}),
        ...(spec.headers !== undefined ? { headers: stringMap(spec.headers, where + ".headers") } : {}) });
    }
  }
  return result;
}

function toolSpec(raw: unknown, where: string): { ids: readonly string[]; rules: readonly ToolPolicyRule[] } {
  if (raw === undefined) throw new Error(where + ".use is required");
  const value = object(raw, where);
  keys(value, ["use", "rules"], where);
  if (!Array.isArray(value.use)) throw new Error(where + ".use must be an array");
  const ids = value.use.map((id, index) => {
    const name = string(id, `${where}.use[${index}]`);
    if (!/^(?:builtin|local|agent)\/[a-z][a-z0-9_-]*$/.test(name)
      && !/^pkg\/[a-z][a-z0-9_-]*\/tools\/[a-z][a-z0-9_-]*$/.test(name)
      && !/^pkgdep\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*\/tools\/[a-z][a-z0-9_-]*$/.test(name)
      && !/^mcp\/[^/\s]+\/[^/\s]+$/.test(name)) throw new Error(`invalid tool id: ${name}`);
    return name;
  });
  if (new Set(ids).size !== ids.length) throw new Error(where + ".use contains duplicate IDs");
  return { ids, rules: parseToolPolicyRules(value.rules, where + ".rules") };
}

export function parseToolPolicyRules(raw: unknown, where = "tools.rules"): ToolPolicyRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(where + " must be an array");
  return raw.map((rawRule, index) => {
    const ruleWhere = `${where}[${index}]`;
    const rule = object(rawRule, ruleWhere);
    keys(rule, ["match", "effect", "when"], ruleWhere);
    const match = string(rule.match, ruleWhere + ".match");
    if (match.length > 256) throw new Error(ruleWhere + ".match is too long");
    const effect = enumValue(rule.effect, new Set<"allow" | "ask" | "deny">(["allow", "ask", "deny"]), ruleWhere + ".effect");
    let when: ToolPolicyRule["when"];
    if (rule.when !== undefined) {
      if (effect !== "ask") throw new Error(ruleWhere + " conditional effect must be ask");
      const predicate = object(rule.when, ruleWhere + ".when");
      keys(predicate, ["source", "any", "regex"], ruleWhere + ".when");
      when = { source: enumValue(predicate.source, new Set<"arguments" | "effects">(["arguments", "effects"]), ruleWhere + ".when.source"),
        any: string(predicate.any, ruleWhere + ".when.any"),
        regex: string(predicate.regex, ruleWhere + ".when.regex") };
      compileWhen(when);
    }
    return { match, effect, ...(when ? { when } : {}) };
  });
}

function skillSpec(raw: unknown, where: string): readonly string[] {
  if (raw === undefined) return [];
  const value = object(raw, where);
  keys(value, ["use"], where);
  if (!Array.isArray(value.use)) throw new Error(where + ".use must be an array");
  const ids = value.use.map((id, index) => {
    const name = string(id, `${where}.use[${index}]`);
    if (!/^(?:builtin|local|agent)\/[a-z][a-z0-9_-]*$/.test(name)
      && !/^pkg\/[a-z][a-z0-9_-]*\/skills\/[a-z][a-z0-9_-]*$/.test(name)
      && !/^pkgdep\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*\/skills\/[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid skill id: ${name}`);
    return name;
  });
  if (new Set(ids).size !== ids.length) throw new Error(where + ".use contains duplicate IDs");
  return ids;
}

function hookSpec(raw: unknown, where: string): readonly string[] {
  if (raw === undefined) return [];
  const value = object(raw, where);
  keys(value, ["use"], where);
  if (!Array.isArray(value.use)) throw new Error(`${where}.use must be an array`);
  const ids = value.use.map((item, index) => {
    const id = string(item, `${where}.use[${index}]`);
    if (!/^(?:agent|local)\/[a-z][a-z0-9_-]*$/.test(id)
      && !/^pkg\/[a-z][a-z0-9_-]*\/hooks\/[a-z][a-z0-9_-]*$/.test(id)
      && !/^pkgdep\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*\/hooks\/[a-z][a-z0-9_-]*$/.test(id)) {
      throw new Error(`invalid hook id: ${id}`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${where}.use contains duplicate IDs`);
  return ids;
}

function endpoint(value: unknown, context: string): string {
  const address = string(value, context);
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error(context + " must be an HTTP(S) URL");
  }
  return address;
}

function defaultEndpoint(provider: ProviderName, method: ApiMethod): string | undefined {
  if (method !== "openai-chat-completions") return undefined;
  if (provider === "ollama") return "http://127.0.0.1:11434/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return undefined;
}

function usesOfficialEndpoint(provider: ProviderName, method: ApiMethod): boolean {
  return (provider === "openai" && (method === "openai-chat-completions" || method === "openai-responses"))
    || (provider === "anthropic" && method === "anthropic-messages")
    || (provider === "google" && method === "google-generate-content");
}

function requestSpec(raw: unknown, model: ModelSpec, where: string): ModelRequestOptions {
  const value = object(raw, where);
  const common = ["max_output_tokens"];
  const kind = requestKind(model.provider, model.method);
  const isOpenAi = kind === "openai";
  const isDeepSeek = kind === "deepseek";
  const isAnthropic = kind === "anthropic";
  const isGoogle = kind === "google";
  const allowed = isOpenAi ? [...common, "service_tier", "reasoning_effort", ...(model.method === "openai-responses" ? ["reasoning_mode"] : [])]
    : isDeepSeek ? [...common, "thinking", "reasoning_effort"]
    : isAnthropic ? [...common, "thinking", "effort", "service_tier"]
    : isGoogle ? [...common, "thinking_level", "thinking_budget"] : common;
  keys(value, allowed, where);
  const base: { maxOutputTokens?: number } = {};
  if (value.max_output_tokens !== undefined) {
    const limit = positive(value.max_output_tokens, where + ".max_output_tokens");
    if (model.maxOutputTokens !== undefined && limit > model.maxOutputTokens) throw new Error(where + ".max_output_tokens exceeds model capability");
    if (model.contextWindow !== undefined) {
      const reserve = Math.max(64, Math.ceil(model.contextWindow * 0.05));
      if (limit > model.contextWindow - reserve) throw new Error(where + ".max_output_tokens exceeds context budget after reserve");
    }
    base.maxOutputTokens = limit;
  }
  if (isOpenAi) return { kind: "openai", ...base,
    ...(value.service_tier !== undefined ? { serviceTier: enumValue(value.service_tier, new Set(OPENAI_TIERS), where + ".service_tier") } : {}),
    ...(value.reasoning_effort !== undefined ? { reasoningEffort: enumValue(value.reasoning_effort, new Set(OPENAI_EFFORTS), where + ".reasoning_effort") } : {}),
    ...(value.reasoning_mode !== undefined ? { reasoningMode: enumValue(value.reasoning_mode, new Set(["standard", "pro"]), where + ".reasoning_mode") } : {}),
  };
  if (isDeepSeek) {
    const thinking = value.thinking === undefined ? undefined : enumValue(value.thinking, new Set<"enabled" | "disabled">(["enabled", "disabled"]), where + ".thinking");
    if (thinking === "disabled" && value.reasoning_effort !== undefined) throw new Error(where + ".reasoning_effort requires thinking enabled");
    return { kind: "deepseek", ...base,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(value.reasoning_effort !== undefined ? { reasoningEffort: enumValue(value.reasoning_effort, new Set(DEEPSEEK_EFFORTS), where + ".reasoning_effort") } : {}),
    };
  }
  if (isAnthropic) {
    let thinking: Extract<ModelRequestOptions, { kind: "anthropic" }>["thinking"];
    if (value.thinking !== undefined) {
      const spec = object(value.thinking, where + ".thinking");
      const type = enumValue(spec.type, new Set<"adaptive" | "disabled" | "enabled">(["adaptive", "disabled", "enabled"]), where + ".thinking.type");
      keys(spec, type === "enabled" ? ["type", "budget_tokens"] : ["type"], where + ".thinking");
      thinking = type === "enabled" ? { type, budgetTokens: positive(spec.budget_tokens, where + ".thinking.budget_tokens") } : { type };
      if (thinking.type === "enabled" && thinking.budgetTokens < 1024) throw new Error(where + ".thinking.budget_tokens must be at least 1024");
      if (thinking.type === "enabled" && thinking.budgetTokens >= effectiveOutputTokens({ ...model, request: base as ModelRequestOptions })) {
        throw new Error(where + ".thinking.budget_tokens must be smaller than the requested output cap");
      }
    }
    return { kind: "anthropic", ...base, ...(thinking ? { thinking } : {}),
      ...(value.effort !== undefined ? { effort: enumValue(value.effort, new Set(ANTHROPIC_EFFORTS), where + ".effort") } : {}),
      ...(value.service_tier !== undefined ? { serviceTier: enumValue(value.service_tier, new Set(ANTHROPIC_TIERS), where + ".service_tier") } : {}),
    };
  }
  if (isGoogle) {
    if (value.thinking_level !== undefined && value.thinking_budget !== undefined) throw new Error(where + " must choose thinking_level or thinking_budget");
    return { kind: "google", ...base,
      ...(value.thinking_level !== undefined ? { thinkingLevel: enumValue(value.thinking_level, new Set(GOOGLE_LEVELS), where + ".thinking_level") } : {}),
      ...(value.thinking_budget !== undefined ? { thinkingBudget: nonnegative(value.thinking_budget, where + ".thinking_budget") } : {}),
    };
  }
  return { kind: "generic", ...base };
}

function modelSpec(name: string, raw: unknown): ModelSpec {
  const where = "model " + name;
  const value = object(raw, where);
  keys(value, ["provider", "method", "model_id", "base_url", "api_key", "api_key_env", "context_window_tokens", "max_output_tokens", "vision"], where);
  const provider = string(value.provider, where + ".provider");
  if (provider === "openai-compatible") throw new Error(where + ".provider must identify a service, not an API method");
  const method = enumValue(value.method, apiMethods, where + ".method");
  const result: ModelSpec = {
    provider,
    method,
    model: string(value.model_id, where + ".model_id"),
    vision: value.vision === undefined ? false : booleanValue(value.vision, where + ".vision"),
  };
  if (value.base_url !== undefined) result.baseUrl = endpoint(value.base_url, where + ".base_url");
  if (value.api_key !== undefined && value.api_key_env !== undefined) throw new Error(where + " must choose api_key or api_key_env");
  if (value.api_key !== undefined) result.apiKey = string(value.api_key, where + ".api_key");
  if (value.api_key_env !== undefined) {
    const key = string(value.api_key_env, where + ".api_key_env");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(where + ".api_key_env is invalid");
    result.apiKeyEnv = key;
  }
  if (value.context_window_tokens !== undefined) result.contextWindow = positive(value.context_window_tokens, where + ".context_window_tokens");
  if (value.max_output_tokens !== undefined) result.maxOutputTokens = positive(value.max_output_tokens, where + ".max_output_tokens");
  if (result.contextWindow !== undefined && result.maxOutputTokens !== undefined && result.maxOutputTokens >= result.contextWindow) {
    throw new Error(where + ".max_output_tokens must be smaller than context_window_tokens");
  }
  if (result.baseUrl === undefined) {
    const fallback = defaultEndpoint(provider, method);
    if (fallback !== undefined) result.baseUrl = fallback;
  }
  if (!result.baseUrl && !usesOfficialEndpoint(provider, method)) throw new Error(where + ".base_url is required for this provider/method combination");
  return result;
}

function compactSpec(raw: unknown, where: string, model: Parameters<typeof defaultCompactOutputTokens>[0] = {}): CompactSettings {
  const value = raw === undefined ? {} : object(raw, where);
  keys(value, ["keep_recent_turns", "max_output_tokens", "trigger_tokens"], where);
  return {
    keepRecentTurns: value.keep_recent_turns === undefined ? 2 : nonnegative(value.keep_recent_turns, where + ".keep_recent_turns"),
    maxOutputTokens: value.max_output_tokens === undefined ? defaultCompactOutputTokens(model)
      : positive(value.max_output_tokens, where + ".max_output_tokens"),
    ...(value.trigger_tokens === undefined ? {} : { triggerTokens: positive(value.trigger_tokens, where + ".trigger_tokens") }),
  };
}

function agentSpec(name: string, raw: unknown, models: ReadonlyMap<string, ModelSpec>): AgentSpec {
  const where = "agent " + name;
  const value = object(raw, where);
  keys(value, ["model", "request", "max_steps", "max_output_bytes", "request_timeout_ms", "cache", "compact", "tools", "skills", "hooks", "system_prompt", "system_prompt_file", "vars"], where);
  const modelAlias = string(value.model, where + ".model");
  const model = models.get(modelAlias);
  if (!model) throw new Error(where + " references unknown model: " + modelAlias);
  const tools = toolSpec(value.tools, where + ".tools");
  const skillIds = skillSpec(value.skills, where + ".skills");
  const hookIds = hookSpec(value.hooks, where + ".hooks");
  if (skillIds.length && (!["builtin/list_skills", "builtin/load_skill"].every((id) => tools.ids.includes(id)))) {
    throw new Error(where + " with skills.use requires builtin/list_skills and builtin/load_skill in tools.use");
  }
  if (value.system_prompt !== undefined && value.system_prompt_file !== undefined) throw new Error(where + " must choose system_prompt or system_prompt_file");
  const request = value.request === undefined ? undefined : requestSpec(value.request, model, where + ".request");
  const result: AgentSpec = { modelAlias, compact: compactSpec(value.compact, where + ".compact", { ...model, request }),
    ...(request !== undefined ? { request } : {}), toolIds: tools.ids, skillIds, hookIds, toolRules: tools.rules,
    ...(value.system_prompt !== undefined ? { systemPrompt: string(value.system_prompt, where + ".system_prompt", true) } : {}),
    ...(value.system_prompt_file !== undefined ? { systemPromptFile: string(value.system_prompt_file, where + ".system_prompt_file") } : {}) };
  const requestedCap = result.request?.maxOutputTokens ?? model.maxOutputTokens;
  if (result.compact.triggerTokens !== undefined) {
    if (model.contextWindow === undefined) throw new Error(where + ".compact.trigger_tokens requires model.context_window_tokens");
    const reserve = effectiveOutputTokens({ ...model, ...(result.request ? { request: result.request } : {}) });
    const margin = Math.max(64, Math.ceil(model.contextWindow * 0.05));
    if (result.compact.triggerTokens >= model.contextWindow - reserve - margin) {
      throw new Error(where + ".compact.trigger_tokens must leave output reserve and safety margin");
    }
    if (result.compact.maxOutputTokens >= model.contextWindow - margin) {
      throw new Error(where + ".compact.max_output_tokens exceeds context budget");
    }
  }
  if (requestedCap !== undefined && model.contextWindow !== undefined) {
    const reserve = Math.max(64, Math.ceil(model.contextWindow * 0.05));
    if (requestedCap > model.contextWindow - reserve) throw new Error(where + " output cap exceeds context budget after reserve");
  }
  if (result.request?.kind === "anthropic" && result.request.thinking?.type === "enabled"
    && result.compact.maxOutputTokens <= result.request.thinking.budgetTokens) {
    throw new Error(where + ".compact.max_output_tokens must exceed the thinking budget");
  }
  if (value.max_steps !== undefined) result.maxSteps = positive(value.max_steps, where + ".max_steps");
  if (value.max_output_bytes !== undefined) result.maxOutputBytes = positive(value.max_output_bytes, where + ".max_output_bytes");
  if (value.request_timeout_ms !== undefined) result.requestTimeoutMs = positive(value.request_timeout_ms, where + ".request_timeout_ms");
  if (value.cache !== undefined) result.cache = cacheOptions(value.cache, model.provider, model.method, where + ".cache");
  return result;
}

function parseDocument(root: JsonObject): { models: Map<string, ModelSpec>; agents: Map<string, AgentSpec>; servers: Map<string, McpServerConfig>; defaultName?: string } {
  const varDefinitions = parseVariableDefinitions(root.vars, root.var_providers, ".");
  const servers = mcpServersSpec(root.mcp);
  const modelsData = root.models === undefined ? {} : object(root.models, "models");
  const models = new Map<string, ModelSpec>();
  for (const [name, raw] of Object.entries(modelsData)) models.set(string(name, "model alias"), modelSpec(name, raw));
  const agentsData = root.agents === undefined ? {} : object(root.agents, "agents");
  const agents = new Map<string, AgentSpec>();
  for (const [name, raw] of Object.entries(agentsData)) agents.set(string(name, "agent name"), agentSpec(name, raw, models));
  for (const [name, raw] of Object.entries(agentsData)) selectVariables((raw as JsonObject).vars, varDefinitions.variables, `agents.${name}.vars`);
  const defaultName = root.default_agent === undefined ? undefined : string(root.default_agent, "default_agent");
  if (defaultName !== undefined && !agents.has(defaultName)) throw new Error("unknown agent: " + defaultName);
  return { models, agents, servers, ...(defaultName !== undefined ? { defaultName } : {}) };
}

function validateDocument(root: JsonObject): void {
  const agents = root.agents === undefined ? {} : object(root.agents, "agents");
  if (root.default_agent !== undefined && (typeof root.default_agent !== "string" || !Object.hasOwn(agents, root.default_agent))) {
    throw new Error(`unknown agent: ${String(root.default_agent)}`);
  }
  for (const [name, value] of Object.entries(agents)) {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "from")) {
      const binding = validatePackageAgentBinding(value);
      if (!Object.hasOwn(object(root.models ?? {}, "models"), binding.model)) throw new Error(`agent ${name} references unknown model: ${binding.model}`);
    }
  }
  const direct = Object.fromEntries(Object.entries(agents).filter(([, value]) =>
    !value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "from")).map(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [name, value];
    const copy = structuredClone(value) as JsonObject;
    for (const kind of ["tools", "skills"] as const) {
      const use = (copy[kind] as { use?: unknown } | undefined)?.use;
      if (Array.isArray(use)) (copy[kind] as { use: unknown[] }).use = use.map((item) =>
        typeof item === "string" ? item : parseSelectionReference(item).ref);
    }
    if (Array.isArray(copy.vars)) copy.vars = copy.vars.filter((item) => typeof item === "string" && !item.startsWith("pkg/"));
    return [name, copy];
  }));
  const placeholderBindings = (value: unknown, kind: "vars" | "var_providers" | "mcp"): JsonObject =>
    Object.fromEntries(Object.entries(value === undefined ? {} : object(value, "package bindings"))
      .map(([name, item]) => [name, item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, "from")
        ? kind === "vars" ? { description: "Package binding", access: "read", source: { kind: "literal", value: null } }
          : kind === "var_providers" ? { command: "true" } : { transport: "stdio", command: "true" }
        : item]));
  const mcp = root.mcp === undefined ? undefined : object(root.mcp, "mcp");
  parseDocument({ ...root, agents: direct, vars: placeholderBindings(root.vars, "vars"),
    var_providers: placeholderBindings(root.var_providers, "var_providers"),
    ...(mcp === undefined ? {} : { mcp: { ...mcp, servers: placeholderBindings(mcp.servers, "mcp") } }),
    ...(!root.default_agent || Object.hasOwn(direct, String(root.default_agent))
    ? {} : { default_agent: undefined }) });
}
export function validateEffectiveConfigData(data: Record<string, unknown>): void { parseDocument(data); }

function resolveKey(modelConfig: ResolvedModelConfig, env: NodeJS.ProcessEnv): ResolvedModelConfig {
  if (modelConfig.apiKey) return modelConfig;
  let apiKeyEnv = modelConfig.apiKeyEnv;
  if (!apiKeyEnv) {
    if (modelConfig.provider === "openai") apiKeyEnv = "OPENAI_API_KEY";
    if (modelConfig.provider === "anthropic") apiKeyEnv = "ANTHROPIC_API_KEY";
    if (modelConfig.provider === "google") apiKeyEnv = env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
    if (modelConfig.provider === "openrouter") apiKeyEnv = "OPENROUTER_API_KEY";
  }
  if (!apiKeyEnv) return modelConfig;
  const key = env[apiKeyEnv];
  if (!key) throw new Error("missing credential environment variable " + apiKeyEnv);
  return { ...modelConfig, apiKey: key, apiKeyEnv };
}

function numberOption(flag: number | undefined, env: string | undefined, agent: number | undefined, fallback: number, name: string): number {
  if (flag !== undefined) return positive(flag, name);
  if (env !== undefined) {
    if (!/^[0-9]+$/.test(env)) throw new Error(name + " must be a positive integer");
    return positive(Number(env), name);
  }
  return agent ?? fallback;
}

function freezeModelConfig(modelConfig: ResolvedModelConfig): Readonly<ResolvedModelConfig> {
  if (modelConfig.cache) Object.freeze(modelConfig.cache);
  if (modelConfig.request) {
    if (modelConfig.request.kind === "anthropic" && modelConfig.request.thinking) Object.freeze(modelConfig.request.thinking);
    Object.freeze(modelConfig.request);
  }
  return Object.freeze(modelConfig);
}

function selectAgentName(parsed: ReturnType<typeof parseDocument>, flags: RawFlags, env: NodeJS.ProcessEnv): string | undefined {
  const selected = flags.agent ?? env.RAW_AGENT ?? parsed.defaultName;
  if (selected !== undefined && !parsed.agents.has(selected)) throw new Error("unknown agent: " + selected);
  return selected;
}
function variableProjection(document: ConfigDocument, agentName?: string): VariableConfig {
  const configDir = dirname(document.path);
  const definitions = parseVariableDefinitions(document.data.vars, document.data.var_providers, configDir);
  const agents = document.data.agents as Record<string, JsonObject> | undefined;
  return Object.freeze({ ...(agentName === undefined ? {} : { agentName }), configDir,
    variables: selectVariables(agentName === undefined ? undefined : agents?.[agentName]?.vars, definitions.variables, "agent.vars"),
    providers: definitions.providers });
}
export function loadVariableConfig(options: LoadConfigOptions = {}): VariableConfig {
  const document = readConfigDocument(options);
  const selected = selectAgentName(parseDocument(document.data), options.flags ?? {}, options.env ?? process.env);
  if (selected === undefined) throw new Error("agent is required");
  return variableProjection(document, selected);
}

export async function loadVariableConfigAsync(options: LoadConfigOptions = {}): Promise<VariableConfig> {
  const document = readConfigDocument(options);
  const agents = document.data.agents === undefined ? {} : object(document.data.agents, "agents");
  const selected = options.flags?.agent ?? (options.env ?? process.env).RAW_AGENT
    ?? (document.data.default_agent as string | undefined);
  if (!selected || !Object.hasOwn(agents, selected)) throw new Error(`unknown agent: ${selected ?? "<none>"}`);
  const binding = object(agents[selected], `agent ${selected}`);
  const originAlias = typeof binding.from === "string"
    ? /^pkg\/([a-z][a-z0-9_-]*)\/agents\//.exec(binding.from)?.[1] : undefined;
  const packageOptions = { configPath: document.path, ...(options.env ? { env: options.env } : {}) };
  const packageContext = createPackageResolutionContext();
  const agent = originAlias ? await resolvePackageAgentBinding(binding, packageOptions, packageContext)
    : structuredClone(binding);
  agent.tools = { use: [] };
  const definitions = await resolvePackageDefinitions(agent, document.data, packageOptions, originAlias, packageContext,
    originAlias ? binding.inputs as JsonObject | undefined : undefined);
  const configDir = dirname(document.path);
  const parsed = parseVariableDefinitions(definitions.vars, definitions.var_providers, configDir);
  return Object.freeze({ agentName: selected, configDir,
    variables: selectVariables(agent.vars, parsed.variables, "agent.vars"), providers: parsed.providers });
}

/** Resolve one explicitly requested MCP definition without selecting or connecting tools. */
export async function loadMcpCheckConfig(options: LoadConfigOptions, name: string): Promise<{ server: McpServerConfig; identity?: string }> {
  const document = readConfigDocument(options), env = options.env ?? process.env;
  const selectedName = options.flags?.agent ?? env.RAW_AGENT ?? document.data.default_agent;
  if (typeof selectedName !== "string") throw new Error("Select an agent for MCP discovery");
  const binding = object(object(document.data.agents, "agents")[selectedName], "agent");
  const origin = typeof binding.from === "string" ? /^pkg\/([a-z][a-z0-9_-]*)\/agents\//.exec(binding.from)?.[1] : undefined;
  const packageOptions = { configPath: document.path, env }, context = createPackageResolutionContext();
  const agent = origin ? await resolvePackageAgentBinding(binding, packageOptions, context) : structuredClone(binding);
  agent.tools = { use: [] }; agent.vars = [];
  const definitions = await resolvePackageDefinitions(agent, document.data, packageOptions, origin, context,
    origin ? binding.inputs as JsonObject | undefined : undefined, [name]);
  const server = mcpServersSpec(definitions.mcp).get(name);
  if (!server) throw new Error(`Unknown MCP server: ${name}`);
  return { server, ...(definitions.mcpIdentities[name] ? { identity: definitions.mcpIdentities[name] } : {}) };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  if (env.RAW_PROFILE !== undefined) throw new Error("RAW_PROFILE was removed; use RAW_AGENT");
  for (const removed of ["RAW_PROVIDER", "RAW_MODEL", "RAW_BASE_URL"]) {
    if (env[removed] !== undefined) throw new Error(removed + " was removed; select a configured agent instead");
  }
  const flags = options.flags ?? {};
  const document = readConfigDocument(options);
  const ui = resolveUiOptions(parseUiDocument(document.data.ui), flags);
  const sessionsRetentionDays = readSessionRetentionDays(options);
  const configuredAgents = document.data.agents === undefined ? {} : object(document.data.agents, "agents");
  const wanted = flags.agent ?? env.RAW_AGENT ?? (document.data.default_agent as string | undefined);
  if (wanted !== undefined && !Object.hasOwn(configuredAgents, wanted)) throw new Error("unknown agent: " + wanted);
  const agentData = wanted === undefined ? undefined : configuredAgents[wanted];
  const packageContext = createPackageResolutionContext();
  const effective = agentData && typeof agentData === "object" && !Array.isArray(agentData) && Object.hasOwn(agentData, "from")
    ? await resolvePackageAgentBinding(agentData, { configPath: document.path, env }, packageContext) : agentData;
  const packageSelection = effective === undefined ? undefined
    : await resolvePackageSelections(effective, { configPath: document.path, env }, packageContext);
  const activeAgents: Record<string, unknown> = {};
  if (wanted !== undefined) activeAgents[wanted] = packageSelection?.agent;
  const originAlias = agentData && typeof agentData === "object" && !Array.isArray(agentData)
    && typeof (agentData as { from?: unknown }).from === "string"
    ? /^pkg\/([a-z][a-z0-9_-]*)\/agents\//.exec((agentData as { from: string }).from)?.[1] : undefined;
  const packageDefinitions = packageSelection === undefined ? { mcpIdentities: {} as Record<string, string>,
    mcpSources: {} as Record<string, { root: string; identity: string }> }
    : await resolvePackageDefinitions(packageSelection.agent, document.data, { configPath: document.path, env }, originAlias,
      packageContext, originAlias ? (agentData as { inputs?: JsonObject }).inputs : undefined);
  const { mcpIdentities, mcpSources, ...definitions } = packageDefinitions;
  const effectiveDocument: ConfigDocument = { ...document, data: { ...document.data, agents: activeAgents,
    ...definitions,
    ...(wanted === undefined ? { default_agent: undefined } : { default_agent: wanted }) } };
  const parsed = parseDocument(effectiveDocument.data);
  const selectedName = selectAgentName(parsed, flags, env);
  const selectedSpec = selectedName === undefined ? undefined : parsed.agents.get(selectedName);
  const model = selectedSpec === undefined ? undefined : parsed.models.get(selectedSpec.modelAlias);
  let selected: ResolvedModelConfig | undefined;
  if (selectedName !== undefined && selectedSpec && model) {
    const spec: ResolvedModelConfig = {
      agentName: selectedName,
      modelAlias: selectedSpec.modelAlias,
      provider: model.provider,
      method: model.method,
      model: model.model,
      vision: model.vision,
      ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey } : {}),
      ...(model.apiKeyEnv !== undefined ? { apiKeyEnv: model.apiKeyEnv } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(selectedSpec.cache !== undefined ? { cache: selectedSpec.cache } : {}),
      ...(selectedSpec.request !== undefined ? { request: selectedSpec.request } : {}),
    };
    selected = freezeModelConfig(options.requireModel === false ? spec : resolveKey(spec, env));
  } else if (options.requireModel !== false) {
    throw new Error("agent is required");
  }
  const compact = Object.freeze(selectedSpec?.compact ?? compactSpec(undefined, "compact"));
  const availableMcpServers: Record<string, McpServerConfig> = Object.create(null);
  for (const [name, server] of parsed.servers) availableMcpServers[name] = Object.freeze({ ...server,
    ...("args" in server && server.args ? { args: Object.freeze([...server.args]) } : {}),
    ...("env" in server && server.env ? { env: Object.freeze({ ...server.env }) } : {}),
    ...("headers" in server && server.headers ? { headers: Object.freeze({ ...server.headers }) } : {}),
  });
  const mcpServers: Record<string, McpServerConfig> = Object.create(null);
  for (const id of selectedSpec?.toolIds ?? []) {
    if (!id.startsWith("mcp/")) continue;
    const [, name, tool] = id.split("/");
    const server = availableMcpServers[name!];
    if (!server) continue; // ACP session/new may provide this server at runtime.
    const previous = mcpServers[name!]?.tools;
    mcpServers[name!] = Object.freeze({ ...server, tools: Object.freeze([...(Array.isArray(previous) ? previous : []), tool!]) });
  }
  let agentPrompt = selectedSpec?.systemPrompt;
  if (flags.systemPrompt === undefined && env.RAW_SYSTEM_PROMPT === undefined && selectedSpec?.systemPromptFile !== undefined) {
    const promptPath = resolve(dirname(document.path), selectedSpec.systemPromptFile);
    let bytes: Buffer;
    try { bytes = readFileSync(promptPath); }
    catch { throw new Error(`cannot read system prompt file: ${promptPath}`); }
    try { agentPrompt = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`invalid UTF-8 system prompt file: ${promptPath}`); }
  }
  const toolRules = Object.freeze((selectedSpec?.toolRules ?? []).map((rule) => Object.freeze({ ...rule,
    ...(rule.when ? { when: Object.freeze({ ...rule.when }) } : {}) })));
  return Object.freeze({
    variableConfig: variableProjection(effectiveDocument, selectedName),
    ui,
    ...(selectedName === undefined ? {} : { agentName: selectedName }),
    ...(selected === undefined ? {} : { modelConfig: selected }),
    systemPrompt: flags.systemPrompt ?? env.RAW_SYSTEM_PROMPT ?? agentPrompt ?? resolveSystemPrompt(undefined, undefined),
    maxSteps: numberOption(flags.maxSteps, env.RAW_MAX_STEPS, selectedSpec?.maxSteps, 10000, "max-steps"),
    maxOutputBytes: numberOption(flags.maxOutputBytes, env.RAW_MAX_OUTPUT_BYTES, selectedSpec?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "max-output-bytes"),
    requestTimeoutMs: numberOption(flags.requestTimeoutMs, env.RAW_REQUEST_TIMEOUT_MS, selectedSpec?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "request-timeout-ms"),
    autoApprove: flags.autoApprove ?? true,
    compact,
    configPath: document.path,
    globalConfigRoot: env.XDG_CONFIG_HOME
      ? join(resolve(options.cwd ?? process.cwd(), env.XDG_CONFIG_HOME), "raw")
      : join(options.home ?? homedir(), ".config", "raw"),
    sessionsRetentionDays,
    mcpServers: Object.freeze(mcpServers),
    availableMcpServers: Object.freeze(availableMcpServers),
    toolIds: Object.freeze([...(selectedSpec?.toolIds ?? [])]),
    skillIds: Object.freeze([...(selectedSpec?.skillIds ?? [])]),
    hookIds: Object.freeze([...(selectedSpec?.hookIds ?? [])]),
    packageTools: Object.freeze(packageSelection?.tools ?? {}),
    packageSkills: Object.freeze(packageSelection?.skills ?? {}),
    packageHooks: Object.freeze(packageSelection?.hooks ?? {}),
    packageMcpIdentities: Object.freeze(mcpIdentities ?? {}),
    packageMcpSources: Object.freeze(mcpSources ?? {}),
    toolRules,
    resolveCompactModelConfig() {
      if (!selected) throw new Error("agent is required for compact");
      return options.requireModel === false ? freezeModelConfig(resolveKey(selected, env)) : selected;
    },
  });
}

export function redact(value: string, secrets: string[] = []): string {
  let result = value;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[REDACTED]");
  return result.replace(/https?:\/\/[^\s<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[REDACTED URL]";
    }
  });
}

export function parseCliArgs(argv: string[]): CliArgs {
  const flags: RawFlags = {};
  const positional: string[] = [];
  let interactive = false;
  let acp = false;
  let acpTransport: "stdio" | "ws" | undefined;
  let help = false;
  let version = false;
  let afterDash = false;
  const seen = new Set<string>();
  const valueFlags: Record<string, keyof RawFlags> = {
    "--display": "density", "--reasoning": "reasoning", "--color": "color", "--icons": "icons", "--theme": "theme",
    "--agent": "agent", "--config": "configPath", "--system-prompt": "systemPrompt",
    "--max-steps": "maxSteps", "--max-output-bytes": "maxOutputBytes",
    "--request-timeout-ms": "requestTimeoutMs", "--host": "host", "--port": "port",
    "--resume": "resumeId", "--before": "before",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (afterDash) { positional.push(arg); continue; }
    if (arg === "--") { afterDash = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--version" || arg === "-V") { version = true; continue; }
    if (arg === "--interactive") { interactive = true; continue; }
    if (arg === "--continue" || arg === "--all") {
      if (seen.has(arg)) throw new Error(`duplicate option ${arg}`);
      seen.add(arg);
      if (arg === "--continue") flags.continue = true;
      else flags.allSessions = true;
      continue;
    }
    if (arg === "--json") {
      if (seen.has(arg)) throw new Error(`duplicate option ${arg}`);
      seen.add(arg); flags.json = true;
      continue;
    }
    if (arg === "--acp") { acp = true; continue; }
    if (arg === "--stdio" || arg === "--ws") {
      if (acpTransport) throw new Error("--stdio and --ws are mutually exclusive");
      acpTransport = arg === "--ws" ? "ws" : "stdio";
      continue;
    }
    if (arg === "--auto-approve" || arg === "-y") { flags.autoApprove = true; continue; }
    const key = Object.hasOwn(valueFlags, arg) ? valueFlags[arg] : undefined;
    if (key) {
      if (seen.has(arg)) throw new Error(`duplicate option ${arg}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined || (next.startsWith("--") && arg !== "--system-prompt")) throw new Error(`${arg} requires a value`);
      if (key === "maxSteps" || key === "maxOutputBytes" || key === "requestTimeoutMs" || key === "port") {
        if (!/^[0-9]+$/.test(next)) throw new Error(`${arg} requires a positive integer`);
        const numeric = positive(Number(next), arg);
        if (key === "maxSteps") flags.maxSteps = numeric;
        if (key === "maxOutputBytes") flags.maxOutputBytes = numeric;
        if (key === "requestTimeoutMs") flags.requestTimeoutMs = numeric;
        if (key === "port") flags.port = numeric;
      } else {
        if (key === "density" || key === "reasoning" || key === "color" || key === "icons" || key === "theme") {
          validateUiFlag(key, next);
          (flags as Record<string, unknown>)[key] = next;
        }
        if (key === "agent") flags.agent = next;
        if (key === "configPath") flags.configPath = next;
        if (key === "systemPrompt") flags.systemPrompt = next;
        if (key === "host") flags.host = next;
        if (key === "resumeId") flags.resumeId = next;
        if (key === "before") flags.before = next;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    positional.push(arg);
  }
  if (help) return { command: "help", flags };
  if (version) return { command: "version", flags };
  if (positional[0] === "vars") {
    if (interactive || acp || acpTransport || Object.keys(flags).some(key => key !== "configPath" && key !== "agent")) throw new Error("vars accepts only --config and --agent");
    if (positional.length === 2 && positional[1] === "list") return { command: "vars-list", flags };
    if (positional.length === 3 && positional[1] === "get" && positional[2]) return { command: "vars-get", variableName: positional[2], flags };
    throw new Error("vars requires list or get NAME");
  }
  if (flags.continue && flags.resumeId) throw new Error("--continue and --resume are mutually exclusive");
  if (positional[0] === "sessions") {
    if (interactive || acp || acpTransport || flags.host || flags.port || flags.continue || flags.resumeId
      || flags.agent || flags.configPath || flags.systemPrompt || flags.maxSteps || flags.maxOutputBytes
      || flags.requestTimeoutMs || flags.autoApprove) throw new Error("sessions cannot be combined with run options");
    if (flags.json && positional[1] !== "panels") throw new Error("--json is only available with sessions panels");
    if (positional.length === 1) return { command: "sessions-list", flags };
    if (positional[1] === "show" && positional.length === 3 && !flags.allSessions) {
      return { command: "sessions-show", flags, sessionId: positional[2]! };
    }
    // `--all` here includes closed panels; `--json` prints machine-readable output.
    if (positional[1] === "panels" && (positional.length === 3 || positional.length === 4) && !flags.before) {
      return { command: "sessions-panels", flags, sessionId: positional[2]!, ...(positional[3] ? { panelId: positional[3] } : {}) };
    }
    if (positional[1] === "delete" && positional.length === 3 && !flags.allSessions && !flags.before) {
      return { command: "sessions-delete", flags, sessionId: positional[2]! };
    }
    if (positional[1] === "stats" && positional.length === 2 && !flags.allSessions && !flags.before) {
      return { command: "sessions-stats", flags };
    }
    throw new Error("sessions requires list, show ID, panels ID [PANEL], delete ID, or stats");
  }
  if (flags.allSessions || flags.before) throw new Error("--all and --before require sessions");
  if (flags.json) throw new Error("--json requires sessions panels");
  if (positional[0] === "config") {
    if (positional.length !== 2 || (positional[1] !== "init" && positional[1] !== "list") || interactive || acp
      || flags.continue || flags.resumeId) throw new Error("config requires init or list");
    return { command: positional[1] === "init" ? "config-init" : "config-list", flags };
  }
  if (acp) {
    if (interactive || positional.length || flags.continue || flags.resumeId) throw new Error("--acp cannot be combined with a task, resume, or --interactive");
    return { command: "acp", flags, acpTransport: acpTransport ?? "stdio" };
  }
  if (acpTransport || flags.host || flags.port) throw new Error("ACP transport options require --acp");
  if (interactive && positional.length) throw new Error("--interactive cannot be combined with a task");
  if (positional.length > 1) throw new Error("provide one task string");
  const task = positional[0];
  if (task !== undefined) return { command: "task", task, flags };
  return { command: "interactive", flags };
}
