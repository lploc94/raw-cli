import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { UserBlock } from "../llm/types.js";
import { detectImageMime } from "../tools/image.js";
import { DashboardError } from "./errors.js";

/** Bytes of a stored attachment, addressed by kind so history routes stay kind-agnostic. */
export interface AttachmentContent { mimeType: string; bytes: Buffer; name?: string; source?: string }
export interface StagedAttachment {
  id: string; sessionId: string; kind: string; name: string; mimeType: string; byteSize: number; bytes: Buffer; createdAt: number;
  /** Where the user's browser said the file came from (a `file:`, `http:` or `https:` link), when it said. */
  source?: string;
}
export type AttachmentInfo = Pick<StagedAttachment, "id" | "name" | "mimeType" | "byteSize" | "source"> & { kind: string };

/**
 * One uploadable attachment type. Upload, staging, consumption and history serving are generic;
 * supporting a new type means registering a kind here (plus its model-layer mapping and a client renderer).
 */
export interface AttachmentKind {
  id: string;
  /** Accepted types; `*\/*` accepts any type no other kind lists. */
  mimeTypes: readonly string[];
  maxBytes: number;
  /** True when a model needs vision to read this kind natively; other models get a text placeholder instead of an error. */
  needsVision?: boolean;
  validate(bytes: Buffer, mimeType: string): void;
  toBlock(item: StagedAttachment): UserBlock;
  /** Recovers stored bytes from a saved user block of this kind; undefined when the block is not this kind. */
  fromBlock(block: UserBlock): AttachmentContent | undefined;
}

export const MAX_UPLOAD_IMAGE_BYTES = 8 * 1024 * 1024;

export const imageKind: AttachmentKind = {
  id: "image",
  mimeTypes: ["image/png", "image/jpeg"],
  maxBytes: MAX_UPLOAD_IMAGE_BYTES,
  needsVision: true,
  validate(bytes, mimeType) {
    if (detectImageMime(bytes) !== mimeType) throw new DashboardError(400, "invalid_attachment", `The file is not a valid ${mimeType} image`);
  },
  toBlock: (item) => ({ type: "image", data: item.bytes.toString("base64"), mimeType: item.mimeType as "image/png" | "image/jpeg", name: item.name,
    ...(item.source ? { source: item.source } : {}) }),
  fromBlock: (block) => block.type === "image"
    ? { mimeType: block.mimeType, bytes: Buffer.from(block.data, "base64"), ...(block.source ? { source: block.source } : {}) } : undefined,
};

/** Any type; a kind listing it takes what no other kind accepts. */
export const ANY_MIME = "*/*";
/**
 * Largest uploaded file that is not an image. Staged bytes stay in memory until the turn is sent, so this is the per-chat
 * staging budget (`DEFAULT_STAGING_LIMITS.maxBytesPerSession`): a larger file could never be staged anyway. Only that
 * file is refused; a bigger file reaches the model by path instead (a workspace `@` reference or a `file:` link drop).
 */
export const MAX_UPLOAD_FILE_BYTES = 16 * 1024 * 1024;
const SOURCE_PREFIX = "Uploaded by the user from ";

/** A `file:`, `http:` or `https:` link of at most 2048 characters, else undefined (a bad link is dropped, never an error). */
export function attachmentSource(value: string | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try { return ["file:", "http:", "https:"].includes(new URL(value).protocol) ? value : undefined; } catch { return undefined; }
}

/**
 * Files that are not images: the model cannot take their bytes, so a turn saves each one under `<root>/<session id>/<id>/`
 * and sends a `resource_link` to that copy, which the model reads with its file tools. The link's description names the
 * source. The session store removes a session's folder with the session (`SessionStore.uploadsRoot`).
 */
