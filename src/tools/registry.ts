import type { ToolContext } from "./primitives.js";
import readManifest from "./bundled/read_file/tool.json" with { type: "json" };
import writeManifest from "./bundled/write_file/tool.json" with { type: "json" };
import bashManifest from "./bundled/bash/tool.json" with { type: "json" };
import imageManifest from "./bundled/view_image/tool.json" with { type: "json" };
import { handler as readHandler, validateArgs as validateReadBatch } from "./bundled/read_file/index.js";
import { handler as writeHandler, validateArgs as validateWriteBatch } from "./bundled/write_file/index.js";
import { handler as bashHandler, validateArgs as validateBashBatch } from "./bundled/bash/index.js";
import { handler as imageHandler, validateArgs as validateImageArgs } from "./bundled/view_image/index.js";
import { capResult, errorResult } from "./results.js";
import type { ToolResult } from "./types.js";

export interface ToolDefinition {
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
  canonicalName?: string;
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  validateArgs?: (args: unknown) => string | undefined;
}

export interface ToolPolicyRule { readonly match: string; readonly effect: "allow" | "ask" | "deny" }

function matcher(pattern: string): RegExp {
  const source = [...pattern].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&")).join("");
  return new RegExp(`^(?:${source})(?![\\s\\S])`, "su");
}

function registration(manifest: { name: string; description: string; input_schema: unknown },
  handler: ToolRegistration["handler"], validateArgs?: ToolRegistration["validateArgs"]): ToolRegistration {
  return {
    name: manifest.name, description: manifest.description,
    inputSchema: manifest.input_schema as ToolDefinition["inputSchema"],
    ...(validateArgs ? { validateArgs } : {}), handler,
  };
}

const builtIns: readonly ToolRegistration[] = [
  registration(readManifest, readHandler, validateReadBatch),
  registration(writeManifest, writeHandler, validateWriteBatch),
  registration(bashManifest, bashHandler, validateBashBatch),
];
const imageTool: ToolRegistration = registration(imageManifest, imageHandler, validateImageArgs);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = deepFreeze(builtIns.map(({ handler: _handler, validateArgs: _validateArgs, ...definition }) => structuredClone(definition)));

function validate(definition: ToolDefinition, value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  for (const required of definition.inputSchema.required ?? []) if (!Object.hasOwn(args, required)) return `missing ${required}`;
  for (const [key, item] of Object.entries(args)) {
    if (!Object.hasOwn(definition.inputSchema.properties ?? {}, key)) return `unknown property ${key}`;
    const property = definition.inputSchema.properties![key] as { type: string; minimum?: number };
    if (property.type === "string" && typeof item !== "string") return `${key} must be a string`;
    if (property.type === "integer" && (!Number.isSafeInteger(item) || (item as number) < (property.minimum ?? 0) || (item as number) > 2147483647)) return `${key} must be a positive integer within the timer range`;
  }
  return undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();
  private readonly rules: readonly { match: RegExp; effect: ToolPolicyRule["effect"] }[];

  constructor(rules: readonly ToolPolicyRule[] = []) {
    this.rules = rules.map((rule) => ({ match: matcher(rule.match), effect: rule.effect }));
  }

  private effect(tool: ToolRegistration): ToolPolicyRule["effect"] {
    const identity = tool.canonicalName ?? tool.name;
    let effect: ToolPolicyRule["effect"] = "allow";
    for (const rule of this.rules) if (rule.match.test(identity)) effect = rule.effect;
    return effect;
  }

  register(tool: ToolRegistration): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  definitions(whitelist?: readonly string[]): readonly ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => this.effect(tool) !== "deny" && (whitelist === undefined || whitelist.includes(tool.name)))
      .sort((a, b) => {
        const first = ["read_file", "write_file", "bash", "view_image"].indexOf(a.name);
        const second = ["read_file", "write_file", "bash", "view_image"].indexOf(b.name);
        return first >= 0 && second >= 0 ? first - second : first >= 0 ? -1 : second >= 0 ? 1 : a.name.localeCompare(b.name);
      })
      .map(({ handler: _handler, validateArgs: _validateArgs, canonicalName: _canonicalName, ...definition }) => structuredClone(definition));
  }

  async dispatch(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const finish = (result: ToolResult) => capResult(result, context.maxOutputBytes);
    const tool = this.tools.get(name);
    if (!tool || (context.whitelist !== undefined && !context.whitelist.includes(name))) return finish(errorResult("tool_not_exposed", `tool unavailable: ${name}`));
    const effect = this.effect(tool);
    if (effect === "deny") return finish(errorResult("tool_denied", `tool denied: ${tool.canonicalName ?? name}`));
    const invalid = tool.validateArgs ? tool.validateArgs(args) : validate(tool, args);
    if (invalid) return finish(errorResult("invalid_arguments", invalid));
    if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
    if (effect === "ask" || context.autoApprove === false) {
      if (!context.approve) return finish(errorResult("approval_required", `approval required for ${name}`));
      let onAbort: (() => void) | undefined;
      const cancelled = context.signal ? new Promise<false>((resolve) => {
        onAbort = () => resolve(false);
        context.signal!.addEventListener("abort", onAbort, { once: true });
        if (context.signal!.aborted) onAbort();
      }) : undefined;
      let allowed: boolean;
      try {
        allowed = await (cancelled
          ? Promise.race([Promise.resolve(context.approve(name, structuredClone(args as Record<string, unknown>), context.signal, context.toolCallId)), cancelled])
          : context.approve(name, structuredClone(args as Record<string, unknown>), context.signal, context.toolCallId));
      } catch (error) {
        return finish(errorResult("approval_error", `approval failed: ${(error as Error).message}`));
      } finally {
        if (onAbort) context.signal?.removeEventListener("abort", onAbort);
      }
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      if (!allowed) return finish(errorResult("approval_denied", `approval denied for ${name}`));
    }
    try {
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      context.onStart?.(name, args as Record<string, unknown>);
      if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
      return finish(await tool.handler(args as Record<string, unknown>, context));
    } catch (error) {
      return finish(errorResult("tool_error", `${name} failed: ${(error as Error).message}`));
    }
  }
}

export function createToolRegistry(rules: readonly ToolPolicyRule[] = [], vision = false): ToolRegistry {
  const registry = new ToolRegistry(rules);
  for (const tool of builtIns) registry.register(tool);
  if (vision) registry.register(imageTool);
  return registry;
}
