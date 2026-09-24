import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { resolveSystemPrompt } from "./llm/prompt.js";
import type { CacheOptions, ProviderName, ProviderProfile } from "./llm/types.js";

type JsonObject = Record<string, unknown>;

const providerNames = new Set<ProviderName>([
  "openai", "openai-compatible", "openrouter", "ollama", "anthropic", "google",
]);

export interface RawFlags {
  profile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
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
  profile?: string;
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
  keys(data, ["default_profile", "profiles", "compact"], "config");
  validateDocument(data);
  return { path, data, exists: true };
}

function cacheOptions(value: unknown, provider: ProviderName, context: string): CacheOptions {
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
    if (result.backend === "llama.cpp" && provider !== "openai-compatible") {
      throw new Error(`${context}.backend is unsupported for ${provider}`);
    }
  }
  if (result.key !== undefined && provider !== "openai") throw new Error(`${context}.key is unsupported for ${provider}`);
  return result;
}

function profileSpec(name: string, raw: unknown): Omit<ProviderProfile, "apiKey"> {
  const value = object(raw, `profile ${name}`);
  keys(value, ["provider", "model", "base_url", "api_key_env", "context_window", "max_output_tokens", "cache"], `profile ${name}`);
  const provider = enumValue(value.provider, providerNames, `profile ${name}.provider`);
  const result: Omit<ProviderProfile, "apiKey"> = {
    name,
    provider,
    model: string(value.model, `profile ${name}.model`),
  };
  if (value.base_url !== undefined) result.baseUrl = endpoint(value.base_url, `profile ${name}.base_url`);
  if (value.api_key_env !== undefined) {
    const key = string(value.api_key_env, `profile ${name}.api_key_env`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`profile ${name}.api_key_env is invalid`);
    result.apiKeyEnv = key;
  }
  if (value.context_window !== undefined) result.contextWindow = positive(value.context_window, `profile ${name}.context_window`);
  if (value.max_output_tokens !== undefined) result.maxOutputTokens = positive(value.max_output_tokens, `profile ${name}.max_output_tokens`);
  if (result.contextWindow !== undefined && result.maxOutputTokens !== undefined && result.maxOutputTokens >= result.contextWindow) {
    throw new Error(`profile ${name}.max_output_tokens must be smaller than context_window`);
  }
  if (value.cache !== undefined) result.cache = cacheOptions(value.cache, provider, `profile ${name}.cache`);
  const fallbackUrl = defaultEndpoint(provider);
  if (result.baseUrl === undefined && fallbackUrl !== undefined) result.baseUrl = fallbackUrl;
  if (provider === "openai-compatible" && result.baseUrl === undefined) throw new Error(`profile ${name}.base_url is required`);
  return result;
}

function defaultEndpoint(provider: ProviderName): string | undefined {
  if (provider === "ollama") return "http://127.0.0.1:11434/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return undefined;
}

function validateDocument(root: JsonObject): void {
  const profilesData = root.profiles === undefined ? {} : object(root.profiles, "profiles");
  for (const [name, raw] of Object.entries(profilesData)) profileSpec(name, raw);
  if (root.default_profile !== undefined) {
    const name = string(root.default_profile, "default_profile");
    if (!Object.hasOwn(profilesData, name)) throw new Error(`unknown profile: ${name}`);
  }
  const compact = root.compact === undefined ? {} : object(root.compact, "compact");
  keys(compact, ["profile", "keep_recent_turns", "max_output_tokens"], "compact");
  if (compact.profile !== undefined && !Object.hasOwn(profilesData, string(compact.profile, "compact.profile"))) {
    throw new Error(`unknown compact profile: ${String(compact.profile)}`);
  }
  if (compact.keep_recent_turns !== undefined) nonnegative(compact.keep_recent_turns, "compact.keep_recent_turns");
  if (compact.max_output_tokens !== undefined) positive(compact.max_output_tokens, "compact.max_output_tokens");
}

function freezeProfile(profile: ProviderProfile): Readonly<ProviderProfile> {
  if (profile.cache) Object.freeze(profile.cache);
  return Object.freeze(profile);
}

function endpoint(value: unknown, context: string): string {
  const address = string(value, context);
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error(`${context} must be an HTTP(S) URL`);
  }
  return address;
}

function resolveKey(profile: Omit<ProviderProfile, "apiKey">, env: NodeJS.ProcessEnv): ProviderProfile {
  let apiKeyEnv = profile.apiKeyEnv;
  if (!apiKeyEnv) {
    if (profile.provider === "openai") apiKeyEnv = "OPENAI_API_KEY";
    if (profile.provider === "anthropic") apiKeyEnv = "ANTHROPIC_API_KEY";
    if (profile.provider === "google") apiKeyEnv = env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
    if (profile.provider === "openrouter") apiKeyEnv = "OPENROUTER_API_KEY";
  }
  if (!apiKeyEnv) return profile;
  const key = env[apiKeyEnv];
  if (!key) throw new Error(`missing credential environment variable ${apiKeyEnv}`);
  return { ...profile, apiKey: key, apiKeyEnv };
}

