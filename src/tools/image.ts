import { open, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { errorResult } from "./results.js";
import type { ToolContext } from "./primitives.js";
import type { ToolResult } from "./types.js";
import { MAX_IMAGE_BYTES } from "./types.js";

export { MAX_IMAGE_BYTES } from "./types.js";
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngValid(data: Buffer): boolean {
  if (data.length < 8 || !data.subarray(0, 8).equals(pngMagic)) return false;
  let offset = 8;
  let first = true;
  let hasData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return false;
    const type = data.toString("ascii", offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (let index = offset + 4; index < offset + 8 + length; index++) {
      crc ^= data[index]!;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(offset + 8 + length)) return false;
    if (first && (type !== "IHDR" || length !== 13 || !data.readUInt32BE(offset + 8) || !data.readUInt32BE(offset + 12))) return false;
    if (type === "IDAT") hasData = true;
    offset += length + 12;
    if (type === "IEND") return length === 0 && hasData && offset === data.length;
    first = false;
  }
  return false;
}

function jpegValid(data: Buffer): boolean {
  if (data.length < 16 || data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217) return false;
  let offset = 2;
  let hasFrame = false;
  while (offset + 4 <= data.length) {
    if (data[offset++] !== 255) return false;
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217) return false;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > data.length) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || length > data.length - offset) return false;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (length < 8 || !data.readUInt16BE(offset + 3) || !data.readUInt16BE(offset + 5)) return false;
      hasFrame = true;
    }
    if (marker === 218) return hasFrame && length >= 6 && offset + length < data.length - 2;
    offset += length;
  }
  return false;
}

/** Sniffs structurally valid PNG/JPEG bytes; undefined when neither. */
export function detectImageMime(data: Buffer): "image/png" | "image/jpeg" | undefined {
  if (pngValid(data)) return "image/png";
  if (jpegValid(data)) return "image/jpeg";
  return undefined;
}

export async function viewImageTool(args: { path: string }, context: ToolContext): Promise<ToolResult> {
  const path = resolve(context.cwd, args.path);
  if (context.signal?.aborted) return errorResult("aborted", "image read aborted");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return errorResult("image_read_error", `not a regular file: ${path}`);
    if (stat.size > MAX_IMAGE_BYTES) return errorResult("image_too_large", `image exceeds 16 MiB: ${path}`);
    if (stat.size < 4) return errorResult("image_invalid", `unsupported or invalid image: ${path}`);
    const data = Buffer.alloc(stat.size);
    let position = 0;
    while (position < data.length) {
      if (context.signal?.aborted) return errorResult("aborted", "image read aborted");
      const { bytesRead } = await handle.read(data, position, data.length - position, position);
      if (bytesRead === 0) return errorResult("image_read_error", `image changed while reading: ${path}`);
      position += bytesRead;
    }
    if (context.signal?.aborted) return errorResult("aborted", "image read aborted");
    let mimeType: "image/png" | "image/jpeg";
    if (pngValid(data)) mimeType = "image/png";
    else if (jpegValid(data)) mimeType = "image/jpeg";
    else return errorResult("image_invalid", `unsupported or invalid image: ${path}`);
    const encoded = data.toString("base64");
    return { isError: false, content: [{ type: "image", mimeType, data: encoded, path, byteSize: data.length }],
      observedBytes: data.length, retainedBytes: encoded.length, truncated: false };
  } catch (error) {
    return errorResult("image_read_error", `cannot read image ${path}: ${(error as Error).message}`);
  } finally { await handle?.close(); }
}
