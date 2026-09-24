import { open, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runBash } from "./process.js";
import { errorResult, textResult, utf8Prefix } from "./results.js";
import type { ToolResult } from "./types.js";

export interface ToolContext {
  cwd: string;
  maxOutputBytes: number;
  autoApprove?: boolean;
  approve?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => boolean | Promise<boolean>;
  whitelist?: readonly string[];
  signal?: AbortSignal;
  bashPath?: string;
}

export async function readFileTool(args: { path: string }, context: ToolContext): Promise<ToolResult> {
  const path = resolve(context.cwd, args.path);
  try {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return errorResult("read_error", `not a regular file: ${path}`);
      const buffer = Buffer.alloc(context.maxOutputBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const limited = buffer.subarray(0, Math.min(bytesRead, context.maxOutputBytes));
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      const text = decoder.decode(limited, { stream: bytesRead > context.maxOutputBytes });
      const prefix = utf8Prefix(text, context.maxOutputBytes);
      return textResult(prefix.text, context.maxOutputBytes, {
        truncated: bytesRead > context.maxOutputBytes || prefix.truncated,
        retainedBytes: prefix.bytes,
        observedBytes: bytesRead,
      });
    } finally { await handle.close(); }
  } catch (error) {
    return errorResult("read_error", `cannot read ${path}: ${(error as Error).message}`);
  }
}

export async function writeFileTool(args: { path: string; content: string }, context: ToolContext): Promise<ToolResult> {
  const path = resolve(context.cwd, args.path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.content, "utf8");
    return textResult(`wrote ${path}`, context.maxOutputBytes);
  } catch (error) {
    return errorResult("write_error", `cannot write ${path}: ${(error as Error).message}`);
  }
}

export async function bashTool(args: { command: string; timeout_ms?: number }, context: ToolContext): Promise<ToolResult> {
  return runBash({
    command: args.command,
    cwd: context.cwd,
    maxOutputBytes: context.maxOutputBytes,
    ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.bashPath ? { bashPath: context.bashPath } : {}),
  });
}
