import type { ToolContext } from "./primitives.js";
import readManifest from "./bundled/read_file/tool.json" with { type: "json" };
import writeManifest from "./bundled/write_file/tool.json" with { type: "json" };
import bashManifest from "./bundled/bash/tool.json" with { type: "json" };
import { capResult, errorResult, utf8Prefix } from "./results.js";
import { MODEL_NOTE_BYTES } from "./normalize.js";
import type { ToolContentPanel, ToolHandlerResult, ToolResult } from "./types.js";
import type { PanelDeclaration } from "../panels/contract.js";
import { bindWhenToSchema, compileWhen, matchesWhen, type CompiledWhen, type ToolPolicyWhen } from "./policy.js";
import { RE2JS } from "re2js";
import type { ConditionSource } from "./policy.js";
import { compileObjectSchema } from "./plugins/manifest.js";
import { callSummary, callTitle, displayArguments, type ToolDisplay } from "./display.js";

export interface ToolDefinition {
  readonly conditionSources?: readonly ConditionSource[];
  /** Host-only: old top-level argument names and the argument that replaced each, for specific rule-binding errors. */
  readonly renamedArguments?: Readonly<Record<string, string>>;
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

/** What a built-in's `normalizeArguments` returns (docs/tool-ux-design.md §4.3). */
export interface NormalizedArguments {
  args: Record<string, unknown>;
  /** Host-only notes such as `read file_path as path`. */
  notes?: string[];
  /** A shape that is not an alias, such as an old batch shape: the call is rejected with this message. */
  rejected?: string;
}

export interface ToolRegistration extends ToolDefinition {
  describeEffects?: (args: Record<string, unknown>, context: { cwd: string }) => unknown;
  /**
   * Bundled tools only: maps aliases to canonical arguments before validation. Pure and idempotent. Unknown top-level
   * arguments of a normalized tool are then dropped with a note to the model.
   */
  normalizeArguments?: (args: Record<string, unknown>) => NormalizedArguments;
  /** One canonical call, shown when arguments are rejected. */
  example?: Readonly<Record<string, unknown>>;
  /**
   * Bundled tools only: a call this tool hands to another tool after its own gates pass (docs/tool-ux-design.md D10).
   * The target runs through its full dispatch (policy, hooks, approval, limits); `finish` turns its result into this
   * tool's result. When the target is not registered, not exposed or hidden by policy, this tool's handler runs instead
   * and says so in its result, the way it does when it was loaded without delegation.
   */
  delegate?: (args: Record<string, unknown>, context: { cwd: string }) => ToolDelegation | undefined;
  /** Bundled editing tools only: the host owner of the panels this tool declares, shared with the others (§6.3). */
  panelOwner?: string;
  canonicalName?: string;
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolHandlerResult>;
  validateArgs?: (args: unknown) => string | undefined;
  /** How surfaces show the tool: tool.json `display`, or MCP annotations merged with the config override (§5.1). */
  display?: ToolDisplay;
  /** raw.panel/2 panels this tool declares (tool.json, MCP config or ACP registration). */
  panels?: readonly PanelDeclaration[];
  /** MCP and ACP tools may also write panels they never declared (docs/panels-design.md §5). */
  implicitPanels?: boolean;
  /** Output bound for host-owned content that must arrive whole; raises, never lowers, the call's max_output_bytes. */
  outputLimit?: number;
}

export interface ToolDelegation {
  identity: string;
  arguments: Record<string, unknown>;
  finish: (result: ToolResult) => ToolResult;
}

export interface ToolPolicyRule { readonly match: string; readonly effect: "allow" | "ask" | "deny"; readonly when?: ToolPolicyWhen }

function matcher(pattern: string): RE2JS {
  const source = [...pattern].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&")).join("");
  return RE2JS.compile(source, RE2JS.DOTALL);
}

/** Whether a `tools.rules` glob matches a canonical tool identity. */
export function ruleMatches(pattern: string, identity: string): boolean { return matcher(pattern).matches(identity); }

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
      for (const rule of this.rules) if (rule.when && rule.match.matches(identity)) bindWhenToSchema(rule.when, tool, identity);
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
      ...(tool.renamedArguments ? { renamedArguments: tool.renamedArguments } : {}),
      ...(tool.effectsSchema ? { effectsSchema: tool.effectsSchema } : {}) } : undefined;
  }

  /** Display hints of a registered tool, when it has any. */
  display(name: string): ToolDisplay | undefined {
    return this.tools.get(name)?.display;
  }

  /** Panel declarations of a registered tool, without importing or invoking anything. */
  panelDeclarations(name: string): { owner: string; declarations: readonly PanelDeclaration[]; implicit: boolean } | undefined {
    const tool = this.tools.get(name);
    return tool ? { owner: tool.panelOwner ?? tool.canonicalName ?? tool.name, declarations: tool.panels ?? [], implicit: tool.implicitPanels === true } : undefined;
  }

  async dispatch(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const maxOutputBytes = Math.max(context.maxOutputBytes, tool?.outputLimit ?? 0);
    const finish = (result: ToolResult) => capResult(result, maxOutputBytes);
    if (!tool || (context.whitelist !== undefined && !context.whitelist.includes(name))) return finish(errorResult("tool_not_exposed", `tool unavailable: ${name}`));
    const visibility = this.effect(tool);
    if (visibility === "deny") return finish(errorResult("tool_denied", `tool denied: ${tool.canonicalName ?? name}`));
    // Normalization (docs/tool-ux-design.md §4.3): aliases become canonical arguments before validation, so policy,
    // effects, hooks, approval and the handler all see one shape. The caller keeps the raw call for history and replay.
    let raw: Record<string, unknown> | undefined;
    const ignored: string[] = [];
    let notes: readonly string[] = [];
    if (tool.normalizeArguments && args !== null && typeof args === "object" && !Array.isArray(args)) {
      let normalized: NormalizedArguments;
      try { normalized = tool.normalizeArguments(structuredClone(args as Record<string, unknown>)); }
      catch (error) { return finish(errorResult("invalid_arguments", `cannot read the arguments of ${name}: ${(error as Error).message}`)); }
      if (normalized.rejected !== undefined) return finish(errorResult("invalid_arguments", normalized.rejected));
      const next = { ...normalized.args };
      const properties = tool.inputSchema.properties;
      if (properties && tool.inputSchema.additionalProperties === false) {
        for (const key of Object.keys(next)) if (!Object.hasOwn(properties, key)) { ignored.push(key); delete next[key]; }
      }
      notes = normalized.notes ?? [];
      if (JSON.stringify(next) !== JSON.stringify(args)) { raw = args as Record<string, unknown>; args = next; }
      // Reported before validation and gates, so a call they reject is still shown in its canonical form.
      if (raw !== undefined || notes.length) {
        try { context.onNormalized?.(structuredClone(args as Record<string, unknown>), notes); } catch { /* a host observer never changes the call */ }
      }
    }
    const invalid = tool.validateArgs?.(args) ?? this.inputValidators.get(name)?.(args);
    if (invalid) return finish(errorResult("invalid_arguments", tool.example ? `${invalid}; example: ${JSON.stringify(tool.example)}` : invalid));
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
      const hook = await context.onHook("PreToolUse", tool.canonicalName ?? name, name, args as Record<string, unknown>, undefined, effects, raw);
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
      const shown = displayArguments(tool.canonicalName ?? name, args as Record<string, unknown>);
      const request = { identity: tool.canonicalName ?? name, name, title: callTitle(name, shown, tool.display),
        summary: callSummary(shown, tool.display), arguments: args as Record<string, unknown>,
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
    // Delegation (D10): after this tool's gates, an available target runs through its own full dispatch instead of the
    // handler. It shares the call's ID, signal, approval and hook services, never the outer call's observers, so the
    // call stays one call on every surface with its own arguments.
    const delegation = tool.delegate?.(args as Record<string, unknown>, { cwd: context.cwd });
    const targetName = delegation ? this.nameForIdentity(delegation.identity) : undefined;
    const target = targetName === undefined ? undefined : this.tools.get(targetName);
    const delegated = delegation !== undefined && target !== undefined && targetName !== undefined
      && (context.whitelist === undefined || context.whitelist.includes(targetName)) && this.effect(target) !== "deny";
    const modelNotes = ignored.map((key) => `[ignored unknown argument: ${key}]`);
    let invoked = false;
    let result: ToolHandlerResult;
    try {
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      context.onStart?.(name, args as Record<string, unknown>);
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      invoked = true;
      result = delegated
        ? delegation.finish(await this.dispatch(targetName, delegation.arguments, { cwd: context.cwd, maxOutputBytes: context.maxOutputBytes,
          ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.signal ? { signal: context.signal } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.whitelist ? { whitelist: context.whitelist } : {}), ...(context.approve ? { approve: context.approve } : {}),
          ...(context.autoApprove !== undefined ? { autoApprove: context.autoApprove } : {}), ...(context.onHook ? { onHook: context.onHook } : {}),
          ...(context.processes ? { processes: context.processes } : {}), ...(context.vars ? { vars: context.vars } : {}),
          ...(context.bashPath ? { bashPath: context.bashPath } : {}) }))
        : await tool.handler(args as Record<string, unknown>, { ...context, maxOutputBytes, ...(effects ? { effects } : {}) });
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
    // Only ignored-argument and fallback notes reach the model; the other normalization notes are host data (§4.3). The
    // output is capped first with room left for the notes, so a full-sized result still tells the model about them.
    if (modelNotes.length) {
      // Bounded, so a tool that leaves MODEL_NOTE_BYTES of room (ask_user) never loses output to the note.
      const joined = modelNotes.join("\n");
      const note = Buffer.byteLength(joined) <= MODEL_NOTE_BYTES ? joined
        : `${utf8Prefix(joined, MODEL_NOTE_BYTES - 40).text.replace(/\n[^\n]*$/, "")}\n[${modelNotes.length} notes in all; rest omitted]`;
      const capped = capResult(result, Math.max(0, maxOutputBytes - Buffer.byteLength(note) - 1));
      result = { ...capped, content: [...capped.content, { type: "text", text: note }] };
    }
    if (notes.length) result = { ...result, host: { ...result.host, notes: [...(result.host?.notes ?? []), ...notes] } };
    if (invoked && context.onHook) await context.onHook(result.isError ? "PostToolUseFailure" : "PostToolUse",
      tool.canonicalName ?? name, name, args as Record<string, unknown>, result as ToolResult, effects, raw);
    return finish(result as ToolResult);
  }
}