export function createFileKind(root: string): AttachmentKind {
  return {
    id: "file",
    mimeTypes: [ANY_MIME],
    maxBytes: MAX_UPLOAD_FILE_BYTES,
    validate() {},
    toBlock(item) {
      const folder = join(root, item.sessionId, item.id);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const name = /^\.*$/.test(item.name) ? "attachment" : item.name;
      const path = join(folder, name);
      writeFileSync(path, item.bytes, { mode: 0o600 });
      return { type: "resource_link", uri: pathToFileURL(path).href, name, mimeType: item.mimeType, size: item.byteSize,
        description: `${item.source ? `${SOURCE_PREFIX}${item.source}` : "Uploaded by the user"}; Raw saved this copy at the link's path.` };
    },
    fromBlock(block) {
      if (block.type !== "resource_link" || !block.uri.startsWith("file:")) return undefined;
      let path: string;
      try { path = fileURLToPath(block.uri); } catch { return undefined; }
      const inside = relative(root, path);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { return undefined; }
      const source = block.description?.startsWith(SOURCE_PREFIX)
        ? attachmentSource(block.description.slice(SOURCE_PREFIX.length).replace(/; Raw saved this copy at the link's path\.$/, "")) : undefined;
      return { mimeType: block.mimeType ?? "application/octet-stream", bytes, name: block.name, ...(source ? { source } : {}) };
    },
  };
}

export class AttachmentKinds {
  private readonly kinds = new Map<string, AttachmentKind>();
  constructor(initial: readonly AttachmentKind[] = [imageKind]) { for (const kind of initial) this.register(kind); }
  register(kind: AttachmentKind): void { this.kinds.set(kind.id, kind); }
  unregister(id: string): void { this.kinds.delete(id); }
  list(): AttachmentKind[] { return [...this.kinds.values()]; }
  byMime(mimeType: string): AttachmentKind | undefined {
    return this.list().find((kind) => kind.mimeTypes.includes(mimeType)) ?? this.list().find((kind) => kind.mimeTypes.includes(ANY_MIME));
  }
  content(block: UserBlock): { kind: AttachmentKind; content: AttachmentContent } | undefined {
    for (const kind of this.kinds.values()) { const content = kind.fromBlock(block); if (content) return { kind, content }; }
    return undefined;
  }
}

export interface StagingLimits { ttlMs: number; maxPerSession: number; maxBytesPerSession: number; maxBytesTotal: number }
export const DEFAULT_STAGING_LIMITS: StagingLimits = {
  ttlMs: 30 * 60 * 1000, maxPerSession: 8, maxBytesPerSession: 16 * 1024 * 1024, maxBytesTotal: 128 * 1024 * 1024,
};

/** In-memory upload staging. Items are consumed only when an operation is newly accepted; nothing survives a restart. */
export class AttachmentStaging {
  private readonly items = new Map<string, StagedAttachment>();
  constructor(readonly kinds: AttachmentKinds = new AttachmentKinds(), private readonly limits: StagingLimits = DEFAULT_STAGING_LIMITS,
    private readonly now: () => number = Date.now) {}

  private prune(): void {
    const cutoff = this.now() - this.limits.ttlMs;
    for (const [id, item] of this.items) if (item.createdAt < cutoff) this.items.delete(id);
  }
  private forSession(sessionId: string): StagedAttachment[] { return [...this.items.values()].filter((item) => item.sessionId === sessionId); }
  private static info(item: StagedAttachment): AttachmentInfo {
    return { id: item.id, kind: item.kind, name: item.name, mimeType: item.mimeType, byteSize: item.byteSize, ...(item.source ? { source: item.source } : {}) };
  }

  stage(sessionId: string, upload: { mimeType: string; name: string; bytes: Buffer; source?: string }): AttachmentInfo {
    this.prune();
    const kind = this.kinds.byMime(upload.mimeType);
    if (!kind) throw new DashboardError(415, "unsupported_media_type",
      `Unsupported attachment type. Accepted: ${this.kinds.list().flatMap((entry) => entry.mimeTypes).join(", ")}`);
    if (!upload.bytes.length) throw new DashboardError(400, "invalid_attachment", "The attachment is empty");
    if (upload.bytes.length > kind.maxBytes) throw new DashboardError(413, "attachment_too_large", `Attachment exceeds ${kind.maxBytes} bytes`);
    kind.validate(upload.bytes, upload.mimeType);
    const mine = this.forSession(sessionId);
    const total = [...this.items.values()].reduce((sum, item) => sum + item.byteSize, 0);
    if (mine.length >= this.limits.maxPerSession
      || mine.reduce((sum, item) => sum + item.byteSize, 0) + upload.bytes.length > this.limits.maxBytesPerSession
      || total + upload.bytes.length > this.limits.maxBytesTotal) {
      throw new DashboardError(413, "attachments_too_large", "Too many or too large attachments are staged for this chat; remove one first");
    }
    const item: StagedAttachment = { id: randomUUID(), sessionId, kind: kind.id, name: upload.name.slice(0, 200) || "attachment",
      mimeType: upload.mimeType, byteSize: upload.bytes.length, bytes: upload.bytes, createdAt: this.now(),
      ...(attachmentSource(upload.source) ? { source: upload.source! } : {}) };
    this.items.set(item.id, item);
    return AttachmentStaging.info(item);
  }
  remove(sessionId: string, id: string): boolean {
    const item = this.items.get(id);
    if (!item || item.sessionId !== sessionId) return false;
    return this.items.delete(id);
  }
  /** Resolves ids without consuming them; unknown, expired or foreign ids fail. */
  resolve(sessionId: string, ids: readonly string[]): StagedAttachment[] {
    this.prune();
    return ids.map((id) => {
      const item = this.items.get(id);
      if (!item || item.sessionId !== sessionId) throw new DashboardError(422, "unknown_attachment", "An attachment expired or does not belong to this chat; attach it again");
      return item;
    });
  }
  /** A staged item of this session, still there; nothing is consumed. */
  read(sessionId: string, id: string): StagedAttachment | undefined {
    this.prune();
    const item = this.items.get(id);
    return item && item.sessionId === sessionId ? item : undefined;
  }
  release(ids: readonly string[]): void { for (const id of ids) this.items.delete(id); }
  size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
