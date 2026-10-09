import type { ToolContext } from "./primitives.js";
import readManifest from "./bundled/read_file/tool.json" with { type: "json" };
import writeManifest from "./bundled/write_file/tool.json" with { type: "json" };
import bashManifest from "./bundled/bash/tool.json" with { type: "json" };
import { capResult, errorResult } from "./results.js";
import type { ToolContentPanel, ToolHandlerResult, ToolResult } from "./types.js";
import type { PanelDeclaration } from "../panels/contract.js";
import { bindWhenToSchema, compileWhen, matchesWhen, type CompiledWhen, type ToolPolicyWhen } from "./policy.js";
import { RE2JS } from "re2js";
import type { ConditionSource } from "./policy.js";
import { compileObjectSchema } from "./plugins/manifest.js";

export interface ToolDefinition {
  readonly conditionSources?: readonly ConditionSource[];
  readonly effectsSchema?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
}

export interface ToolRegistration extends ToolDefinition {
  describeEffects?: (args: Record<string, unknown>, context: { cwd: string }) => unknown;
  canonicalName?: string;
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolHandlerResult>;
  validateArgs?: (args: unknown) => string | undefined;
  /** raw.panel/2 panels this tool declares (tool.json, MCP config or ACP registration). */
  panels?: readonly PanelDeclaration[];
  /** MCP and ACP tools may also write panels they never declared (docs/panels-design.md §5). */
  implicitPanels?: boolean;
  /** Output bound for host-owned content that must arrive whole; raises, never lowers, the call's max_output_bytes. */
  outputLimit?: number;
}

export interface ToolPolicyRule { readonly match: string; readonly effect: "allow" | "ask" | "deny"; readonly when?: ToolPolicyWhen }

