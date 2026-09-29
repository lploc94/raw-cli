import { AlertTriangle, LoaderCircle, RotateCcw, X } from "lucide-react";
import { clientKinds } from "./attachment-kinds.js";
import "./builtin-kinds.js";
import type { KindMeta } from "./attachment-kinds.js";
import type { Chip } from "./useAttachments.js";

const size = (bytes?: number) =>
  bytes === undefined
    ? ""
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1048576
        ? `${(bytes / 1024).toFixed(0)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`;

export function AttachmentChips({
  chips,
  metas,
  onRemove,
  onRetry,
}: {
  chips: Chip[];
  /** Current agent's kinds: warnings follow the selected agent, not the agent at upload time. */
  metas: KindMeta[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  if (!chips.length) return null;
  return (
    <ul className="chips" aria-label="Attachments">
      {chips.map((chip) => (
        <li
          key={chip.key}
          className={`attachment-chip ${chip.status}`}
          aria-busy={chip.status === "uploading" || undefined}
          title={chip.path ?? chip.name}
        >
          {chip.thumbnail ? (
            <img className="chip-thumb" src={chip.thumbnail} alt="" />
          ) : (
            clientKinds.get(chip.kindId)?.icon
          )}
          <span className="attachment-name">{chip.name}</span>
          <span className="muted small">{size(chip.size)}</span>
          {chip.status === "uploading" && (
            <span role="status" className="chip-state">
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
              <span className="sr-only">Uploading {chip.name}</span>
            </span>
          )}
          {chip.status === "error" && (
            <span className="chip-error" role="alert">
              <AlertTriangle size={14} aria-hidden="true" /> {chip.error}
            </span>
          )}
          {chip.status === "ready" &&
            (() => {
              const warning = metas.find((meta) => meta.id === chip.kindId)?.warning;
              return (
                warning && (
                  <span className="chip-warning small" title={warning}>
                    {warning}
                  </span>
                )
              );
            })()}
          {chip.status === "error" && chip.file && (
            <button
              type="button"
              className="icon-button"
              aria-label={`Retry ${chip.name}`}
              onClick={() => onRetry(chip.key)}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${chip.name}`}
            onClick={() => onRemove(chip.key)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
