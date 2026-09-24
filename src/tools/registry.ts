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

const READ_FILE_DESCRIPTION = [
  "Read 1-16 UTF-8 files in one call; results correspond to files by zero-based index. Relative paths use the session cwd.",
  "With only path, request the whole file. For lines, start_line is 1-based and defaults to 1; use inclusive end_line or max_lines, never both. A start past EOF returns empty text.",
  "Each ok or partial result reports the actual line range, eof, text, and sha256 of the exact returned file bytes, including original line endings and BOM.",
  "If a read exceeds the shared output budget or max_bytes, it returns complete leading lines with status partial and next_line; read again with start_line=next_line. If the first selected line cannot fit, status is line_too_large; a limit too small for result metadata may return budget_exhausted. A file error does not stop later entries.",
].join(" ");

const WRITE_FILE_DESCRIPTION = [
  "Apply 1-16 file operations in array order; results correspond to operations by zero-based index. Relative paths use the session cwd.",
  "overwrite and append require content and create the file and parent directories. replace_text requires nonempty old_text and a new_text string; it changes exactly one literal occurrence, otherwise fails without writing. Empty new_text deletes that occurrence.",
  "replace_lines requires existing 1-based inclusive start_line and end_line, content, and lowercase expected_sha256. First read exactly those lines with read_file, then copy that result's sha256 into expected_sha256; it hashes the original selected bytes, including BOM and line endings. A changed selected span or missing line fails without writing. Empty content deletes the lines; a nonempty replacement without a final newline keeps the original separator before following lines.",
  "Invalid arguments reject the whole batch before any write. Runtime errors are reported per operation and later operations continue; completed writes are not rolled back. Abort skips remaining operations.",
].join(" ");

const BASH_DESCRIPTION = [
  "Run 1-16 Bash commands sequentially in array order; results correspond to commands by zero-based index.",
  "Each command starts a separate Bash process in the session cwd. Filesystem changes persist; shell variables and cd do not carry to the next command. timeout_ms is an optional per-command deadline in milliseconds (default 120000).",
  "Each result reports status, exit_code, signal, timed_out, truncated, stdout, and stderr. Status ok means the command finished; inspect exit_code to determine success. A nonzero exit does not stop later commands. Timeout or abort stops the active process group and marks remaining commands skipped.",
  "All output shares one bounded result budget, so stdout or stderr may be truncated. Invalid arguments reject the entire batch before any command starts.",
].join(" ");

const builtIns: readonly ToolRegistration[] = [
  {
    name: "read_file", description: READ_FILE_DESCRIPTION,
    inputSchema: { type: "object", properties: { files: { type: "array", minItems: 1, maxItems: 16,
      description: "Independent file selections; return rows follow this order.",
      items: { type: "object", properties: {
        path: { type: "string", description: "File path, absolute or relative to the session cwd." },
        start_line: { type: "integer", minimum: 1, description: "First 1-based line; omit for a full read. Defaults to 1 for a range." },
        end_line: { type: "integer", minimum: 1, description: "Inclusive last line; do not combine with max_lines." },
        max_lines: { type: "integer", minimum: 1, description: "Maximum complete lines from start_line; do not combine with end_line." },
        max_bytes: { type: "integer", minimum: 1, description: "Optional byte cap for this serialized success row, including JSON framing." },
      },
        required: ["path"], additionalProperties: false } } }, required: ["files"], additionalProperties: false },
    validateArgs: validateReadBatch,
    handler: (args, ctx) => readFileTool(args as Parameters<typeof readFileTool>[0], ctx),
  },
  {
    name: "write_file", description: WRITE_FILE_DESCRIPTION,
    inputSchema: { type: "object", properties: { operations: { type: "array", minItems: 1, maxItems: 16,
      description: "Ordered writes; a runtime failure in one operation does not undo other successful operations.",
      items: { type: "object", properties: {
        path: { type: "string", description: "File path, absolute or relative to the session cwd." },
        mode: { type: "string", enum: ["overwrite", "append", "replace_text", "replace_lines"],
          description: "overwrite/append use content; replace_text uses old_text/new_text; replace_lines uses a guarded line range and content." },
        content: { type: "string", description: "Whole content for overwrite, suffix for append, or replacement lines for replace_lines. Empty content is allowed." },
        old_text: { type: "string", description: "Nonempty literal text for replace_text; must occur exactly once." },
        new_text: { type: "string", description: "Replacement for replace_text; empty text deletes the match." },
        start_line: { type: "integer", minimum: 1, description: "First existing 1-based line for replace_lines." },
        end_line: { type: "integer", minimum: 1, description: "Inclusive last existing line for replace_lines; must not precede start_line." },
        expected_sha256: { type: "string", description: "Lowercase sha256 from read_file for exactly the selected original lines; guards against changed bytes." },
      },
        required: ["path", "mode"], additionalProperties: false } } }, required: ["operations"], additionalProperties: false },
    validateArgs: validateWriteBatch,
    handler: (args, ctx) => writeFileTool(args as Parameters<typeof writeFileTool>[0], ctx),
  },
  {
    name: "bash", description: BASH_DESCRIPTION,
    inputSchema: { type: "object", properties: { commands: { type: "array", minItems: 1, maxItems: 16,
      description: "Bash commands run one at a time in this order.",
      items: { type: "object", properties: {
        command: { type: "string", description: "Nonempty Bash -c command to run in the session cwd." },
        timeout_ms: { type: "integer", minimum: 1, description: "Positive deadline for this command in milliseconds; defaults to 120000." },
      },
        required: ["command"], additionalProperties: false } } }, required: ["commands"], additionalProperties: false },
    validateArgs: validateBashBatch,
    handler: (args, ctx) => bashTool(args as Parameters<typeof bashTool>[0], ctx),
  },
];

const imageTool: ToolRegistration = {
  name: "view_image", description: "Read a local PNG or JPEG when visual details matter. The result is a native image block for you to inspect, not a text description; use it for screenshots, diagrams, or photos. Relative paths use the session cwd. Files over 16 MiB and unsupported or invalid formats return an error.",
  inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute image path or path relative to the session cwd." } }, required: ["path"], additionalProperties: false },
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
