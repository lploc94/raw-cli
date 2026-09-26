import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { performance } from "node:perf_hooks";
import { environmentName } from "./config.js";
import { VariableError, matchesType, type VariableConfig, type VariableContext, type VariableDefinition, type ResolvedVariable, type JsonValue } from "./contract.js";
import { runVariableProvider } from "./provider.js";
export interface VariableResolverOptions { config: VariableConfig; env?: NodeJS.ProcessEnv; now?: () => number; monotonicNow?: () => number }

export function createVariableResolver(options: VariableResolverOptions): VariableContext {
  const config = structuredClone(options.config);
  const definitions = new Map(config.variables.map(v => [v.name, v]));
  const cache = new Map<string, { result: ResolvedVariable; until: number }>();
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonicNow ?? (() => performance.now());
  const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new VariableError("aborted", "variable resolution"); };
  const selected = (name: string): VariableDefinition => {
    const def = definitions.get(name);
    if (!def) throw new VariableError("var_not_selected", name);
    return def;
  };
  const resolveValue = async (def: VariableDefinition, signal?: AbortSignal): Promise<ResolvedVariable> => {
    aborted(signal);
    const hit = cache.get(def.name);
    if (hit && monotonic() < hit.until) return { ...structuredClone(hit.result), cached: true };
    cache.delete(def.name);
    const source = def.source;
    let value: JsonValue;
    let observedAt: string | undefined;
    switch (source.kind) {
      case "literal": value = structuredClone(source.value); break;
      case "env": {
        const found = Object.hasOwn(env, source.name) ? env[source.name] : undefined;
        if (found === undefined) throw new VariableError("var_env_missing", def.name);
        value = found; break;
      }
      case "file": {
        let handle;
        try {
          handle = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
          if (!(await handle.stat()).isFile()) throw new VariableError("var_file_invalid", def.name);
          const buffer = Buffer.alloc(65537); let size = 0;
          while (size < buffer.length) {
            aborted(signal);
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size > 65536) throw new VariableError("var_file_too_large", def.name);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
          value = source.format === "json" ? JSON.parse(text) as JsonValue : text;
        } catch (error) {
          if (error instanceof VariableError) throw error;
          throw new VariableError("var_file_invalid", def.name);
        } finally { await handle?.close(); }
        break;
      }
      case "provider": {
        if (source.name === "system.time") { observedAt = new Date(now()).toISOString(); value = observedAt; }
        else {
          const spec = config.providers[source.name];
          if (!spec) throw new VariableError("var_provider_missing", def.name);
          const output = await runVariableProvider(spec, { protocol_version: 1, name: def.name, params: source.params }, { env, ...(signal ? { signal } : {}) });
          value = output.value; observedAt = output.observed_at;
        }
        break;
      }
    }
    aborted(signal);
    if (!matchesType(value, def.type)) throw new VariableError("var_type_mismatch", def.name);
    const result = { name: def.name, value, observed_at: observedAt ?? new Date(now()).toISOString(), cached: false };
    if (def.cacheTtlMs > 0) cache.set(def.name, { result: structuredClone(result), until: monotonic() + def.cacheTtlMs });
    return result;
  };
  const validateEnvRefs = (refs: unknown): void => {
    if (!refs || typeof refs !== "object" || Array.isArray(refs)) throw new VariableError("var_env_refs_invalid", "env_refs");
    for (const [key, name] of Object.entries(refs)) {
      if (!environmentName.test(key) || typeof name !== "string") throw new VariableError("var_env_refs_invalid", key);
      const def = selected(name);
      if (!["string", "number", "boolean", "json"].includes(def.type)) throw new VariableError("var_env_type", name);
    }
  };
  return {
    list() { return config.variables.map(({ name, description, type, access }) => ({ name, description, type, access })); },
    async read(name, opts) {
      const def = selected(name);
      if (def.access !== "read") throw new VariableError("var_read_denied", name);
      return resolveValue(def, opts?.signal);
    },
    validateEnvRefs,
    async resolveEnv(refs, opts) {
      validateEnvRefs(refs); aborted(opts?.signal);
      const result: Record<string, string> = {};
      for (const [key, name] of Object.entries(refs)) {
        const { value } = await resolveValue(selected(name), opts?.signal);
        if (!["string", "number", "boolean"].includes(typeof value)) throw new VariableError("var_env_type", name);
        const text = String(value);
        if (text.includes("\0")) throw new VariableError("var_env_nul", name);
        Object.defineProperty(result, key, { value: text, enumerable: true, configurable: true, writable: true });
      }
      return result;
    },
  };
}
