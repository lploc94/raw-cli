import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const kind = Buffer.from(type);
  const bytes = Buffer.concat([kind, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  kind.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}

/** A structurally valid RGBA PNG with incompressible pixels; size grows with width x height. */
export function makePng(width = 64, height = 40): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) randomBytes(stride - 1).copy(pixels, row * stride + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A valid PNG of roughly the requested byte size. */
export function makePngOfSize(bytes: number): Buffer {
  const width = 1024;
  return makePng(width, Math.max(1, Math.ceil(bytes / (1 + width * 4))));
}

export const jpegFixture = (): Buffer => readFileSync(new URL("./vision.jpg", import.meta.url));

export const imageBlock = (data: Buffer, mimeType: "image/png" | "image/jpeg" = "image/png", name?: string) =>
  ({ type: "image" as const, data: data.toString("base64"), mimeType, ...(name ? { name } : {}) });
