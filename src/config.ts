import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { resolveSystemPrompt } from "./llm/prompt.js";
import type { ApiMethod, CacheOptions, ProfileRequestOptions, ProviderName, ProviderProfile } from "./llm/types.js";
import type { McpServerConfig } from "./tools/mcp-client.js";
import type { ToolPolicyRule } from "./tools/registry.js";

type JsonObject = Record<string, unknown>;

const apiMethods = new Set<ApiMethod>(["openai-chat-completions", "openai-responses", "anthropic-messages", "google-generate-content"]);

export interface RawFlags {
  profile?: string;
  configPath?: string;
  systemPrompt?: string;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  autoApprove?: boolean;
  host?: string;
  port?: number;
}

export type CliCommand = "help" | "version" | "config-init" | "config-list" | "task" | "interactive" | "acp";

export interface CliArgs {
  command: CliCommand;
  task?: string;
  flags: RawFlags;
  acpTransport?: "stdio" | "ws";
}

export interface CompactSettings {
  keepRecentTurns: number;
  maxOutputTokens: number;
  triggerTokens?: number;
}

export interface RuntimeConfig {
  readonly profile?: Readonly<ProviderProfile>;
  readonly systemPrompt: string;
  readonly maxSteps: number;
  readonly maxOutputBytes: number;
  readonly requestTimeoutMs: number;
  readonly autoApprove: boolean;
  readonly compact: Readonly<CompactSettings>;
  readonly configPath: string;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly toolRules: readonly ToolPolicyRule[];
  resolveCompactProfile(): Readonly<ProviderProfile>;
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

export function readConfigDocument(options: LoadConfigOptions = {}): ConfigDocument {
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
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) throw new Error(`invalid JSON config: ${path}`);
  checkDuplicates(tree);
  const data = object(getNodeValue(tree), "config root");
  keys(data, ["default_profile", "models", "profiles", "mcp"], "config");
  validateDocument(data);
  return { path, data, exists: true };
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

interface ProfileSpec {
  modelAlias: string;
  mcp: Readonly<Record<string, "*" | readonly string[]>>;
  toolRules: readonly ToolPolicyRule[];
  request?: ProfileRequestOptions;
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
      keys(spec, ["transport", "command", "args", "env"], where);
      result.set(name, { command: string(spec.command, where + ".command"),
        ...(spec.args !== undefined ? { args: argumentStrings(spec.args, where + ".args") } : {}),
        ...(spec.env !== undefined ? { env: stringMap(spec.env, where + ".env") } : {}) });
    } else {
      keys(spec, ["transport", "url", "headers"], where);
      result.set(name, { transport: "streamable-http", url: endpoint(spec.url, where + ".url"),
        ...(spec.headers !== undefined ? { headers: stringMap(spec.headers, where + ".headers") } : {}) });
    }
  }
  return result;
}

function profileMcpSpec(raw: unknown, known: ReadonlyMap<string, McpServerConfig>, where: string): Record<string, "*" | readonly string[]> {
  if (raw === undefined) return {};
  const selected = object(raw, where);
  const result: Record<string, "*" | readonly string[]> = Object.create(null);
  for (const [name, selection] of Object.entries(selected)) {
    if (!known.has(name)) throw new Error(where + " references unknown MCP server: " + name);
    if (selection === "*") result[name] = "*";
    else {
      const names = strings(selection, where + "." + name);
      if (new Set(names).size !== names.length) throw new Error(where + "." + name + " contains duplicate tools");
      result[name] = names;
    }
  }
  return result;
}

