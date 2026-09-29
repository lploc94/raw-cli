import type { ToolResult } from "../tools/types.js";
import { ProviderError } from "./client.js";
import { detectImageMime } from "../tools/image.js";
import { base64ByteLength, type UserInput } from "./types.js";

export const MAX_USER_IMAGES_BYTES = 16 * 1024 * 1024;
export type NativeUserPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png" | "image/jpeg"; data: string };

/**
 * The single normalization point for user input. Returns ordered content parts in original block
 * order and validates every image (base64, PNG/JPEG structure, declared type, 16 MiB aggregate).
 */
export function nativeUserContent(input: UserInput): NativeUserPart[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  const parts: NativeUserPart[] = [];
  let total = 0;
  for (const block of input) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      if (block.mimeType !== "image/png" && block.mimeType !== "image/jpeg") throw new ProviderError("unsupported_content", `unsupported image type: ${block.mimeType}`);
      if (typeof block.data !== "string" || block.data.length > Math.ceil(MAX_USER_IMAGES_BYTES / 3) * 4
        || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
        throw new ProviderError("unsupported_content", "invalid or oversized image base64");
      }
      total += base64ByteLength(block.data);
      if (total > MAX_USER_IMAGES_BYTES) throw new ProviderError("unsupported_content", "images exceed 16 MiB in one message");
      const decoded = Buffer.from(block.data, "base64");
      if (decoded.toString("base64") !== block.data) throw new ProviderError("unsupported_content", "invalid image base64");
      if (detectImageMime(decoded) !== block.mimeType) throw new ProviderError("unsupported_content", "image bytes are not a valid image of the declared type");
      parts.push({ type: "image", mimeType: block.mimeType, data: block.data });
    } else parts.push({ type: "text", text: `\n[Resource link] ${JSON.stringify(block)}\n` });
  }
  return parts;
}

export interface NativeToolContent {
  text: string;
  images: { mimeType: "image/png" | "image/jpeg"; data: string }[];
}

export function nativeToolContent(result: ToolResult): NativeToolContent {
  const text: string[] = [];
  const images: NativeToolContent["images"] = [];
  let decodedBytes = 0;
  for (const block of result.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "json") {
      const value = JSON.stringify(block.value);
      if (value === undefined) throw new ProviderError("unsupported_content", "tool JSON content is not serializable");
      text.push(value);
    } else if (block.type === "image") {
      if (block.mimeType !== "image/png" && block.mimeType !== "image/jpeg") throw new ProviderError("unsupported_content", `unsupported image type: ${block.mimeType}`);
      if (block.data.length > Math.ceil(16 * 1024 * 1024 / 3) * 4 || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
        throw new ProviderError("unsupported_content", "invalid or oversized image base64");
      }
      const decoded = Buffer.from(block.data, "base64");
      if (decoded.toString("base64") !== block.data) throw new ProviderError("unsupported_content", "invalid image base64");
      decodedBytes += decoded.length;
      if (decodedBytes > 16 * 1024 * 1024) throw new ProviderError("unsupported_content", "tool image exceeds 16 MiB");
      images.push({ mimeType: block.mimeType, data: block.data });
    } else throw new ProviderError("unsupported_content", "unsupported tool content");
  }
  return { text: text.join("\n"), images };
}
