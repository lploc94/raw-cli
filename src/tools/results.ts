import type { ToolContent, ToolResult } from "./types.js";

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

export function capResult(result: ToolResult, maxOutputBytes: number): ToolResult {
  let remaining = maxOutputBytes;
  let truncated = false;
  const content: ToolContent[] = [];
  let observed = 0;
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
    } else {
      const size = Buffer.byteLength(block.data);
      observed += size;
      if (size <= remaining) {
        remaining -= size;
        content.push(block);
      } else {
        const preview = utf8Prefix(`[${block.mimeType} omitted: ${size} bytes]`, remaining);
        remaining -= preview.bytes;
        truncated = true;
        content.push({ type: "text", text: preview.text });
      }
    }
  }
  return { ...result, content, truncated: result.truncated || truncated, retainedBytes: maxOutputBytes - remaining, observedBytes: result.observedBytes ?? observed };
}
