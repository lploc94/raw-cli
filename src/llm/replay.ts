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

/**
 * Image limits of one request. Sizes are bytes of the request body, where an image travels as base64 text;
 * `request` bounds the whole body, so text, system prompt and tool schemas count against it too.
 */
export interface RequestImageLimits {
  perImage?: number; request: number; count: number;
  /** Largest width or height in pixels, and the stricter bound that applies once a request carries many images. */
  maxDimension?: number; manyImages?: { above: number; maxDimension: number };
}

const MiB = 1024 * 1024;
/**
 * Documented API limits with headroom for request framing: Anthropic rejects an image over 5 MB or 8000 px (2000 px
 * when a request has more than 20 images) and a request over 32 MB, OpenAI a request over 50 MB, Google one over 20 MB.
 */
export function requestImageLimits(method: ApiMethod): RequestImageLimits {
  if (method === "anthropic-messages") return { perImage: 5 * MiB, request: 30 * MiB, count: 100, maxDimension: 8000, manyImages: { above: 20, maxDimension: 2000 } };
  if (method === "google-generate-content") return { request: 18 * MiB, count: 3000 };
  return { request: 45 * MiB, count: 500 };
}

type ImageBlock = Extract<ToolContent, { type: "image" }> | { type: "image"; mimeType: string; data: string; name?: string };
const megabytes = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`;

const dimensionCache = new WeakMap<object, { width: number; height: number } | null>();
/** Pixel size from the PNG header or the first JPEG frame header; null when it cannot be read. */
function imageDimensions(block: ImageBlock): { width: number; height: number } | null {
  const cached = dimensionCache.get(block);
  if (cached !== undefined) return cached;
  let found: { width: number; height: number } | null = null;
  if (block.mimeType === "image/png") {
    const head = Buffer.from(block.data.slice(0, 32), "base64");
    if (head.length >= 24) found = { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } else {
    const data = Buffer.from(block.data, "base64");
    for (let offset = 2; offset + 9 <= data.length;) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        found = { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
        break;
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  dimensionCache.set(block, found);
  return found;
}

const imageBlocks = (message: ModelMessage): readonly { type: string }[] => message.role === "user"
  ? (typeof message.content === "string" ? [] : message.content) : message.role === "tool" ? message.result.content : [];

/**
 * Request-time degradation: an image the provider would reject (too large, too many pixels), or one past the request
 * allowance once newer images and the rest of the request are counted, is sent as a text note instead of failing the
 * whole request. Newest images are admitted first. The stored context keeps every original.
 * `reservedBytes` measures the part of the request outside `messages` (system prompt, tool schemas); it runs only when images are present.
 */
export function projectImageLimits(messages: readonly ModelMessage[], limits: RequestImageLimits, reservedBytes: () => number = () => 0): ModelMessage[] {
  if (!messages.some((message) => imageBlocks(message).some((block) => block.type === "image"))) return [...messages];
  const omitted = new Map<object, string>();
  const textBytes = Buffer.byteLength(JSON.stringify(messages, (key, value) =>
    key === "data" && typeof value === "string" ? "" : value), "utf8");
  let budget = limits.request - reservedBytes() - textBytes;
  const admitted: ImageBlock[] = [];
  const label = (image: ImageBlock) => `${image.mimeType}${"path" in image && image.path ? `, ${JSON.stringify(image.path)}`
    : "name" in image && image.name ? `, ${JSON.stringify(image.name)}` : ""}`;
  const smaller = "The original stays in the conversation. If you need to see it, make a smaller copy (downscale it or convert it to JPEG with a shell tool) and view that copy.";
  const tooLarge = (image: ImageBlock, maxDimension: number) => {
    const size = imageDimensions(image);
    return size !== null && Math.max(size.width, size.height) > maxDimension ? size : undefined;
  };
  for (let index = messages.length - 1; index >= 0; index--) {
    const blocks = imageBlocks(messages[index]!);
    for (let at = blocks.length - 1; at >= 0; at--) {
      const block = blocks[at]!;
      if (block.type !== "image") continue;
      const image = block as ImageBlock;
      const size = image.data.length;
      const pixels = limits.maxDimension !== undefined ? tooLarge(image, limits.maxDimension) : undefined;
      if (limits.perImage !== undefined && size > limits.perImage) {
        omitted.set(block, `[Image omitted from this request: ${label(image)}, ${megabytes(size)} encoded, over the provider's ${megabytes(limits.perImage)} per-image limit. ${smaller}]`);
      } else if (pixels) {
        omitted.set(block, `[Image omitted from this request: ${label(image)}, ${pixels.width}x${pixels.height} px, over the provider's ${limits.maxDimension} px limit. ${smaller}]`);
      } else if (admitted.length + 1 > limits.count || size > budget) {
        omitted.set(block, `[Image omitted from this request: ${label(image)}, ${megabytes(size)} encoded. Newer images and the rest of the conversation already use the provider's request allowance (${limits.count} images, ${megabytes(limits.request)} per request); view it again if you need it.]`);
      } else { admitted.push(image); budget -= size; }
    }
  }
  // Past the many-images threshold every image in the request must meet the stricter dimension bound.
  if (limits.manyImages && admitted.length > limits.manyImages.above) {
    for (const image of admitted) {
      const pixels = tooLarge(image, limits.manyImages.maxDimension);
      if (pixels) omitted.set(image, `[Image omitted from this request: ${label(image)}, ${pixels.width}x${pixels.height} px, over the provider's ${limits.manyImages.maxDimension} px limit for requests with more than ${limits.manyImages.above} images. ${smaller}]`);
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
