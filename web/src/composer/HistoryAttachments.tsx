import type { HistoryAttachment } from "../../../src/sessions/view.js";
import { clientKinds } from "./attachment-kinds.js";
import "./builtin-kinds.js";

/** Attachments of one user message, rendered through the client kind registry. */
export function HistoryAttachments({
  items,
  sessionId,
  sequence,
}: {
  items: HistoryAttachment[];
  sessionId: string;
  sequence: number;
}) {
  return (
    <div className="attachment-row" aria-label="Attachments">
      {items.map(
        (item) =>
          clientKinds.get(item.kind)?.timeline(item, sessionId, sequence) ?? (
            <span className="attachment-chip" key={item.index}>
              <span className="attachment-name">{item.name}</span>
            </span>
          ),
      )}
    </div>
  );
}
