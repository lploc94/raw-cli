import { useMemo, useState } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { Approval } from "../../../src/dashboard/approvals.js";
import { errorText } from "../api.js";
import { answerApproval } from "../approvals.js";
import { CodeBlock } from "../markdown.js";
import { Diff } from "../tool-cards/ResultBody.js";
import { ErrorMessage } from "../ui.js";
import { approvalPreviews, type ApprovalPreviewEntry } from "./approval-preview.js";

/** What the call intends to do to a file, in a word the row can show. */
const OPERATION = { write: "Write", edit: "Edit", delete: "Delete", rename_source: "Rename from", rename_destination: "Rename to" } as const;

/** One intended file: its name and folder, what happens to it, and its preview behind a chevron. */
function IntendedFile({ entry }: { entry: ApprovalPreviewEntry }) {
  const [open, setOpen] = useState(false);
  const counts = entry.added !== undefined || entry.removed !== undefined;
  const row = (
    <>
      <span className="review-file-text">
        <span className="review-file-name">{entry.display.name}</span>
        <span className="review-file-folder">{entry.display.folder}</span>
      </span>
      {entry.operation && <span className="review-file-operation">{OPERATION[entry.operation]}</span>}
      {counts && (
        <span className="review-file-stats">
          {entry.added !== undefined && <span className="review-file-added">+{entry.added}</span>}
          {entry.removed !== undefined && <span className="review-file-removed">−{entry.removed}</span>}
        </span>
      )}
      {entry.diff && <ChevronRight size={14} aria-hidden="true" className="panel-chevron" />}
    </>
  );
  return (
    <li className="review-file">
      <div className="panel-row">
        {entry.diff
          ? <button type="button" className="review-file-row" aria-expanded={open} title={entry.path} onClick={() => setOpen(!open)}>{row}</button>
          : <span className="review-file-row" title={entry.path}>{row}</span>}
      </div>
      {open && entry.diff && <div className="panel-file-diff"><Diff text={entry.diff} /></div>}
      {entry.note && <p className="review-note">{entry.note}</p>}
    </li>
  );
}

/** One call waiting for permission: what it intends to change, then the answer. */
function ReviewCard({ approval, cwd }: { approval: Approval; cwd: string | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showArguments, setShowArguments] = useState(false);
  // A patch can be large: the preview is rebuilt when the request changes, not on every frame of the turn.
  const { entries, omitted } = useMemo(() => approvalPreviews(approval, cwd), [approval, cwd]);
  const deadline = new Date(approval.deadline);
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError("");
    try {
      await answerApproval(approval, allow);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <section className="review-card" aria-label={`${approval.title} needs your answer`}>
      <div className="review-top">
        <span className="sp-chip tone-warning">
          <ShieldAlert size={11} aria-hidden="true" />
          Waiting for you
        </span>
        <span className="tool-spacer" />
        <span className="review-meta" title={`Expires ${deadline.toLocaleString()}`}>
          {approval.name} · expires {deadline.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <p className="review-headline">
        <span className="review-title">{approval.title}</span>
        {approval.summary && <code className="review-summary">{approval.summary}</code>}
      </p>
      {entries.length > 0 && <ul className="review-files">{entries.map((entry) => <IntendedFile key={entry.key} entry={entry} />)}</ul>}
      {omitted > 0 && <p className="review-note">… and {omitted} more {omitted === 1 ? "file" : "files"}</p>}
      {showArguments && (
        <div className="review-arguments">
          <CodeBlock code={JSON.stringify(approval.arguments, null, 2)} language="json" />
          {approval.effects && (
            <>
              <p className="review-effects">Intended effects</p>
              <CodeBlock code={JSON.stringify(approval.effects, null, 2)} language="json" />
            </>
          )}
        </div>
      )}
      <div className="review-actions">
        <button type="button" className="foot-button" aria-expanded={showArguments} onClick={() => setShowArguments(!showArguments)}>
          Arguments
        </button>
        <span className="tool-spacer" />
        <button type="button" className="foot-button" disabled={busy} onClick={() => { void answer(false); }}>
          Deny
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          title="Allow this call once? This does not change your rules."
          onClick={() => { void answer(true); }}
        >
          Allow once
        </button>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}

/**
 * The host-owned Approvals tab (docs/side-panel-design.md §3.3): one card per call waiting for permission, newest
 * first, each showing the files it intends to change before anything is written.
 */
export function Approvals({ items, cwd }: { items: readonly Approval[]; cwd?: string | undefined }) {
  if (!items.length) return <div className="approvals"><p className="review-empty">Nothing waits for approval.</p></div>;
  return (
    <div className="approvals">
      {[...items].sort((a, b) => b.createdAt - a.createdAt).map((item) => <ReviewCard key={item.id} approval={item} cwd={cwd} />)}
    </div>
  );
}