function numberOption(flag: number | undefined, env: string | undefined, fallback: number, name: string): number {
  if (flag !== undefined) return positive(flag, name);
  if (env !== undefined) {
    if (!/^[0-9]+$/.test(env)) throw new Error(`${name} must be a positive integer`);
    return positive(Number(env), name);
  }
  return fallback;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  const flags = options.flags ?? {};
  const document = readConfigDocument(options);
  const root = document.data;
  const profilesData = root.profiles === undefined ? {} : object(root.profiles, "profiles");
  const profiles = new Map<string, Omit<ProviderProfile, "apiKey">>();
  for (const [name, raw] of Object.entries(profilesData)) profiles.set(name, profileSpec(name, raw));
  const defaultName = root.default_profile === undefined ? undefined : string(root.default_profile, "default_profile");
  if (defaultName && !profiles.has(defaultName)) throw new Error(`unknown profile: ${defaultName}`);
  const compactRaw = root.compact === undefined ? {} : object(root.compact, "compact");
  keys(compactRaw, ["profile", "keep_recent_turns", "max_output_tokens"], "compact");
  const compactName = compactRaw.profile === undefined ? undefined : string(compactRaw.profile, "compact.profile");
  if (compactName && !profiles.has(compactName)) throw new Error(`unknown compact profile: ${compactName}`);
  const compact: CompactSettings = {
    keepRecentTurns: compactRaw.keep_recent_turns === undefined ? 2 : nonnegative(compactRaw.keep_recent_turns, "compact.keep_recent_turns"),
    maxOutputTokens: compactRaw.max_output_tokens === undefined ? 512 : positive(compactRaw.max_output_tokens, "compact.max_output_tokens"),
  };
  if (compactName !== undefined) compact.profile = compactName;
  const selectedName = flags.profile ?? env.RAW_PROFILE ?? defaultName;
  if (selectedName !== undefined && !profiles.has(selectedName)) throw new Error(`unknown profile: ${selectedName}`);
  const chosen = selectedName ? profiles.get(selectedName) : undefined;
  const providerOverride = flags.provider ?? env.RAW_PROVIDER;
  const baseUrlOverride = flags.baseUrl ?? env.RAW_BASE_URL;
  if (chosen && providerOverride !== undefined && providerOverride !== chosen.provider) throw new Error("provider override conflicts with selected profile");
  if (chosen && baseUrlOverride !== undefined && endpoint(baseUrlOverride, "base_url") !== chosen.baseUrl) throw new Error("base_url override conflicts with selected profile");
  const provider = chosen?.provider ?? (providerOverride === undefined ? undefined : enumValue(providerOverride, providerNames, "provider"));
  const model = flags.model ?? env.RAW_MODEL ?? chosen?.model;
  let selected: ProviderProfile | undefined;
  if (provider !== undefined && model !== undefined) {
    const spec: Omit<ProviderProfile, "apiKey"> = {
      ...(chosen ?? { name: "direct", provider, model }),
      model: string(model, "model"),
    };
    if (baseUrlOverride !== undefined) spec.baseUrl = endpoint(baseUrlOverride, "base_url");
    const fallbackUrl = defaultEndpoint(provider);
    if (spec.baseUrl === undefined && fallbackUrl !== undefined) spec.baseUrl = fallbackUrl;
    if (!spec.baseUrl && provider === "openai-compatible") throw new Error("base_url is required for openai-compatible");
    selected = freezeProfile(options.requireModel === false ? spec : resolveKey(spec, env));
  } else if (options.requireModel !== false) {
    throw new Error("provider and model are required");
  }
  return Object.freeze({
    ...(selected === undefined ? {} : { profile: selected }),
    systemPrompt: resolveSystemPrompt(flags.systemPrompt, env.RAW_SYSTEM_PROMPT),
    maxSteps: numberOption(flags.maxSteps, env.RAW_MAX_STEPS, 25, "max-steps"),
    maxOutputBytes: numberOption(flags.maxOutputBytes, env.RAW_MAX_OUTPUT_BYTES, 8192, "max-output-bytes"),
    requestTimeoutMs: numberOption(flags.requestTimeoutMs, env.RAW_REQUEST_TIMEOUT_MS, 120000, "request-timeout-ms"),
    autoApprove: flags.autoApprove ?? true,
    compact: Object.freeze(compact),
    configPath: document.path,
    resolveCompactProfile() {
      if (!compactName) {
        if (!selected) throw new Error("provider and model are required for compact");
        return options.requireModel === false ? freezeProfile(resolveKey(selected, env)) : selected;
      }
      const spec = profiles.get(compactName);
      if (!spec) throw new Error(`unknown compact profile: ${compactName}`);
      return freezeProfile(resolveKey(spec, env));
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
    "--profile": "profile", "--provider": "provider", "--model": "model",
    "--base-url": "baseUrl", "--config": "configPath", "--system-prompt": "systemPrompt",
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
        if (key === "provider") flags.provider = next;
        if (key === "model") flags.model = next;
        if (key === "baseUrl") flags.baseUrl = next;
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
