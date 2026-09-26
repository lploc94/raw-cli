import { isAbsolute, resolve } from "node:path";
import { matchesType, valueType, type JsonValue, type VariableDefinition, type VariableProvider, type VariableSource, type VariableType } from "./contract.js";
export const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const namePattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const types = new Set(["string", "number", "boolean", "object", "array", "null", "json"]);
function fail(at: string): never { throw new Error(`invalid ${at}`); }
function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(at);
  return value as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[], at: string): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${at}.${k}`);
}
function text(v: unknown, at: string): string { if (typeof v !== "string" || !v.trim() || v.includes("\0")) fail(at); return v; }
function integer(v: unknown, fallback: number, min: number, max: number, at: string): number {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(at);
  return v as number;
}
function name(v: string, at: string): void { if (!namePattern.test(v) || ["constructor", "prototype", "__proto__"].includes(v)) fail(at); }
export function freezeVariables<T>(v: T): T {
  if (v && typeof v === "object") { for (const x of Object.values(v)) freezeVariables(x); Object.freeze(v); }
  return v;
}
export function parseVariableDefinitions(rawVars: unknown, rawProviders: unknown, configDir: string): {
  variables: Readonly<Record<string, VariableDefinition>>; providers: Readonly<Record<string, VariableProvider>>;
} {
  const providers: Record<string, VariableProvider> = Object.create(null);
  for (const [id, raw] of Object.entries(rawProviders === undefined ? {} : object(rawProviders, "var_providers"))) {
    const at = `var_providers.${id}`; name(id, at);
    if (id === "system.time") throw new Error(`${at} is reserved`);
    const v = object(raw, at); keys(v, ["command", "args", "cwd", "timeout_ms", "max_output_bytes"], at);
    const command = text(v.command, `${at}.command`);
    const args = v.args ?? [];
    if (!Array.isArray(args) || args.some(x => typeof x !== "string" || x.includes("\0"))) fail(`${at}.args`);
    providers[id] = { command: isAbsolute(command) || !/[\\/]/.test(command) ? command : resolve(configDir, command),
      args: [...args] as string[], cwd: v.cwd === undefined ? configDir : resolve(configDir, text(v.cwd, `${at}.cwd`)),
      timeoutMs: integer(v.timeout_ms, 5000, 1, 2147483647, `${at}.timeout_ms`),
      maxOutputBytes: integer(v.max_output_bytes, 65536, 1, 1048576, `${at}.max_output_bytes`) };
  }
  const variables: Record<string, VariableDefinition> = Object.create(null);
  for (const [id, raw] of Object.entries(rawVars === undefined ? {} : object(rawVars, "vars"))) {
    const at = `vars.${id}`; name(id, at);
    const v = object(raw, at); keys(v, ["description", "source", "access", "type", "cache_ttl_ms"], at);
    const description = text(v.description, `${at}.description`);
    if (v.access !== "read" && v.access !== "use") fail(`${at}.access`);
    const s = object(v.source, `${at}.source`); let source: VariableSource; let inferred: VariableType;
    switch (s.kind) {
      case "literal":
        keys(s, ["kind", "value"], `${at}.source`);
        if (!Object.hasOwn(s, "value")) fail(`${at}.source.value`);
        source = { kind: "literal", value: structuredClone(s.value) as JsonValue }; inferred = valueType(s.value); break;
      case "env": {
        keys(s, ["kind", "name"], `${at}.source`); const n = text(s.name, `${at}.source.name`);
        if (!environmentName.test(n)) fail(`${at}.source.name`);
        source = { kind: "env", name: n }; inferred = "string"; break;
      }
      case "file": {
        keys(s, ["kind", "path", "format"], `${at}.source`);
        if (s.format !== undefined && s.format !== "text" && s.format !== "json") fail(`${at}.source.format`);
        source = { kind: "file", path: resolve(configDir, text(s.path, `${at}.source.path`)), format: s.format ?? "text" };
        inferred = source.format === "text" ? "string" : "json"; break;
      }
      case "provider": {
        keys(s, ["kind", "name", "params"], `${at}.source`); const n = text(s.name, `${at}.source.name`);
        if (n !== "system.time" && !Object.hasOwn(providers, n)) fail(`${at}.source.provider`);
        const params = s.params === undefined ? {} : object(s.params, `${at}.source.params`);
        if (!matchesType(params, "object")) fail(`${at}.source.params`);
        if (n === "system.time" && Object.keys(params).length) fail(`${at}.source.params`);
        if (Buffer.byteLength(JSON.stringify({ protocol_version: 1, name: id, params })) > 65536) fail(`${at}.source.params size`);
        source = { kind: "provider", name: n, params: structuredClone(params) as Record<string, JsonValue> };
        inferred = n === "system.time" ? "string" : "json"; break;
      }
      default: fail(`${at}.source.kind`);
    }
    const type = (v.type ?? inferred) as VariableType;
    if (!types.has(type)) fail(`${at}.type`);
    if (source.kind === "literal" && !matchesType(source.value, type)) fail(`${at}.type`);
    if ((source.kind === "env" || source.kind === "file" && source.format === "text" || source.kind === "provider" && source.name === "system.time") && type !== "string" && type !== "json") fail(`${at}.type`);
    variables[id] = { name: id, description, type, access: v.access, source,
      cacheTtlMs: integer(v.cache_ttl_ms, 0, 0, 2147483647, `${at}.cache_ttl_ms`) };
  }
  return freezeVariables({ variables, providers });
}
export function selectVariables(raw: unknown, vars: Readonly<Record<string, VariableDefinition>>, at: string): readonly VariableDefinition[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.some(x => typeof x !== "string" || !Object.hasOwn(vars, x)) || new Set(raw).size !== raw.length) fail(at);
  return Object.freeze(raw.map(x => vars[x]!));
}
