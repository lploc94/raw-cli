import type { ToolResult } from "../tools/types.js";
import { ProviderError } from "./client.js";

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