function toolRulesSpec(raw: unknown, where: string): readonly ToolPolicyRule[] {
  if (raw === undefined) return [];
  const value = object(raw, where);
  keys(value, ["rules"], where);
  if (value.rules === undefined) return [];
  if (!Array.isArray(value.rules)) throw new Error(where + ".rules must be an array");
  return value.rules.map((rawRule, index) => {
    const ruleWhere = `${where}.rules[${index}]`;
    const rule = object(rawRule, ruleWhere);
    keys(rule, ["match", "effect"], ruleWhere);
    return { match: string(rule.match, ruleWhere + ".match"),
      effect: enumValue(rule.effect, new Set<"allow" | "ask" | "deny">(["allow", "ask", "deny"]), ruleWhere + ".effect") };
  });
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

function requestSpec(raw: unknown, model: ModelSpec, where: string): ProfileRequestOptions {
  const value = object(raw, where);
  const common = ["max_output_tokens"];
  const isOpenAi = model.provider === "openai" && (model.method === "openai-chat-completions" || model.method === "openai-responses");
  const isDeepSeek = model.provider === "deepseek" && model.method === "openai-chat-completions";
  const isAnthropic = model.provider === "anthropic" && model.method === "anthropic-messages";
  const isGoogle = model.provider === "google" && model.method === "google-generate-content";
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
    ...(value.service_tier !== undefined ? { serviceTier: enumValue(value.service_tier, new Set(["auto", "default", "flex", "fast", "priority"]), where + ".service_tier") } : {}),
    ...(value.reasoning_effort !== undefined ? { reasoningEffort: enumValue(value.reasoning_effort, new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]), where + ".reasoning_effort") } : {}),
    ...(value.reasoning_mode !== undefined ? { reasoningMode: enumValue(value.reasoning_mode, new Set(["standard", "pro"]), where + ".reasoning_mode") } : {}),
  };
  if (isDeepSeek) {
    const thinking = value.thinking === undefined ? undefined : enumValue(value.thinking, new Set<"enabled" | "disabled">(["enabled", "disabled"]), where + ".thinking");
    if (thinking === "disabled" && value.reasoning_effort !== undefined) throw new Error(where + ".reasoning_effort requires thinking enabled");
    return { kind: "deepseek", ...base,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(value.reasoning_effort !== undefined ? { reasoningEffort: enumValue(value.reasoning_effort, new Set(["low", "high", "max"]), where + ".reasoning_effort") } : {}),
    };
  }
  if (isAnthropic) {
    let thinking: Extract<ProfileRequestOptions, { kind: "anthropic" }>["thinking"];
    if (value.thinking !== undefined) {
      const spec = object(value.thinking, where + ".thinking");
      const type = enumValue(spec.type, new Set<"adaptive" | "disabled" | "enabled">(["adaptive", "disabled", "enabled"]), where + ".thinking.type");
      keys(spec, type === "enabled" ? ["type", "budget_tokens"] : ["type"], where + ".thinking");
      thinking = type === "enabled" ? { type, budgetTokens: positive(spec.budget_tokens, where + ".thinking.budget_tokens") } : { type };
      if (thinking.type === "enabled" && thinking.budgetTokens < 1024) throw new Error(where + ".thinking.budget_tokens must be at least 1024");
      if (thinking.type === "enabled" && thinking.budgetTokens >= (base.maxOutputTokens ?? model.maxOutputTokens ?? 1024)) {
        throw new Error(where + ".thinking.budget_tokens must be smaller than the requested output cap");
      }
    }
    return { kind: "anthropic", ...base, ...(thinking ? { thinking } : {}),
      ...(value.effort !== undefined ? { effort: enumValue(value.effort, new Set(["low", "medium", "high", "xhigh", "max"]), where + ".effort") } : {}),
      ...(value.service_tier !== undefined ? { serviceTier: enumValue(value.service_tier, new Set(["auto", "standard_only"]), where + ".service_tier") } : {}),
    };
  }
  if (isGoogle) {
    if (value.thinking_level !== undefined && value.thinking_budget !== undefined) throw new Error(where + " must choose thinking_level or thinking_budget");
    return { kind: "google", ...base,
      ...(value.thinking_level !== undefined ? { thinkingLevel: enumValue(value.thinking_level, new Set(["minimal", "low", "medium", "high"]), where + ".thinking_level") } : {}),
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

function compactSpec(raw: unknown, where: string): CompactSettings {
  const value = raw === undefined ? {} : object(raw, where);
  keys(value, ["keep_recent_turns", "max_output_tokens", "trigger_tokens"], where);
  return {
    keepRecentTurns: value.keep_recent_turns === undefined ? 2 : nonnegative(value.keep_recent_turns, where + ".keep_recent_turns"),
    maxOutputTokens: value.max_output_tokens === undefined ? 512 : positive(value.max_output_tokens, where + ".max_output_tokens"),
    ...(value.trigger_tokens === undefined ? {} : { triggerTokens: positive(value.trigger_tokens, where + ".trigger_tokens") }),
  };
}

function profileSpec(name: string, raw: unknown, models: ReadonlyMap<string, ModelSpec>, servers: ReadonlyMap<string, McpServerConfig>): ProfileSpec {
  const where = "profile " + name;
  const value = object(raw, where);
  keys(value, ["model", "request", "max_steps", "max_output_bytes", "request_timeout_ms", "cache", "compact", "mcp", "tools"], where);
  const modelAlias = string(value.model, where + ".model");
  const model = models.get(modelAlias);
  if (!model) throw new Error(where + " references unknown model: " + modelAlias);
  const result: ProfileSpec = { modelAlias, compact: compactSpec(value.compact, where + ".compact"),
    mcp: profileMcpSpec(value.mcp, servers, where + ".mcp"), toolRules: toolRulesSpec(value.tools, where + ".tools") };
  if (value.request !== undefined) result.request = requestSpec(value.request, model, where + ".request");
  const requestedCap = result.request?.maxOutputTokens ?? model.maxOutputTokens;
  if (result.compact.triggerTokens !== undefined) {
    if (model.contextWindow === undefined) throw new Error(where + ".compact.trigger_tokens requires model.context_window_tokens");
    const reserve = requestedCap ?? 1024;
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

function parseDocument(root: JsonObject): { models: Map<string, ModelSpec>; profiles: Map<string, ProfileSpec>; servers: Map<string, McpServerConfig>; defaultName?: string } {
  const servers = mcpServersSpec(root.mcp);
  const modelsData = root.models === undefined ? {} : object(root.models, "models");
  const models = new Map<string, ModelSpec>();
  for (const [name, raw] of Object.entries(modelsData)) models.set(string(name, "model alias"), modelSpec(name, raw));
  const profilesData = root.profiles === undefined ? {} : object(root.profiles, "profiles");
  const profiles = new Map<string, ProfileSpec>();
  for (const [name, raw] of Object.entries(profilesData)) profiles.set(string(name, "profile name"), profileSpec(name, raw, models, servers));
  const defaultName = root.default_profile === undefined ? undefined : string(root.default_profile, "default_profile");
  if (defaultName !== undefined && !profiles.has(defaultName)) throw new Error("unknown profile: " + defaultName);
  return { models, profiles, servers, ...(defaultName !== undefined ? { defaultName } : {}) };
}

function validateDocument(root: JsonObject): void { parseDocument(root); }

function resolveKey(profile: ProviderProfile, env: NodeJS.ProcessEnv): ProviderProfile {
  if (profile.apiKey) return profile;
  let apiKeyEnv = profile.apiKeyEnv;
  if (!apiKeyEnv) {
    if (profile.provider === "openai") apiKeyEnv = "OPENAI_API_KEY";
    if (profile.provider === "anthropic") apiKeyEnv = "ANTHROPIC_API_KEY";
    if (profile.provider === "google") apiKeyEnv = env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
    if (profile.provider === "openrouter") apiKeyEnv = "OPENROUTER_API_KEY";
  }
  if (!apiKeyEnv) return profile;
  const key = env[apiKeyEnv];
  if (!key) throw new Error("missing credential environment variable " + apiKeyEnv);
  return { ...profile, apiKey: key, apiKeyEnv };
}

function numberOption(flag: number | undefined, env: string | undefined, profile: number | undefined, fallback: number, name: string): number {
  if (flag !== undefined) return positive(flag, name);
  if (env !== undefined) {
    if (!/^[0-9]+$/.test(env)) throw new Error(name + " must be a positive integer");
    return positive(Number(env), name);
  }
  return profile ?? fallback;
}

function freezeProfile(profile: ProviderProfile): Readonly<ProviderProfile> {
  if (profile.cache) Object.freeze(profile.cache);
  if (profile.request) {
    if (profile.request.kind === "anthropic" && profile.request.thinking) Object.freeze(profile.request.thinking);
    Object.freeze(profile.request);
  }
  return Object.freeze(profile);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  for (const removed of ["RAW_PROVIDER", "RAW_MODEL", "RAW_BASE_URL"]) {
    if (env[removed] !== undefined) throw new Error(removed + " was removed; select a configured profile instead");
  }
  const flags = options.flags ?? {};
  const document = readConfigDocument(options);
  const parsed = parseDocument(document.data);
  const selectedName = flags.profile ?? env.RAW_PROFILE ?? parsed.defaultName;
  if (selectedName !== undefined && !parsed.profiles.has(selectedName)) throw new Error("unknown profile: " + selectedName);
  const selectedSpec = selectedName === undefined ? undefined : parsed.profiles.get(selectedName);
  const model = selectedSpec === undefined ? undefined : parsed.models.get(selectedSpec.modelAlias);
  let selected: ProviderProfile | undefined;
  if (selectedName !== undefined && selectedSpec && model) {
    const spec: ProviderProfile = {
      name: selectedName,
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
    selected = freezeProfile(options.requireModel === false ? spec : resolveKey(spec, env));
  } else if (options.requireModel !== false) {
    throw new Error("profile is required");
  }
  const compact = Object.freeze(selectedSpec?.compact ?? compactSpec(undefined, "compact"));
  const mcpServers: Record<string, McpServerConfig> = Object.create(null);
  for (const [name, selection] of Object.entries(selectedSpec?.mcp ?? {})) {
    const server = parsed.servers.get(name);
    if (!server) throw new Error("unknown MCP server: " + name);
    mcpServers[name] = Object.freeze({ ...server,
      ...("args" in server && server.args ? { args: Object.freeze([...server.args]) } : {}),
      ...("env" in server && server.env ? { env: Object.freeze({ ...server.env }) } : {}),
      ...("headers" in server && server.headers ? { headers: Object.freeze({ ...server.headers }) } : {}),
      tools: selection === "*" ? "*" : Object.freeze([...selection]),
    });
  }
  const toolRules = Object.freeze((selectedSpec?.toolRules ?? []).map((rule) => Object.freeze({ ...rule })));
  return Object.freeze({
    ...(selected === undefined ? {} : { profile: selected }),
    systemPrompt: resolveSystemPrompt(flags.systemPrompt, env.RAW_SYSTEM_PROMPT),
    maxSteps: numberOption(flags.maxSteps, env.RAW_MAX_STEPS, selectedSpec?.maxSteps, 25, "max-steps"),
    maxOutputBytes: numberOption(flags.maxOutputBytes, env.RAW_MAX_OUTPUT_BYTES, selectedSpec?.maxOutputBytes, 8192, "max-output-bytes"),
    requestTimeoutMs: numberOption(flags.requestTimeoutMs, env.RAW_REQUEST_TIMEOUT_MS, selectedSpec?.requestTimeoutMs, 120000, "request-timeout-ms"),
    autoApprove: flags.autoApprove ?? true,
    compact,
    configPath: document.path,
    mcpServers: Object.freeze(mcpServers),
    toolRules,
    resolveCompactProfile() {
      if (!selected) throw new Error("profile is required for compact");
      return options.requireModel === false ? freezeProfile(resolveKey(selected, env)) : selected;
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
    "--profile": "profile", "--config": "configPath", "--system-prompt": "systemPrompt",
    "--max-steps": "maxSteps", "--max-output-bytes": "maxOutputBytes",
    "--request-timeout-ms": "requestTimeoutMs", "--host": "host", "--port": "port",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (afterDash) { positional.push(arg); continue; }
    if (arg === "--") { afterDash = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--version" || arg === "-V") { version = true; continue; }
    if (arg === "--interactive") { interactive = true; continue; }
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
        if (key === "profile") flags.profile = next;
        if (key === "configPath") flags.configPath = next;
        if (key === "systemPrompt") flags.systemPrompt = next;
        if (key === "host") flags.host = next;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    positional.push(arg);
  }
  if (help) return { command: "help", flags };
  if (version) return { command: "version", flags };
  if (positional[0] === "config") {
    if (positional.length !== 2 || (positional[1] !== "init" && positional[1] !== "list") || interactive || acp) throw new Error("config requires init or list");
    return { command: positional[1] === "init" ? "config-init" : "config-list", flags };
  }
  if (acp) {
    if (interactive || positional.length) throw new Error("--acp cannot be combined with a task or --interactive");
    return { command: "acp", flags, acpTransport: acpTransport ?? "stdio" };
  }
  if (acpTransport || flags.host || flags.port) throw new Error("ACP transport options require --acp");
  if (interactive && positional.length) throw new Error("--interactive cannot be combined with a task");
  if (positional.length > 1) throw new Error("provide one task string");
  const task = positional[0];
  if (task !== undefined) return { command: "task", task, flags };
  return { command: "interactive", flags };
}
