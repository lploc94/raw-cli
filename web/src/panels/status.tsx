import { Ban, CheckCircle2, Circle, CircleDashed, CircleX, MinusCircle, Loader } from "lucide-react";
import type { PanelItemStatus, PanelRef } from "../../../src/panels/contract.js";

const labels: Record<PanelItemStatus, string> = {
  pending: "Pending", in_progress: "In progress", done: "Done", skipped: "Skipped", blocked: "Blocked", failed: "Failed",
};
/** A status glyph that also carries its meaning as text, so it never relies on shape or colour alone. */
export function StatusGlyph({ status }: { status: PanelItemStatus | undefined }) {
  const value = status ?? "pending";
  const props = { size: 15, "aria-hidden": true as const };
  const icon =
    value === "done" ? <CheckCircle2 {...props} /> :
    value === "in_progress" ? <Loader {...props} className="panel-spin" /> :
    value === "failed" ? <CircleX {...props} /> :
    value === "blocked" ? <Ban {...props} /> :
    value === "skipped" ? <MinusCircle {...props} /> :
    status ? <Circle {...props} /> : <CircleDashed {...props} />;
  return <span className={`panel-status status-${value}`} title={labels[value]}>{icon}<span className="sr-only">{labels[value]}</span></span>;
}

/** A file reference: inserts `@path` into the composer instead of opening anything. */
export function Ref({ value, onInsert }: { value: PanelRef; onInsert: (path: string) => void }) {
  return (
    <button type="button" className="panel-ref" onClick={() => onInsert(value.path)} title={`Insert @${value.path} into the message`}>
      {value.path}{value.line ? `:${value.line}` : ""}
    </button>
  );
}
export type InsertRef = (path: string) => void;
