import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { resolveSystemPrompt } from "./llm/prompt.js";
import type { ApiMethod, CacheOptions, ProviderName, ProviderProfile } from "./llm/types.js";

type JsonObject = Record<string, unknown>;

const apiMethods = new Set<ApiMethod>(["openai-chat-completions", "anthropic-messages", "google-generate-content"]);

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
  keys(data, ["default_profile", "models", "profiles"], "config");
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
}

interface ProfileSpec {
  modelAlias: string;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  cache?: CacheOptions;
  compact: CompactSettings;
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
  return (provider === "openai" && method === "openai-chat-completions")
    || (provider === "anthropic" && method === "anthropic-messages")
    || (provider === "google" && method === "google-generate-content");
}

function modelSpec(name: string, raw: unknown): ModelSpec {
  const where = "model " + name;
  const value = object(raw, where);
  keys(value, ["provider", "method", "model_id", "base_url", "api_key", "api_key_env", "context_window_tokens", "max_output_tokens"], where);
  const provider = string(value.provider, where + ".provider");
  if (provider === "openai-compatible") throw new Error(where + ".provider must identify a service, not an API method");
  const method = enumValue(value.method, apiMethods, where + ".method");
  const result: ModelSpec = {
    provider,
    method,
    model: string(value.model_id, where + ".model_id"),
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
  keys(value, ["keep_recent_turns", "max_output_tokens"], where);
  return {
    keepRecentTurns: value.keep_recent_turns === undefined ? 2 : nonnegative(value.keep_recent_turns, where + ".keep_recent_turns"),
    maxOutputTokens: value.max_output_tokens === undefined ? 512 : positive(value.max_output_tokens, where + ".max_output_tokens"),
  };
}

function profileSpec(name: string, raw: unknown, models: ReadonlyMap<string, ModelSpec>): ProfileSpec {
  const where = "profile " + name;
  const value = object(raw, where);
  keys(value, ["model", "max_steps", "max_output_bytes", "request_timeout_ms", "cache", "compact"], where);
  const modelAlias = string(value.model, where + ".model");
  const model = models.get(modelAlias);
  if (!model) throw new Error(where + " references unknown model: " + modelAlias);
  const result: ProfileSpec = { modelAlias, compact: compactSpec(value.compact, where + ".compact") };
  if (value.max_steps !== undefined) result.maxSteps = positive(value.max_steps, where + ".max_steps");
  if (value.max_output_bytes !== undefined) result.maxOutputBytes = positive(value.max_output_bytes, where + ".max_output_bytes");
  if (value.request_timeout_ms !== undefined) result.requestTimeoutMs = positive(value.request_timeout_ms, where + ".request_timeout_ms");
  if (value.cache !== undefined) result.cache = cacheOptions(value.cache, model.provider, model.method, where + ".cache");
  return result;
}

function parseDocument(root: JsonObject): { models: Map<string, ModelSpec>; profiles: Map<string, ProfileSpec>; defaultName?: string } {
  const modelsData = root.models === undefined ? {} : object(root.models, "models");
  const models = new Map<string, ModelSpec>();
  for (const [name, raw] of Object.entries(modelsData)) models.set(string(name, "model alias"), modelSpec(name, raw));
  const profilesData = root.profiles === undefined ? {} : object(root.profiles, "profiles");
  const profiles = new Map<string, ProfileSpec>();
  for (const [name, raw] of Object.entries(profilesData)) profiles.set(string(name, "profile name"), profileSpec(name, raw, models));
  const defaultName = root.default_profile === undefined ? undefined : string(root.default_profile, "default_profile");
  if (defaultName !== undefined && !profiles.has(defaultName)) throw new Error("unknown profile: " + defaultName);
  return { models, profiles, ...(defaultName !== undefined ? { defaultName } : {}) };
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
      ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey } : {}),
      ...(model.apiKeyEnv !== undefined ? { apiKeyEnv: model.apiKeyEnv } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(selectedSpec.cache !== undefined ? { cache: selectedSpec.cache } : {}),
    };
    selected = freezeProfile(options.requireModel === false ? spec : resolveKey(spec, env));
  } else if (options.requireModel !== false) {
    throw new Error("profile is required");
  }
  const compact = Object.freeze(selectedSpec?.compact ?? compactSpec(undefined, "compact"));
  return Object.freeze({
    ...(selected === undefined ? {} : { profile: selected }),
    systemPrompt: resolveSystemPrompt(flags.systemPrompt, env.RAW_SYSTEM_PROMPT),
    maxSteps: numberOption(flags.maxSteps, env.RAW_MAX_STEPS, selectedSpec?.maxSteps, 25, "max-steps"),
    maxOutputBytes: numberOption(flags.maxOutputBytes, env.RAW_MAX_OUTPUT_BYTES, selectedSpec?.maxOutputBytes, 8192, "max-output-bytes"),
    requestTimeoutMs: numberOption(flags.requestTimeoutMs, env.RAW_REQUEST_TIMEOUT_MS, selectedSpec?.requestTimeoutMs, 120000, "request-timeout-ms"),
    autoApprove: flags.autoApprove ?? true,
    compact,
    configPath: document.path,
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
