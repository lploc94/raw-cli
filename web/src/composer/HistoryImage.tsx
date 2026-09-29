import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { ImageOff, X } from "lucide-react";
import type { HistoryAttachment } from "../../../src/sessions/view.js";
import { fetchDataUrl } from "../api.js";

/** A stored image, fetched with the Bearer header from the history endpoint and shown as a `data:` URL. */
export function HistoryImage({
  sessionId,
  sequence,
  attachment,
}: {
  sessionId: string;
  sequence: number;
  attachment: HistoryAttachment;
}) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setSrc(undefined);
    setFailed(false);
    fetchDataUrl(
      `/sessions/${encodeURIComponent(sessionId)}/history/${sequence}/attachments/${attachment.index}`,
      controller.signal,
    ).then(setSrc, () => !controller.signal.aborted && setFailed(true));
    return () => controller.abort();
  }, [sessionId, sequence, attachment.index]);
  if (failed)
    return (
      <span className="attachment-chip attachment-missing" role="img" aria-label={`${attachment.name} could not be loaded`}>
        <ImageOff size={14} aria-hidden="true" />
        <span className="attachment-name">{attachment.name}</span>
      </span>
    );
  if (!src) return <span className="attachment-thumb loading" aria-busy="true" />;
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="attachment-thumb" aria-label={`Open ${attachment.name}`}>
          <img src={src} alt={attachment.name} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog image-dialog" aria-describedby={undefined}>
          <div className="dialog-title-row">
            <Dialog.Title>{attachment.name}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close image">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <img className="image-full" src={src} alt={attachment.name} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