function matcher(pattern: string): RE2JS {
  const source = [...pattern].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&")).join("");
  return RE2JS.compile(source, RE2JS.DOTALL);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = deepFreeze(
  [readManifest, writeManifest, bashManifest].map((manifest) => ({
    name: manifest.name, description: manifest.description,
    inputSchema: structuredClone(manifest.input_schema) as ToolDefinition["inputSchema"],
  })));

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();
  private readonly inputValidators = new Map<string, (value: unknown) => string | undefined>();
  private readonly effectValidators = new Map<string, (value: unknown) => string | undefined>();
  private readonly rules: readonly { match: RE2JS; effect: ToolPolicyRule["effect"]; when?: CompiledWhen }[];

  constructor(rules: readonly ToolPolicyRule[] = []) {
    this.rules = rules.map((rule) => {
      if (typeof rule.match !== "string" || !rule.match || rule.match.length > 256) throw new Error("tool policy match must be a bounded glob");
      if (rule.when && rule.effect !== "ask") throw new Error("conditional tool policy effect must be ask");
      return { match: matcher(rule.match), effect: rule.effect,
        ...(rule.when ? { when: compileWhen(rule.when) } : {}) };
    });
  }

  private effect(tool: ToolRegistration, args?: Record<string, unknown>, effects?: Record<string, unknown>): ToolPolicyRule["effect"] {
    return this.policyEffect(tool.canonicalName ?? tool.name, args, effects);
  }

  /** Inspect policy without registering, importing, or dispatching a tool. */
  policyEffect(identity: string, args?: Record<string, unknown>, effects?: Record<string, unknown>): ToolPolicyRule["effect"] {
    let effect: ToolPolicyRule["effect"] = "allow";
    for (const rule of this.rules) if (rule.match.matches(identity)
      && (rule.when === undefined || (args !== undefined && matchesWhen(rule.when, args, effects)))) effect = rule.effect;
    return effect;
  }

  validateRegistrations(tools: readonly ToolRegistration[]): void {
    const names = new Set<string>();
    for (const tool of tools) {
      if (this.tools.has(tool.name) || names.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      names.add(tool.name);
      const identity = tool.canonicalName ?? tool.name;
      if (tool.conditionSources && (!tool.conditionSources.length || tool.conditionSources.length > 2
        || new Set(tool.conditionSources).size !== tool.conditionSources.length
        || tool.conditionSources.some((source) => source !== "arguments" && source !== "effects"))) throw new Error(`invalid condition sources for ${tool.name}`);
      if (tool.effectsSchema !== undefined || tool.describeEffects !== undefined) {
        if (tool.effectsSchema?.type !== "object" || typeof tool.describeEffects !== "function") throw new Error(`invalid effects contract for ${tool.name}`);
      }
      if (tool.conditionSources?.includes("effects") && !tool.effectsSchema) throw new Error(`missing effects schema for ${tool.name}`);
      for (const rule of this.rules) if (rule.when && rule.match.matches(identity)) bindWhenToSchema(rule.when, tool);
    }
  }

  register(tool: ToolRegistration): void {
    this.validateRegistrations([tool]);
    // Adapters already supply complete schema validation. Effects registrations
    // additionally enforce their schema here before invoking a descriptor.
    const inputValidator = tool.effectsSchema || !tool.validateArgs
      ? compileObjectSchema(tool.inputSchema, `arguments of ${tool.name}`) : undefined;
    const effectsValidator = tool.effectsSchema ? compileObjectSchema(tool.effectsSchema, `effects of ${tool.name}`) : undefined;
    this.tools.set(tool.name, tool);
    if (inputValidator) this.inputValidators.set(tool.name, inputValidator);
    if (effectsValidator) this.effectValidators.set(tool.name, effectsValidator);
  }

  canonicalIdentity(name: string): string | undefined {
    const tool = this.tools.get(name);
    return tool?.canonicalName ?? tool?.name;
  }

  /** The registered tool name for a canonical identity, when this registry has it. */
  nameForIdentity(identity: string): string | undefined {
    for (const tool of this.tools.values()) if ((tool.canonicalName ?? tool.name) === identity) return tool.name;
    return undefined;
  }

  definitions(whitelist?: readonly string[]): readonly ToolDefinition[] {
    const ordered = whitelist === undefined ? [...this.tools.values()]
      : [...new Set(whitelist)].map((name) => this.tools.get(name)).filter((item): item is ToolRegistration => item !== undefined);
    return ordered
      .filter((tool) => this.effect(tool) !== "deny" && (whitelist === undefined || whitelist.includes(tool.name)))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) }));
  }

  /** Host-only schemas for policy/hook inspection; never sent as model tool metadata. */
  inspectionDefinition(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    return tool ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      ...(tool.conditionSources ? { conditionSources: tool.conditionSources } : {}),
      ...(tool.effectsSchema ? { effectsSchema: tool.effectsSchema } : {}) } : undefined;
  }

  /** Panel declarations of a registered tool, without importing or invoking anything. */
  panelDeclarations(name: string): { owner: string; declarations: readonly PanelDeclaration[]; implicit: boolean } | undefined {
    const tool = this.tools.get(name);
    return tool ? { owner: tool.canonicalName ?? tool.name, declarations: tool.panels ?? [], implicit: tool.implicitPanels === true } : undefined;
  }

  async dispatch(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const maxOutputBytes = Math.max(context.maxOutputBytes, tool?.outputLimit ?? 0);
    const finish = (result: ToolResult) => capResult(result, maxOutputBytes);
    if (!tool || (context.whitelist !== undefined && !context.whitelist.includes(name))) return finish(errorResult("tool_not_exposed", `tool unavailable: ${name}`));
    const visibility = this.effect(tool);
    if (visibility === "deny") return finish(errorResult("tool_denied", `tool denied: ${tool.canonicalName ?? name}`));
    const invalid = tool.validateArgs?.(args) ?? this.inputValidators.get(name)?.(args);
    if (invalid) return finish(errorResult("invalid_arguments", invalid));
    if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
    args = deepFreeze(structuredClone(args));
    let effects: Record<string, unknown> | undefined;
    if (tool.describeEffects) {
      try {
        const described = tool.describeEffects(args as Record<string, unknown>, { cwd: context.cwd });
        if (described !== null && (typeof described === "object" || typeof described === "function")
          && typeof (described as { then?: unknown }).then === "function") {
          // Observe a contract-violating async result without waiting for or using its effects.
          void Promise.resolve(described).catch(() => {});
          return finish(errorResult("invalid_effects", "effects descriptors must return synchronously"));
        }
        const encoded = JSON.stringify(described);
        if (encoded === undefined) return finish(errorResult("invalid_effects", `invalid intended effects for ${name}`));
        if (Buffer.byteLength(encoded) > 64 * 1024) return finish(errorResult("invalid_effects", "effects exceed 64 KiB"));
        const snapshot: unknown = JSON.parse(encoded);
        if (this.effectValidators.get(name)!(snapshot) !== undefined) return finish(errorResult("invalid_effects", `invalid intended effects for ${name}`));
        effects = deepFreeze(snapshot as Record<string, unknown>);
      } catch (error) { return finish(errorResult("effects_error", `cannot describe ${name}: ${(error as Error).message}`)); }
    }
    const effect = this.effect(tool, args as Record<string, unknown>, effects);
    if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
    if (context.onHook) {
      const hook = await context.onHook("PreToolUse", tool.canonicalName ?? name, name, args as Record<string, unknown>, undefined, effects);
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      if (hook.blocked) return finish(errorResult(hook.blocked === "denied" ? "hook_denied" : "hook_error",
        hook.reason ?? `hook ${hook.blocked}`));
    }
    if (effect === "ask" || context.autoApprove === false) {
      if (!context.approve) return finish(errorResult("approval_required", `approval required for ${name}`));
      let onAbort: (() => void) | undefined;
      const cancelled = context.signal ? new Promise<false>((resolve) => {
        onAbort = () => resolve(false);
        context.signal!.addEventListener("abort", onAbort, { once: true });
        if (context.signal!.aborted) onAbort();
      }) : undefined;
      let allowed: boolean;
      const request = { identity: tool.canonicalName ?? name, name, arguments: args as Record<string, unknown>,
        ...(effects ? { effects } : {}), ...(context.signal ? { signal: context.signal } : {}),
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}) };
      try {
        allowed = await (cancelled
          ? Promise.race([Promise.resolve(context.approve(request)), cancelled])
          : context.approve(request));
      } catch (error) {
        return finish(errorResult("approval_error", `approval failed: ${(error as Error).message}`));
      } finally {
        if (onAbort) context.signal?.removeEventListener("abort", onAbort);
      }
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      if (!allowed) return finish(errorResult("approval_denied", `approval denied for ${name}`));
    }
    let invoked = false;
    let result: ToolHandlerResult;
    try {
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      context.onStart?.(name, args as Record<string, unknown>);
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      invoked = true;
      result = await tool.handler(args as Record<string, unknown>, { ...context, maxOutputBytes, ...(effects ? { effects } : {}) });
    } catch (error) {
      result = errorResult("tool_error", `${name} failed: ${(error as Error).message}`);
    }
    try { context.onHandlerSettled?.(); } catch { /* host observers never change the tool outcome */ }
    // The single panel extraction point (docs/panels-design.md §8.0): before hooks, caps, providers and history.
    const panels = result.content.filter((block): block is ToolContentPanel => block.type === "panel");
    if (panels.length) {
      try { context.onPanelUpdates?.(panels); } catch { /* an observer never changes the tool outcome */ }
      result = { ...result, content: result.content.filter((block) => block.type !== "panel") };
    }
    if (invoked && context.onHook) await context.onHook(result.isError ? "PostToolUseFailure" : "PostToolUse",
      tool.canonicalName ?? name, name, args as Record<string, unknown>, result as ToolResult, effects);
    return finish(result as ToolResult);
  }
}
