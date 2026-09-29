import type { ToolContent, ToolHandlerContent, ToolHandlerResult, ToolResult } from "./types.js";
import { MAX_IMAGE_BYTES } from "./types.js";

export function utf8Prefix(value: string, limit: number): { text: string; bytes: number; truncated: boolean } {
  let text = "";
  let bytes = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar);
    if (bytes + size > limit) return { text, bytes, truncated: true };
    text += scalar;
    bytes += size;
  }
  return { text, bytes, truncated: false };
}

export function textResult(value: string, maxOutputBytes: number, meta: Partial<ToolResult> = {}): ToolResult {
  const prefix = utf8Prefix(value, maxOutputBytes);
  return {
    isError: false,
    content: [{ type: "text", text: prefix.text }],
    truncated: prefix.truncated,
    retainedBytes: prefix.bytes,
    observedBytes: Buffer.byteLength(value),
    ...meta,
  };
}

export function errorResult(code: string, message: string): ToolResult {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

export type IndexedResult = Record<string, unknown> & { index: number; status: string };

export function indexedResultFits(results: readonly IndexedResult[], maxOutputBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify({ results }), "utf8") <= maxOutputBytes;
}

export function indexedResult(results: readonly IndexedResult[], maxOutputBytes: number, isError: boolean): ToolResult {
  if (!indexedResultFits(results, maxOutputBytes)) return errorResult("output_budget_too_small", "batch status exceeds output budget");
  return { isError, content: [{ type: "json", value: { results } }] };
}

/** Panel blocks pass through untouched and uncounted: their own limits (panels-design §14) bound them, not the output budget. */
export function capResult(result: ToolResult, maxOutputBytes: number): ToolResult;
export function capResult(result: ToolHandlerResult, maxOutputBytes: number): ToolHandlerResult;
export function capResult(result: ToolHandlerResult, maxOutputBytes: number): ToolHandlerResult {
  let remaining = maxOutputBytes;
  let truncated = false;
  const content: ToolHandlerContent[] = [];
  let observed = 0;
  let imageBytes = 0;
  for (const block of result.content) {
    if (block.type === "text") {
      observed += Buffer.byteLength(block.text);
      const prefix = utf8Prefix(block.text, remaining);
      remaining -= prefix.bytes;
      truncated ||= prefix.truncated;
      content.push({ ...block, text: prefix.text });
    } else if (block.type === "json") {
      const serialized = JSON.stringify(block.value);
      observed += Buffer.byteLength(serialized);
      if (Buffer.byteLength(serialized) <= remaining) {
        remaining -= Buffer.byteLength(serialized);
        content.push(block);
      } else {
        const preview = utf8Prefix(`[JSON preview] ${serialized}`, remaining);
        remaining -= preview.bytes;
        truncated = true;
        content.push({ type: "text", text: preview.text });
      }
    } else if (block.type === "panel") {
      content.push(block);
    } else {
      const size = Buffer.from(block.data, "base64").length;
      imageBytes += size;
      if (imageBytes > MAX_IMAGE_BYTES) return capResult(errorResult("image_too_large", "tool images exceed 16 MiB"), maxOutputBytes);
      observed += Buffer.byteLength(block.data);
      content.push(block);
    }
  }
  const retained = maxOutputBytes - remaining + content.reduce((sum, block) => sum + (block.type === "image" ? Buffer.byteLength(block.data) : 0), 0);
  return { ...result, content, truncated: result.truncated || truncated, retainedBytes: retained, observedBytes: result.observedBytes ?? observed };
}
