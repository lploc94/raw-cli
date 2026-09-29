import { randomUUID } from "node:crypto";
import type { UserBlock } from "../llm/types.js";
import { detectImageMime } from "../tools/image.js";
import { DashboardError } from "./errors.js";

/** Bytes of a stored attachment, addressed by kind so history routes stay kind-agnostic. */
export interface AttachmentContent { mimeType: string; bytes: Buffer }
export interface StagedAttachment {
  id: string; sessionId: string; kind: string; name: string; mimeType: string; byteSize: number; bytes: Buffer; createdAt: number;
}
export type AttachmentInfo = Pick<StagedAttachment, "id" | "name" | "mimeType" | "byteSize"> & { kind: string };

/**
 * One uploadable attachment type. Upload, staging, consumption and history serving are generic;
 * supporting a new type means registering a kind here (plus its model-layer mapping and a client renderer).
 */
export interface AttachmentKind {
  id: string;
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
  toBlock: (item) => ({ type: "image", data: item.bytes.toString("base64"), mimeType: item.mimeType as "image/png" | "image/jpeg", name: item.name }),
  fromBlock: (block) => block.type === "image" ? { mimeType: block.mimeType, bytes: Buffer.from(block.data, "base64") } : undefined,
};

export class AttachmentKinds {
  private readonly kinds = new Map<string, AttachmentKind>();
  constructor(initial: readonly AttachmentKind[] = [imageKind]) { for (const kind of initial) this.register(kind); }
  register(kind: AttachmentKind): void { this.kinds.set(kind.id, kind); }
  unregister(id: string): void { this.kinds.delete(id); }
  list(): AttachmentKind[] { return [...this.kinds.values()]; }
  byMime(mimeType: string): AttachmentKind | undefined { return this.list().find((kind) => kind.mimeTypes.includes(mimeType)); }
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
    return { id: item.id, kind: item.kind, name: item.name, mimeType: item.mimeType, byteSize: item.byteSize };
  }

  stage(sessionId: string, upload: { mimeType: string; name: string; bytes: Buffer }): AttachmentInfo {
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
      mimeType: upload.mimeType, byteSize: upload.bytes.length, bytes: upload.bytes, createdAt: this.now() };
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
  release(ids: readonly string[]): void { for (const id of ids) this.items.delete(id); }
  size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
