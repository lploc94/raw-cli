import { bashTool, type ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  const unexpected = Object.keys(args).find((key) => key !== "commands");
  if (unexpected !== undefined) return `unknown bash property ${JSON.stringify(unexpected)}; use {"commands":[{"command":"..."}]}`;
  if (!Array.isArray(args.commands) || args.commands.length < 1 || args.commands.length > 16) return "commands must contain 1 to 16 entries";
  for (const [index, raw] of args.commands.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `commands[${index}] must be an object with a command field, e.g. {"command":"pwd"}; strings are invalid`;
    const command = raw as Record<string, unknown>;
    if (Object.keys(command).some((key) => !["command", "timeout_ms", "env_refs"].includes(key))) return `commands[${index}] has an unknown property`;
    if (typeof command.command !== "string" || !command.command) return `commands[${index}].command must be a nonempty string`;
    if (command.env_refs !== undefined) {
      if (!command.env_refs || typeof command.env_refs !== "object" || Array.isArray(command.env_refs)
        || Object.entries(command.env_refs).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || !value)) return `commands[${index}].env_refs must map environment identifiers to variable names`;
    }
    if (command.timeout_ms !== undefined && (!Number.isSafeInteger(command.timeout_ms) || (command.timeout_ms as number) < 1
      || (command.timeout_ms as number) > 2147483647)) return `commands[${index}].timeout_ms must be a positive integer`;
  }
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return bashTool(args as Parameters<typeof bashTool>[0], context);
}
