export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type VariableType = "string" | "number" | "boolean" | "object" | "array" | "null" | "json";
export type VariableSource = { readonly kind: "literal"; readonly value: JsonValue }
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "file"; readonly path: string; readonly format: "text" | "json" }
  | { readonly kind: "provider"; readonly name: string; readonly params: Readonly<Record<string, JsonValue>> };
export interface VariableMetadata { readonly name: string; readonly description: string; readonly type: VariableType; readonly access: "read" | "use" }
export interface VariableDefinition extends VariableMetadata { readonly source: VariableSource; readonly cacheTtlMs: number }
export interface VariableProvider { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number; readonly maxOutputBytes: number }
export interface VariableConfig {
  readonly agentName?: string;
  readonly configDir: string;
  readonly variables: readonly VariableDefinition[];
  readonly providers: Readonly<Record<string, VariableProvider>>;
}
export interface ResolvedVariable { name: string; value: JsonValue; observed_at: string; cached: boolean }
export interface VariableContext {
  list(): readonly VariableMetadata[];
  read(name: string, options?: { signal?: AbortSignal }): Promise<ResolvedVariable>;
  validateEnvRefs(refs: unknown): void;
  resolveEnv(refs: Readonly<Record<string, string>>, options?: { signal?: AbortSignal }): Promise<Record<string, string>>;
}
export class VariableError extends Error {
  constructor(readonly code: string, name: string) { super(`${code}: ${name}`); this.name = "VariableError"; }
}
export function valueType(value: unknown): Exclude<VariableType, "json"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<VariableType, "json" | "null" | "array">;
}
export function matchesType(value: unknown, type: VariableType): value is JsonValue {
  if (!isJson(value)) return false;
  return type === "json" || valueType(value) === type;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return !!value && typeof value === "object" && Object.values(value).every(isJson);
}
