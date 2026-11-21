import { imagePlaceholderText, isNativeCompaction, type ApiMethod, type ModelMessage } from "./types.js";
import type { ToolContent } from "../tools/types.js";

function historicalResult(message: Extract<ModelMessage, { role: "tool" }>): string {
  const content = message.result.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "json") return JSON.stringify(block.value);
    return `[Historical ${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes; reload the image if needed]`;
  }).join("\n");
  return `[Historical tool result: ${message.name}, call ${message.callId}, ${message.result.isError ? "error" : "success"}]\n${content}`;
}

/** Starts the portable form of a provider-native compaction item (design §6.9.1). */
export const NATIVE_SUMMARY_PREFIX = "[Earlier conversation summary]\n";

export function projectReplayMessages(messages: readonly ModelMessage[], replayBefore: number): ModelMessage[] {
  if (replayBefore <= 0) return [...messages];
  return messages.flatMap((message, index): ModelMessage[] => {
    if (index >= replayBefore || message.role === "user") return [message];
    if (message.role === "tool") return [{ role: "user", content: historicalResult(message) }];
    // A native compaction item is readable only by the provider that wrote it; its portable text leads as user input.
    if (isNativeCompaction(message)) return [{ role: "user", content: `${NATIVE_SUMMARY_PREFIX}${message.text}` }];
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
 * The provider's own API hosts. A model without `base_url` uses them unless the SDK's environment variable names another
 * endpoint (the SDKs read it when no base URL is passed).
 */
const FIRST_PARTY_HOSTS: Partial<Record<ApiMethod, string>> = {
  "anthropic-messages": "api.anthropic.com", "openai-chat-completions": "api.openai.com", "openai-responses": "api.openai.com",
  "google-generate-content": "generativelanguage.googleapis.com",
};
const SDK_BASE_URL_ENV: Partial<Record<ApiMethod, string>> = {
  "anthropic-messages": "ANTHROPIC_BASE_URL", "openai-chat-completions": "OPENAI_BASE_URL", "openai-responses": "OPENAI_BASE_URL",
  "google-generate-content": "GOOGLE_GEMINI_BASE_URL",
};
function firstParty(method: ApiMethod, baseUrl: string | undefined): boolean {
  const env = SDK_BASE_URL_ENV[method];
  const endpoint = baseUrl || (env ? process.env[env] : undefined);
  if (!endpoint) return true;
  try { return new URL(endpoint).hostname === FIRST_PARTY_HOSTS[method]; } catch { return false; }
}

/**
 * Image limits of one request to this endpoint, with headroom for request framing. The provider's own API uses its
 * documented limits (checked 2026-11-21): Anthropic 10 MB and 8000 px per image (3000 px once a request has more than
 * 20 images), 600 images when the configured window is over 200k tokens, else 100 (the limit for 200k-token models) and 128 MB per request
 * (platform.claude.com/docs/en/build-with-claude/vision, /api/overview); OpenAI 1500 images and 512 MB per request
 * (developers.openai.com/api/docs/guides/images-vision); Google 3600 images and 20 MB inline. Another endpoint speaking
 * the same API (a proxy, Bedrock, a local server) keeps the stricter limits Raw used before, since its own are unknown:
 * 5 MB per image, 2000 px for many images, 100 images and 32 MB for Anthropic, 500 images and 50 MB for OpenAI,
 * 3000 images and 20 MB for Google.
 */
export function requestImageLimits(method: ApiMethod, model: { baseUrl?: string; contextWindow?: number } = {}): RequestImageLimits {
  const override = limitOverrides.get(method);
  if (override) return override;
  const own = firstParty(method, model.baseUrl);
  if (method === "anthropic-messages") {
    return own
      ? { perImage: 10 * MiB, request: 120 * MiB, count: (model.contextWindow ?? 0) > 200_000 ? 600 : 100,
        maxDimension: 8000, manyImages: { above: 20, maxDimension: 3000 } }
      : { perImage: 5 * MiB, request: 30 * MiB, count: 100, maxDimension: 8000, manyImages: { above: 20, maxDimension: 2000 } };
  }
  if (method === "google-generate-content") return { request: 18 * MiB, count: own ? 3600 : 3000 };
  return own ? { request: 480 * MiB, count: 1500 } : { request: 45 * MiB, count: 500 };
}

const limitOverrides = new Map<ApiMethod, RequestImageLimits>();
/** Replaces a method's limits (tests use small ones); `undefined` restores the documented values. */
export function setRequestImageLimitsForTests(method: ApiMethod, limits: RequestImageLimits | undefined): void {
  if (limits) limitOverrides.set(method, limits);
  else limitOverrides.delete(method);
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
  const omitted = imageOmissions(messages, limits, reservedBytes, true);
  if (!omitted.size) return [...messages];
  return replaceImages(messages, (block) => omitted.get(block));
}

/**
 * Whether the request allowance (image count, request bytes, the many-images pixel bound) would leave out an image that
 * the per-image limits admit. Per-image omissions are deterministic; allowance omissions change as the conversation grows.
 */
export function imageAllowanceExceeded(messages: readonly ModelMessage[], limits: RequestImageLimits, reservedBytes: () => number = () => 0): boolean {
  return imageOmissions(messages, limits, reservedBytes, true).size > imageOmissions(messages, limits, reservedBytes, false).size;
}

/** Image blocks of `messages[0..before)` become text naming them, as compaction leaves them (docs/context.md). */
export function removeImagesBefore(messages: readonly ModelMessage[], before: number): ModelMessage[] {
  return replaceImages(messages, (block, index) => {
    if (index >= before) return undefined;
    const image = block as ImageBlock;
    const name = "path" in image && image.path ? `, ${JSON.stringify(image.path)}` : "name" in image && image.name ? `, ${JSON.stringify(image.name)}` : "";
    const bytes = "byteSize" in image && image.byteSize !== undefined ? image.byteSize : Buffer.from(image.data, "base64").length;
    return `[Image removed at compaction: ${image.mimeType}, ${bytes} bytes${name}; view it again if you need it]`;
  });
}

function replaceImages(messages: readonly ModelMessage[], note: (block: object, index: number) => string | undefined): ModelMessage[] {
  return messages.map((message, index): ModelMessage => {
    const text = (block: { type: string }) => block.type === "image" ? note(block, index) : undefined;
    if (message.role === "user" && typeof message.content !== "string" && message.content.some((block) => text(block) !== undefined)) {
      return { role: "user", content: message.content.map((block) => { const value = text(block); return value !== undefined ? { type: "text" as const, text: value } : block; }) };
    }
    if (message.role === "tool" && message.result.content.some((block) => text(block) !== undefined)) {
      return { ...message, result: { ...message.result, content: message.result.content.map((block): ToolContent => {
        const value = text(block); return value !== undefined ? { type: "text", text: value } : block; }) } };
    }
    return message;
  });
}

function imageOmissions(messages: readonly ModelMessage[], limits: RequestImageLimits, reservedBytes: () => number, allowance: boolean): Map<object, string> {
  const omitted = new Map<object, string>();
  if (!messages.some((message) => imageBlocks(message).some((block) => block.type === "image"))) return omitted;
  // Everything but image payloads, as JSON escapes it; a tool argument that happens to be named `data` still counts.
  const textBytes = Buffer.byteLength(JSON.stringify(messages, function (this: unknown, key, value) {
    return key === "data" && typeof value === "string" && (this as { type?: unknown } | null)?.type === "image" ? "" : value;
  }), "utf8");
  let budget = limits.request - reservedBytes() - textBytes;
  const admitted: ImageBlock[] = [];
  const label = (image: ImageBlock) => `${image.mimeType}${"path" in image && image.path ? `, ${JSON.stringify(image.path)}`
    : "name" in image && image.name ? `, ${JSON.stringify(image.name)}` : ""}`;
  const smaller = "The original stays in the conversation. If you need to see it, make a smaller copy (downscale it or convert it to JPEG with a shell tool) and view that copy.";
  const tooLarge = (image: ImageBlock, maxDimension: number) => {
    const size = imageDimensions(image);
    return size !== null && Math.max(size.width, size.height) > maxDimension ? size : undefined;
  };
  // Admitted images over the many-images pixel bound; while any is admitted, the request cannot grow past the threshold.
  let overStrict = 0;
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
      } else {
        // Past the many-images threshold every image must meet the stricter bound; newer images are never given up for older ones.
        if (!allowance) continue;
        const strict = limits.manyImages ? tooLarge(image, limits.manyImages.maxDimension) : undefined;
        const crowded = limits.manyImages !== undefined && admitted.length + 1 > limits.manyImages.above;
        if (crowded && strict && overStrict === 0) {
          omitted.set(block, `[Image omitted from this request: ${label(image)}, ${strict.width}x${strict.height} px, over the provider's ${limits.manyImages!.maxDimension} px limit for requests with more than ${limits.manyImages!.above} images. ${smaller}]`);
        } else if (admitted.length + 1 > limits.count || size > budget || (crowded && (strict || overStrict > 0))) {
          omitted.set(block, `[Image omitted from this request: ${label(image)}, ${megabytes(size)} encoded. Newer images and the rest of the conversation already use the provider's request allowance (${limits.count} images, ${megabytes(limits.request)} per request); view it again if you need it.]`);
        } else { admitted.push(image); budget -= size; if (strict) overStrict++; }
      }
    }
  }
  return omitted;
}
