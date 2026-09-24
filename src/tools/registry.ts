import { bashTool, readFileTool, writeFileTool, type ToolContext } from "./primitives.js";
import { capResult, errorResult } from "./results.js";
import type { ToolResult } from "./types.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, { readonly type: "string" | "integer"; readonly minimum?: number }>>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
}

export interface ToolRegistration extends ToolDefinition {
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

const builtIns: readonly ToolRegistration[] = [
  {
    name: "read_file", description: "Read a UTF-8 file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    handler: (args, ctx) => readFileTool(args as { path: string }, ctx),
  },
  {
    name: "write_file", description: "Create or overwrite a UTF-8 file.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    handler: (args, ctx) => writeFileTool(args as { path: string; content: string }, ctx),
  },
  {
    name: "bash", description: "Run a Bash command.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer", minimum: 1 } }, required: ["command"], additionalProperties: false },
    handler: (args, ctx) => bashTool(args as { command: string; timeout_ms?: number }, ctx),
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = deepFreeze(builtIns.map(({ handler: _handler, ...definition }) => structuredClone(definition)));

function validate(definition: ToolDefinition, value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  for (const required of definition.inputSchema.required ?? []) if (!Object.hasOwn(args, required)) return `missing ${required}`;
  for (const [key, item] of Object.entries(args)) {
    if (!Object.hasOwn(definition.inputSchema.properties, key)) return `unknown property ${key}`;
    const property = definition.inputSchema.properties[key]!;
    if (property.type === "string" && typeof item !== "string") return `${key} must be a string`;
    if (property.type === "integer" && (!Number.isSafeInteger(item) || (item as number) < (property.minimum ?? 0) || (item as number) > 2147483647)) return `${key} must be a positive integer within the timer range`;
  }
  return undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  register(tool: ToolRegistration): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  definitions(whitelist?: readonly string[]): readonly ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => whitelist === undefined || whitelist.includes(tool.name))
      .map(({ handler: _handler, ...definition }) => structuredClone(definition));
  }

  async dispatch(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const finish = (result: ToolResult) => capResult(result, context.maxOutputBytes);
    const tool = this.tools.get(name);
    if (!tool || (context.whitelist !== undefined && !context.whitelist.includes(name))) return finish(errorResult("tool_not_exposed", `tool unavailable: ${name}`));
    const invalid = validate(tool, args);
    if (invalid) return finish(errorResult("invalid_arguments", invalid));
    if (context.signal?.aborted) return finish(errorResult("aborted", "tool call aborted"));
    if (!context.autoApprove) {
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
          ? Promise.race([Promise.resolve(context.approve(name, structuredClone(args as Record<string, unknown>), context.signal)), cancelled])
          : context.approve(name, structuredClone(args as Record<string, unknown>), context.signal));
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

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtIns) registry.register(tool);
  return registry;
}
