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

/** The kind whose `accept` list contains this mime type. */
export function kindForMime(metas: KindMeta[], mime: string) {
  return metas.find((meta) => meta.enabled && meta.accept.includes(mime));
}
