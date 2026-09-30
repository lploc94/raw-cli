import type { PanelReceipt } from "../../../src/panels/contract.js";
import { PanelGlyph } from "./Section.js";
import type { PanelIcon } from "../../../src/panels/contract.js";

/** A compact chat row for one committed or rejected panel update. Clicking it shows the section in the side panel. */
export function Receipt({ receipt, icon, onOpen, openLabel = "Show this panel in the side panel" }: {
  receipt: PanelReceipt; icon: PanelIcon; onOpen: () => void; openLabel?: string;
}) {
  const progress = receipt.progress && receipt.progress.total > 0 ? receipt.progress.done / receipt.progress.total : undefined;
  return (
    <button type="button" className={`panel-receipt ${receipt.error ? "rejected" : ""}`} onClick={onOpen} title={openLabel}>
      <PanelGlyph icon={icon} size={15} />
      <span className="panel-receipt-title">{receipt.title}</span>
      {receipt.source === "user_action" && <small className="panel-tag">You</small>}
      <span className="panel-receipt-summary">
        {receipt.error ? `Update rejected: ${receipt.error.code}` : receipt.op === "close" ? "Closed" : receipt.summary}
      </span>
      {progress !== undefined && !receipt.error && <span className="panel-progress-line" aria-hidden="true" style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} />}
    </button>
  );
}
