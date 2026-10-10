import { imagePlaceholderText, type ApiMethod, type ModelMessage } from "./types.js";
import type { ToolContent } from "../tools/types.js";

function historicalResult(message: Extract<ModelMessage, { role: "tool" }>): string {
  const content = message.result.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "json") return JSON.stringify(block.value);
    return `[Historical ${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes; reload the image if needed]`;
  }).join("\n");
  return `[Historical tool result: ${message.name}, call ${message.callId}, ${message.result.isError ? "error" : "success"}]\n${content}`;
}

export function projectReplayMessages(messages: readonly ModelMessage[], replayBefore: number): ModelMessage[] {
  if (replayBefore <= 0) return [...messages];
  return messages.flatMap((message, index): ModelMessage[] => {
    if (index >= replayBefore || message.role === "user") return [message];
    if (message.role === "tool") return [{ role: "user", content: historicalResult(message) }];
    const calls = message.toolCalls.map((call) =>
      `[Historical tool call: ${call.name}, call ${call.id}]\nArguments: ${call.rawArguments ?? JSON.stringify(call.arguments)}`);
    return [{ role: "assistant", text: [message.text, ...calls].filter(Boolean).join("\n")
      || "[Historical assistant response contained no portable text]", toolCalls: [] }];
  });
}

/**
 * Request-time vision degradation: a model that cannot read images receives a text placeholder for
 * every user image. The stored context is never rewritten, so a later vision model sees the original.
 */
export function projectVisionMessages(messages: readonly ModelMessage[], vision: boolean): ModelMessage[] {
  if (vision) return [...messages];
  return messages.map((message): ModelMessage => message.role === "user" && typeof message.content !== "string"
    && message.content.some((block) => block.type === "image")
    ? { role: "user", content: message.content.map((block) => block.type === "image"
      ? { type: "text" as const, text: imagePlaceholderText(block) } : block) }
    : message);
}

/** Image limits of one request, measured in base64 characters because that is what the request body carries. */
export interface RequestImageLimits { perImage?: number; total: number; count: number }

const MiB = 1024 * 1024;
/**
 * Documented API limits with headroom for the rest of the request: Anthropic rejects an image over 5 MB and a
 * request over 32 MB, OpenAI a request over 50 MB, and Google inline data past a 20 MB request.
 */
export function requestImageLimits(method: ApiMethod): RequestImageLimits {
  if (method === "anthropic-messages") return { perImage: 5 * MiB, total: 24 * MiB, count: 100 };
  if (method === "google-generate-content") return { total: 18 * MiB, count: 3000 };
  return { total: 40 * MiB, count: 500 };
}

type ImageBlock = Extract<ToolContent, { type: "image" }> | { type: "image"; mimeType: string; data: string; name?: string };
const megabytes = (characters: number) => `${(characters / MiB).toFixed(1)} MiB`;

/**
 * Request-time size degradation: an image the provider would reject, or one past the request's image allowance once
 * newer images are counted, is sent as a text note instead of failing the whole request. The stored context keeps
 * the original, so a later request or another provider can still send it.
 */
export function projectImageLimits(messages: readonly ModelMessage[], limits: RequestImageLimits): ModelMessage[] {
  const omitted = new Map<object, string>();
  let total = 0;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const blocks: readonly { type: string }[] = message.role === "user" ? (typeof message.content === "string" ? [] : message.content)
      : message.role === "tool" ? message.result.content : [];
    for (let at = blocks.length - 1; at >= 0; at--) {
      const block = blocks[at]!;
      if (block.type !== "image") continue;
      const image = block as ImageBlock;
      const size = image.data.length;
      const source = "path" in image && image.path ? `, ${JSON.stringify(image.path)}` : "name" in image && image.name ? `, ${JSON.stringify(image.name)}` : "";
      if (limits.perImage !== undefined && size > limits.perImage) {
        omitted.set(block, `[Image omitted from this request: ${image.mimeType}${source}, ${megabytes(size)} encoded, over the provider's ${megabytes(limits.perImage)} per-image limit. The original stays in the conversation. If you need to see it, make a smaller copy (downscale it or convert it to JPEG with a shell tool) and view that copy.]`);
      } else if (count + 1 > limits.count || total + size > limits.total) {
        omitted.set(block, `[Image omitted from this request: ${image.mimeType}${source}, ${megabytes(size)} encoded. Newer images already use the provider's per-request allowance (${limits.count} images, ${megabytes(limits.total)} encoded); view it again if you need it.]`);
      } else { count++; total += size; }
    }
  }
  if (!omitted.size) return [...messages];
  return messages.map((message): ModelMessage => {
    if (message.role === "user" && typeof message.content !== "string" && message.content.some((block) => omitted.has(block))) {
      return { role: "user", content: message.content.map((block) => omitted.has(block) ? { type: "text" as const, text: omitted.get(block)! } : block) };
    }
    if (message.role === "tool" && message.result.content.some((block) => omitted.has(block))) {
      return { ...message, result: { ...message.result, content: message.result.content.map((block): ToolContent =>
        omitted.has(block) ? { type: "text", text: omitted.get(block)! } : block) } };
    }
    return message;
  });
}
