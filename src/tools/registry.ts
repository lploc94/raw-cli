import { bashTool, readFileTool, writeFileTool, type ToolContext } from "./primitives.js";
import { viewImageTool } from "./image.js";
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

function validateReadBatch(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "files")) return "unknown read_file property";
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 16) return "files must contain 1 to 16 entries";
  for (const [index, raw] of args.files.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `files[${index}] must be an object`;
    const file = raw as Record<string, unknown>;
    if (Object.keys(file).some((key) => !["path", "start_line", "end_line", "max_lines", "max_bytes"].includes(key))) return `files[${index}] has an unknown property`;
    if (typeof file.path !== "string" || !file.path) return `files[${index}].path must be a nonempty string`;
    for (const key of ["start_line", "end_line", "max_lines", "max_bytes"] as const) {
      if (file[key] !== undefined && (!Number.isSafeInteger(file[key]) || (file[key] as number) < 1 || (file[key] as number) > 2147483647)) {
        return `files[${index}].${key} must be a positive integer`;
      }
    }
    if (file.end_line !== undefined && file.max_lines !== undefined) return `files[${index}] cannot combine end_line and max_lines`;
    if (file.end_line !== undefined && (file.end_line as number) < (file.start_line as number | undefined ?? 1)) return `files[${index}].end_line precedes start_line`;
  }
  return undefined;
}

function validateWriteBatch(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "operations")) return "unknown write_file property";
  if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 16) return "operations must contain 1 to 16 entries";
  const fields: Record<string, readonly string[]> = {
    overwrite: ["path", "mode", "content"], append: ["path", "mode", "content"],
    replace_text: ["path", "mode", "old_text", "new_text"],
    replace_lines: ["path", "mode", "start_line", "end_line", "content", "expected_sha256"],
  };
  for (const [index, raw] of args.operations.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `operations[${index}] must be an object`;
    const op = raw as Record<string, unknown>;
    if (typeof op.path !== "string" || !op.path) return `operations[${index}].path must be a nonempty string`;
    if (typeof op.mode !== "string" || !Object.hasOwn(fields, op.mode)) return `operations[${index}].mode is invalid`;
    const allowed = fields[op.mode]!;
    if (Object.keys(op).some((key) => !allowed.includes(key))) return `operations[${index}] has an invalid field for ${op.mode}`;
    for (const key of allowed) if (!Object.hasOwn(op, key)) return `operations[${index}] missing ${key}`;
    if (allowed.includes("content") && typeof op.content !== "string") return `operations[${index}].content must be a string`;
    if (op.mode === "replace_text" && (typeof op.old_text !== "string" || !op.old_text || typeof op.new_text !== "string")) {
      return `operations[${index}] requires nonempty old_text and string new_text`;
    }
    if (op.mode === "replace_lines") {
      if (!Number.isSafeInteger(op.start_line) || !Number.isSafeInteger(op.end_line)
        || (op.start_line as number) < 1 || (op.end_line as number) < (op.start_line as number)
        || (op.end_line as number) > 2147483647) return `operations[${index}] has invalid line range`;
      if (typeof op.expected_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(op.expected_sha256)) {
        return `operations[${index}].expected_sha256 must be lowercase SHA-256`;
      }
    }
  }
  return undefined;
}

function validateBashBatch(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "commands")) return "unknown bash property";
  if (!Array.isArray(args.commands) || args.commands.length < 1 || args.commands.length > 16) return "commands must contain 1 to 16 entries";
  for (const [index, raw] of args.commands.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `commands[${index}] must be an object`;
    const command = raw as Record<string, unknown>;
    if (Object.keys(command).some((key) => !["command", "timeout_ms"].includes(key))) return `commands[${index}] has an unknown property`;
    if (typeof command.command !== "string" || !command.command) return `commands[${index}].command must be a nonempty string`;
    if (command.timeout_ms !== undefined && (!Number.isSafeInteger(command.timeout_ms) || (command.timeout_ms as number) < 1
      || (command.timeout_ms as number) > 2147483647)) return `commands[${index}].timeout_ms must be a positive integer`;
  }
  return undefined;
}

const builtIns: readonly ToolRegistration[] = [
  {
    name: "read_file", description: "Read UTF-8 files; optional 1-based line ranges and counts.",
    inputSchema: { type: "object", properties: { files: { type: "array", minItems: 1, maxItems: 16,
      items: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 }, max_lines: { type: "integer", minimum: 1 }, max_bytes: { type: "integer", minimum: 1 } },
        required: ["path"], additionalProperties: false } } }, required: ["files"], additionalProperties: false },
    validateArgs: validateReadBatch,
    handler: (args, ctx) => readFileTool(args as Parameters<typeof readFileTool>[0], ctx),
  },
  {
    name: "write_file", description: "Batch overwrite, append or guarded edits.",
    inputSchema: { type: "object", properties: { operations: { type: "array", minItems: 1, maxItems: 16,
      items: { type: "object", properties: { path: { type: "string" }, mode: { type: "string", enum: ["overwrite", "append", "replace_text", "replace_lines"] },
        content: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" },
        start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 }, expected_sha256: { type: "string" } },
        required: ["path", "mode"], additionalProperties: false } } }, required: ["operations"], additionalProperties: false },
    validateArgs: validateWriteBatch,
    handler: (args, ctx) => writeFileTool(args as Parameters<typeof writeFileTool>[0], ctx),
  },
  {
    name: "bash", description: "Run Bash commands sequentially.",
    inputSchema: { type: "object", properties: { commands: { type: "array", minItems: 1, maxItems: 16,
      items: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer", minimum: 1 } },
        required: ["command"], additionalProperties: false } } }, required: ["commands"], additionalProperties: false },
    validateArgs: validateBashBatch,
    handler: (args, ctx) => bashTool(args as Parameters<typeof bashTool>[0], ctx),
  },
];

const imageTool: ToolRegistration = {
  name: "view_image", description: "Read a PNG or JPEG image from a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  handler: (args, ctx) => viewImageTool(args as { path: string }, ctx),
};

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
