import type { ReactNode } from "react";
import type { HistoryAttachment } from "../../../src/sessions/view.js";

/** What the server reports for a kind in `GET /api/agents/:name/composer`. */
export interface KindMeta {
  id: string;
  accept: string[];
  maxBytes: number;
  enabled: boolean;
  warning?: string;
}

/**
 * Client side of an attachment kind. A new kind is one entry here plus the server registration;
 * chips, upload, drag-drop, paste and the timeline all dispatch through this map.
 */
export interface ClientKind {
  id: string;
  label: string;
  icon: ReactNode;
  /** Local thumbnail for a chip from the picked file (a `data:` URL), if the kind has one. */
  thumbnail?: (file: File) => Promise<string | undefined>;
  /** Timeline rendering of a stored attachment. */
  timeline: (attachment: HistoryAttachment, sessionId: string, sequence: number) => ReactNode;
}

const kinds = new Map<string, ClientKind>();
export const clientKinds = {
  register(kind: ClientKind) {
    kinds.set(kind.id, kind);
  },
  unregister(id: string) {
    kinds.delete(id);
  },
  get(id: string) {
    return kinds.get(id);
  },
};

/** Any type: a kind that accepts it takes what no other kind lists. */
export const ANY_MIME = "*/*";
/** The kind whose `accept` list contains this mime type, else the kind that accepts any type. */
export function kindForMime(metas: KindMeta[], mime: string) {
  return metas.find((meta) => meta.enabled && meta.accept.includes(mime))
    ?? metas.find((meta) => meta.enabled && meta.accept.includes(ANY_MIME));
}

/** The file picker's `accept` attribute: empty (any file) when a kind accepts any type. */
export function acceptAttribute(metas: KindMeta[]): string {
  const accepted = metas.filter((meta) => meta.enabled).flatMap((meta) => meta.accept);
  return accepted.includes(ANY_MIME) ? "" : accepted.join(",") || "image/png,image/jpeg";
}

/**
 * The links a drop or paste carries (`text/uri-list`, comment lines skipped), and for each file the link at its
 * position when there is one per file; browsers list them in the same order. A count that differs pairs nothing.
 */
/**
 * A link worth sending as a file's source: `file:`, `http:` or `https:` and at most 2048 characters, as the server keeps
 * (`attachmentSource`). Anything else, such as a long `data:` URL of an image dragged from a page, is not sent: it would
 * only be dropped, and a header over Node's 16 KiB limit fails the whole upload.
 */
export function sourceLink(value: string | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try { return ["file:", "http:", "https:"].includes(new URL(value).protocol) ? value : undefined; } catch { return undefined; }
}

export function transferLinks(data: DataTransfer, files: File[]): { links: string[]; sources: (string | undefined)[] } {
  let text = "";
  try { text = data.getData("text/uri-list"); } catch { text = ""; }
  const links = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return { links, sources: files.map((_file, index) => (links.length === files.length ? sourceLink(links[index]) : undefined)) };
}
