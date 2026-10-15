import { InteractionView } from "./panels/InteractionView.js";
import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InlineToolView } from "./panels/ToolView.js";
import type { ActionHost } from "./panels/actions.js";
import type { InsertRef } from "./panels/status.js";
import { Brain, ChevronRight, LoaderCircle, ShieldAlert } from "lucide-react";
import type { HistoryView } from "../../src/sessions/view.js";
import type {
  VisibleToolCall,
  VisibleToolResult,
} from "../../src/sessions/visible.js";
import type { CompactionDetails } from "../../src/agent.js";
import type { Approval } from "../../src/dashboard/approvals.js";
import type { LiveSegment } from "../../src/dashboard/live-output.js";
import type { Preferences } from "./preferences.js";
import { api, errorText } from "./api.js";
import { isTerminal, type ChatState } from "./session.js";
import { CodeBlock, Markdown } from "./markdown.js";
import { CopyButton, ErrorMessage } from "./ui.js";
import type { PanelIcon, PanelReceipt } from "../../src/panels/contract.js";
import { Receipt } from "./panels/Receipt.js";
import { PanelGlyph } from "./panels/Tabs.js";
import { receiptPanel } from "./panels/panel-state.js";
import { COMMANDS_ID } from "./panels/commands-state.js";
import { APPROVALS_ID } from "./panels/approvals-state.js";
import { answerApproval } from "./approvals.js";
import { HistoryAttachments } from "./composer/HistoryAttachments.js";
import { ToolRow } from "./tool-cards/ToolRow.js";
import { ToolIcon } from "./tool-cards/ToolIcon.js";
import { diffTotals } from "./tool-cards/diff-totals.js";
import { statusBadge } from "./tool-cards/status.js";
import { assignStableKeys, splitTurns, type KeyUnit } from "./timeline-keys.js";
import type { SessionOperation } from "../../src/sessions/operations.js";
import type { InteractionRequest } from "../../src/interactions/contract.js";
import type { PanelStackItem } from "../../src/panels/stack.js";

/** The owner of the files-changed panel the editing tools share (src/tools/write-changes.ts FILES_CHANGED_OWNER). */
const FILES_CHANGED_OWNER = "host/files_changed";

/** The call's main text: the longest string argument with a line break (a file's content, a patch), else none. */
function mainText(args: Record<string, unknown>): string | undefined {
  const texts = Object.values(args).filter((value): value is string => typeof value === "string" && value.includes("\n"));
  return texts.sort((a, b) => b.length - a.length)[0];
}
const PREVIEW_LINES = 6;
/** The lines a write, an edit or a patch adds, from its normalized arguments; independent of the preview. */
function addedLines(args: Record<string, unknown>): number | undefined {
  const text = typeof args.content === "string" ? args.content : typeof args.new_string === "string" ? args.new_string : undefined;
  if (text !== undefined) return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  if (typeof args.patch === "string") return args.patch.split("\n").filter((line) => line.startsWith("+")).length;
  return undefined;
}

/**
 * A call waiting for approval (docs/chat-design.md §7): one card after its group. The chip, the tool and when the
 * approval expires; the call's headline and the lines it writes; a preview of its main text; Review, Arguments, Deny
 * and Allow once. Allow once and Deny answer only this call; Review opens the side panel's Approvals tab, where the
 * intended files and their proposed content are readable in full.
 */
export function ApprovalCard({ approval, call, onOpenPanel }: { approval: Approval; call?: VisibleToolCall | undefined; onOpenPanel?: ((panel: string) => void) | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showArguments, setShowArguments] = useState(false);
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
  const text = mainText(approval.arguments);
  const lines = text?.replace(/\n$/, "").split("\n");
  const added = call?.kind === "edit" ? addedLines(approval.arguments) : undefined;
  const deadline = new Date(approval.deadline);
  return (
    <section className="approval" aria-label="Tool permission">
      <div className="approval-top">
        <span className="sp-chip tone-warning">
          <ShieldAlert size={11} aria-hidden="true" />
          Needs approval
        </span>
        {onOpenPanel && (
          <button type="button" className="foot-button" title="Review the intended change in the side panel" onClick={() => onOpenPanel(APPROVALS_ID)}>
            Review
          </button>
        )}
        <span className="tool-spacer" />
        <span className="approval-meta" title={`Expires ${deadline.toLocaleString()}`}>
          {approval.name} · expires {deadline.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <p className="approval-headline">
        <ToolIcon icon={call?.icon} identity={call?.identity} kind={call?.kind} />
        <span className="approval-title">{approval.title}</span>
        {approval.summary && <code className="approval-summary">{approval.summary}</code>}
        <span className="tool-spacer" />
        {/* The lines a write or an edit adds. */}
        {added !== undefined && <span className="approval-lines">+{added}</span>}
      </p>
      {lines && (
        <pre className="approval-preview" tabIndex={0}>
          {/* At most six lines, the ellipsis included. */}
          {lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES - 1), "…"].join("\n") : lines.join("\n")}
        </pre>
      )}
      {showArguments && (
        <div className="approval-arguments">
          <CodeBlock code={JSON.stringify(approval.arguments, null, 2)} language="json" />
          {approval.effects && (
            <>
              <p className="approval-effects">Intended effects</p>
              <CodeBlock code={JSON.stringify(approval.effects, null, 2)} language="json" />
            </>
          )}
        </div>
      )}
      <div className="approval-actions">
        <button type="button" className="foot-button" aria-expanded={showArguments} onClick={() => setShowArguments(!showArguments)}>
          Arguments
        </button>
        <span className="tool-spacer" />
        <button
          type="button"
          className="foot-button"
          disabled={busy}
          onClick={() => {
            void answer(false);
          }}
        >
          Deny
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          title="Allow this call once? This does not change your rules."
          onClick={() => {
            void answer(true);
          }}
        >
          Allow once
        </button>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}
function Compaction({ details }: { details: CompactionDetails }) {
  const titles: Record<string, string> = {
    running: "Compacting context…",
    compacted: "Context compacted",
    noop: "Nothing to compact",
    not_smaller: "Summary was not smaller",
    cancelled: "Compaction cancelled",
    error: "Compaction failed",
  };
  return (
    <details className="compaction">
      <summary>
        <Brain size={16} aria-hidden="true" />
        {titles[details.status] ?? details.status}
        <span className="muted">{details.cause}</span>
      </summary>
      <div className="inset">
        <p>
          ~{details.beforeTokens.toLocaleString()} tokens
          {details.afterTokens === undefined
            ? ""
            : ` → ~${details.afterTokens.toLocaleString()}`}
          . Retains {details.keepRecentTurns} recent turns.
        </p>
        {details.beforeBytes !== undefined && (
          <p className="muted small">
            Serialized bytes: {details.beforeBytes.toLocaleString()} →{" "}
            {details.afterBytes?.toLocaleString() ?? "unavailable"}
          </p>
        )}
        {details.summary && (
          <>
            <Markdown>{details.summary}</Markdown>
            <CopyButton value={details.summary} label="Copy summary" />
          </>
        )}
        {details.message && <ErrorMessage>{details.message}</ErrorMessage>}
        <p className="muted small">
          Earlier messages stay in History. The model uses the summary and
          retained context.
        </p>
      </div>
    </details>
  );
}
function PagedLive({
  segment,
  sessionId,
}: {
  segment: LiveSegment;
  sessionId: string;
}) {
  const [loaded, setLoaded] = useState("");
  const [offset, setOffset] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <Markdown>{loaded || segment.text}</Markdown>
      <p className="muted small">
        Long live output · showing a partial preview. Committed history will
        replace it.
      </p>
      {!done && (
        <button
          onClick={() => {
            void api<{ text: string; nextOffset: number; done: boolean }>(
              `/sessions/${sessionId}/output?operationId=${segment.operationId}&segmentId=${encodeURIComponent(segment.segmentId)}&offset=${offset}`,
            ).then(
              (page) => {
                setLoaded((old) => old + page.text);
                setOffset(page.nextOffset);
                setDone(page.done);
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Load {offset ? "more" : "live output"}
        </button>
      )}
      <ErrorMessage>{segment.unavailable ?? error}</ErrorMessage>
    </div>
  );
}
/** A reasoning row: one muted italic line that opens to the full text. */
function ReasoningRow({ text, preferences }: { text: string; preferences: Preferences }) {
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? preferences.reasoning;
  const body = useId();
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={body} onClick={() => setExpanded(!open)}>
        <Brain size={14} aria-hidden="true" />
        <i>{open ? "Reasoning" : text.replace(/\s+/g, " ").trim()}</i>
      </button>
      {/* Rendered only when open, so the text is on the page once. */}
      <div className="reasoning-body" id={body} hidden={!open}>
        {open && <Markdown>{text}</Markdown>}
      </div>
    </div>
  );
}
/** A header pill: one panel the group updated, opening it in the side panel. */
interface WorkPill { key: string; label: ReactNode; name: string; icon: PanelIcon; error: boolean; onOpen: () => void }
/**
 * A turn's tool activity (docs/chat-design.md §6): a summary line (time, tool count, failed and approval chips, one pill
 * per panel updated) over the reasoning and tool rows. It opens on the user's toggle or by preference only; a pending
 * approval is a card after it.
 */
function WorkGroup({
  children,
  count,
  failed,
  approval,
  active,
  preferences,
  elapsedMs,
  pills,
}: {
  children: ReactNode;
  count: number;
  failed: number;
  approval: boolean;
  active: boolean;
  preferences: Preferences;
  elapsedMs?: number | undefined;
  pills: WorkPill[];
}) {
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? (preferences.reasoning || preferences.toolDetails);
  const content = useId();
  return (
    <div className="work-group" data-state={active ? "running" : "done"}>
      <div className="work-head">
        <button type="button" className="work-toggle" aria-expanded={open} aria-controls={content} onClick={() => setExpanded(!open)}>
          <ChevronRight className="chevron" size={14} aria-hidden="true" />
          <strong className="work-time">
            {active ? "Working" : elapsedMs !== undefined ? `Worked ${(elapsedMs / 1000).toFixed(1)}s` : "Worked"}
          </strong>
          <span className="work-count">· {count ? `${count} ${count === 1 ? "tool" : "tools"}` : "Reasoning"}</span>
          {failed > 0 && <span className="sp-chip tone-error">{failed} failed</span>}
          {approval && <span className="sp-chip tone-warning">Needs approval</span>}
        </button>
        <span className="tool-spacer" />
        {pills.map((pill) => (
          <button
            type="button"
            key={pill.key}
            className={`work-pill${pill.error ? " tone-error" : ""}`}
            aria-label={pill.name}
            title={`Show ${pill.name} in the side panel`}
            onClick={pill.onOpen}
          >
            <PanelGlyph icon={pill.icon} size={12} />
            <span className="pill-text">{pill.label}</span>
          </button>
        ))}
        {active && <LoaderCircle className="work-spinner" size={13} aria-hidden="true" />}
      </div>
      <div className="work-content" id={content} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
interface Pair {
  call?: VisibleToolCall;
  result?: VisibleToolResult;
  status?: string;
  abbreviated?: boolean;
}
type ViewFrame = ChatState["views"][string];

/** A user or assistant message; it renders again only when its record, its live segment or the session changes. */
const MessageRow = memo(function MessageRow({ item, segment, sessionId }: { item: HistoryView; segment: LiveSegment | undefined; sessionId: string }) {
  return (
    <article
      className={`message ${item.kind}`}
      data-testid={
        item.kind === "user" ? "user-message" : "assistant-message"
      }
    >
      {item.kind === "user" ? (
        <>
          {/* The user's bubble: attachments above the text, the time and Copy message under it. */}
          <div className="bubble">
            {item.attachments?.length ? (
              <HistoryAttachments
                items={item.attachments}
                sessionId={sessionId}
                sequence={item.sequence}
              />
            ) : null}
            {segment?.paged ? (
              <PagedLive segment={segment} sessionId={sessionId} />
            ) : (
              <div className="user-text">{item.text}</div>
            )}
          </div>
          <div className="message-meta">
            <time dateTime={new Date(item.createdAt).toISOString()}>
              {new Date(item.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <CopyButton value={item.text ?? ""} label="Copy message" />
          </div>
        </>
      ) : (
        <>
          <div className="message-label">
            <span className="avatar" aria-hidden="true">r</span>
            <strong>Raw</strong>
            <time dateTime={new Date(item.createdAt).toISOString()}>
              {new Date(item.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
          {segment?.paged ? (
            <PagedLive segment={segment} sessionId={sessionId} />
          ) : (
            <Markdown>{item.text ?? ""}</Markdown>
          )}
        </>
      )}
      {item.status === "interrupted" && (
        <small className="warning">Incomplete response</small>
      )}
      {item.kind === "assistant" && (
        <div className="message-actions">
          <CopyButton value={item.text ?? ""} label="Copy message" />
        </div>
      )}
    </article>
  );
});

/** Where a message the agent has not received yet stands (docs/chat-design.md §5). */
export type PendingStatus = "sending" | "waiting" | "not_delivered" | "not_sent" | "not_confirmed";
const PENDING_LABEL: Record<PendingStatus, string> = {
  sending: "Sending…",
  waiting: "Waiting for the agent",
  not_delivered: "Not delivered · the agent did not receive this message",
  not_sent: "Not sent",
  not_confirmed: "Not confirmed",
};

/**
 * Your message before the agent has it: the bubble with a status line under it instead of the time, and Retry and Edit
 * when the agent did not get it (docs/chat-design.md §5). An image only named after a reload is to attach again.
 */
export const PendingMessage = memo(function PendingMessage({ text, attachments, status, reason, onRetry, onEdit }: {
  text: string;
  attachments: ReadonlyArray<{ name: string; again?: boolean }>;
  status: PendingStatus;
  reason?: string | undefined;
  onRetry?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
}) {
  const failed = status === "not_delivered" || status === "not_sent" || status === "not_confirmed";
  return (
    <article className={`message user pending${failed ? " failed" : ""}`} data-testid="pending-message">
      <div className="bubble">
        {attachments.length ? (
          <div className="sent-attachments" aria-label="Attachments">
            {attachments.map((item, index) => (
              <span className="sent-attachment" key={index}>{item.again ? `${item.name} · attach again` : item.name}</span>
            ))}
          </div>
        ) : null}
        <div className="user-text">{text}</div>
      </div>
      <p className="pending-status">{PENDING_LABEL[status]}</p>
      {reason && <p className="pending-reason">{reason}</p>}
      {(onRetry || onEdit) && (
        <div className="pending-actions">
          {onRetry && <button type="button" className="text-button" onClick={onRetry}>Retry</button>}
          {onEdit && <button type="button" className="text-button" onClick={onEdit}>Edit</button>}
        </div>
      )}
    </article>
  );
});
/** The id of the record that stands for your pending message in the timeline. */
const PENDING_RECORD = "pending:message";

/**
 * One turn: your message and everything up to the next one. Its props are only what it shows, so a turn whose records,
 * calls, approvals, questions, views, operations and panels did not change is not rendered again (docs/chat-design.md §10).
 */
interface TurnProps {
  records: HistoryView[];
  /** Each record's call key (`<scope>:<callId>`), or "" for a record without a call. */
  keys: string[];
  pairs: Map<string, Pair>;
  approvals: Approval[];
  interactions: InteractionRequest[];
  live: LiveSegment[];
  views: ViewFrame[];
  operations: SessionOperation[];
  compactions: CompactionDetails[];
  panels: PanelStackItem[];
  /** Calls, views and compactions an earlier turn already rendered. */
  priorTools: string[];
  priorViews: string[];
  priorCompactions: string[];
  sessionId: string;
  preferences: Preferences;
  availabilityRevision: string;
  actions: ActionHost | undefined;
  onInsert: InsertRef;
  onOpenPanel: (panel: string) => void;
  /** Your pending message, for the turn that holds it. */
  pending: ReactNode;
  /** Operations with work in a later turn: their time shows on their last group only. */
  laterWork: string[];
}
const NONE: never[] = [];
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const samePairs = (a: Map<string, Pair>, b: Map<string, Pair>) => {
  if (a.size !== b.size) return false;
  for (const [key, pair] of a) {
    const other = b.get(key);
    if (!other || other.call !== pair.call || other.result !== pair.result || other.status !== pair.status || other.abbreviated !== pair.abbreviated) return false;
  }
  return true;
};
function sameTurn(a: TurnProps, b: TurnProps): boolean {
  for (const name of Object.keys(a) as Array<keyof TurnProps>) {
    const x = a[name];
    const y = b[name];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && sameList(x, y)) continue;
    if (x instanceof Map && y instanceof Map && samePairs(x, y)) continue;
    return false;
  }
  return true;
}

/** A record a Work group shows: reasoning or a tool call, not a tool view or a question card. */
const isWork = (record: HistoryView) =>
  !record.interactionRequestId && !(record.toolView ?? record.panelReceipt?.view) && (record.kind === "reasoning" || !!record.callId);

const TurnView = memo(function TurnView({
  records, keys, pairs, approvals: pendingApprovals, interactions, live, views, operations, compactions, panels,
  priorTools, priorViews, priorCompactions, sessionId, preferences, availabilityRevision, actions, onInsert, onOpenPanel, pending, laterWork,
}: TurnProps) {
  /** Each record's group key in the last committed render, so a group keeps its key when records join it at either end. */
  const groupKeys = useRef<ReadonlyMap<string, string>>(new Map());
  const result: Array<ReactNode | { unit: KeyUnit; render: (key: string) => ReactNode }> = [];
  /** The open group's entries; rows are built at flush, when the receipts of its calls are known. */
  let work: Array<{ reasoning: string; id: string } | { key: string; callId: string; operationId?: string | undefined }> = [];
  let workIds: string[] = [];
  let receipts: PanelReceipt[] = [];
  let workActive = false;
  let elapsedMs: number | undefined;
  /** Whether the open group holds its operation's last work: only that group says Working or how long the operation took. */
  let workLast = false;
  const lastWork = new Map<string, number>();
  records.forEach((item, index) => {
    if (item.operationId && isWork(item)) lastWork.set(item.operationId, index);
  });
  const renderedTools = new Set(priorTools);
  const renderedCompact = new Set(priorCompactions);
  const renderedViews = new Set(priorViews);
  const stackOf = (receipt: PanelReceipt) => panels.find((panel) => panel.panel === receiptPanel(receipt));
  const flush = () => {
    if (work.length) {
      const byCall = new Map<string, PanelReceipt[]>();
      for (const receipt of receipts) byCall.set(receipt.toolCallId, [...(byCall.get(receipt.toolCallId) ?? []), receipt]);
      let failed = 0;
      const approvals: ReactNode[] = [];
      const results: VisibleToolResult[] = [];
      const rows = work.map((entry) => {
        if ("reasoning" in entry) return <ReasoningRow key={entry.id} text={entry.reasoning} preferences={preferences} />;
        const pair = pairs.get(entry.key)!;
        const approval = pendingApprovals.find((pending) => pending.operationId === entry.operationId && pending.callId === entry.callId);
        const badge = statusBadge({ result: pair.result, lifecycle: pair.status, approval: !!approval, started: !!pair.call?.started });
        if (badge.tone === "error") failed++;
        if (approval) approvals.push(<ApprovalCard key={approval.id} approval={approval} call={pair.call} onOpenPanel={onOpenPanel} />);
        if (pair.result) results.push(pair.result);
        // A call that asked you something: its question cards are the only place the questions and answers show. A
        // call may ask several in turn; it waits for you while any of them is pending.
        const questions = interactions.filter((request) => request.identity.toolCallId === entry.callId
          && (!request.identity.operationId || request.identity.operationId === entry.operationId));
        return (
          <ToolRow
            key={entry.key}
            call={pair.call}
            result={pair.result}
            status={pair.status}
            approval={!!approval}
            preferences={preferences}
            previewAbbreviated={pair.abbreviated}
            sessionId={sessionId}
            // Files changed is the header's +a −r pill; other panels get a pill on the row that updated them.
            receipts={(byCall.get(entry.callId) ?? []).filter((receipt) => receipt.owner !== FILES_CHANGED_OWNER).map((receipt) => ({
              receipt, panelTitle: stackOf(receipt)?.title ?? receipt.title, icon: stackOf(receipt)?.icon ?? "panel", onOpen: () => onOpenPanel(receiptPanel(receipt)) }))}
            onOpenCommands={() => onOpenPanel(COMMANDS_ID)}
            waitingForYou={questions.some((request) => request.state === "pending")}
            // History records carry no call id: an ask_user call is recognised by its identity, unless it failed before
            // it asked, when its result is the only explanation.
            argumentsOnly={questions.length > 0 || (pair.call?.identity === "builtin/ask_user" && !pair.result?.failed)}
          />
        );
      });
      // One pill per panel, in the order the group first updated it, showing its latest receipt.
      const latest = new Map<string, PanelReceipt>();
      for (const receipt of receipts) latest.set(receiptPanel(receipt), receipt);
      const pills = [...latest].map(([panel, receipt]): WorkPill => {
        const stack = stackOf(receipt);
        const pill = { key: panel, icon: stack?.icon ?? "panel", error: false, onOpen: () => onOpenPanel(panel) };
        if (receipt.error) return { ...pill, label: receipt.title, name: `${receipt.title}: update rejected`, error: true };
        // This group's own lines, from its diff results; the receipt's summary counts the whole session.
        const totals = receipt.owner === FILES_CHANGED_OWNER ? diffTotals(results) : undefined;
        if (totals)
          return { ...pill, name: `${receipt.title} +${totals.added} −${totals.removed}`,
            label: <><span className="add">+{totals.added}</span> <span className="remove">−{totals.removed}</span></> };
        const title = stack?.title ?? receipt.title;
        const label = receipt.progress && receipt.progress.total > 0 ? `${title} ${receipt.progress.done}/${receipt.progress.total}` : receipt.title;
        return { ...pill, label, name: label };
      });
      const count = rows.length - work.filter((entry) => "reasoning" in entry).length;
      const active = workActive && workLast;
      const elapsed = workLast ? elapsedMs : undefined;
      result.push(
        {
          unit: { ids: workIds, prefix: "work:" },
          render: (key) => (
            <WorkGroup
              key={key}
              count={count}
              failed={failed}
              approval={approvals.length > 0}
              active={active}
              preferences={preferences}
              elapsedMs={elapsed}
              pills={pills}
            >
              {rows}
            </WorkGroup>
          ),
        },
        // A pending approval is a card of its own after the group that holds the call.
        ...approvals,
      );
    }
    work = [];
    workIds = [];
    receipts = [];
    workActive = false;
    elapsedMs = undefined;
    workLast = false;
  };
  records.forEach((item, index) => {
    if (item.id === PENDING_RECORD) {
      flush();
      result.push(pending);
      return;
    }
    if (item.interactionRequestId) {
      flush();
      if (item.interactionViewInstanceId) renderedViews.add(item.interactionViewInstanceId);
      result.push(<InteractionView key={item.interactionRequestId} sessionId={sessionId} requestId={item.interactionRequestId}
        live={interactions.find(request => request.identity.requestId === item.interactionRequestId)} availabilityRevision={availabilityRevision}
        actions={actions} onInsert={onInsert} onOpenPanel={onOpenPanel} />);
      return;
    }
    const identity = item.toolView ?? item.panelReceipt?.view;
    if (identity) {
      if (renderedViews.has(identity.instanceId)) {
        if (item.panelReceipt) {
          flush();
          result.push(<Receipt key={item.id} receipt={item.panelReceipt} icon="panel" openLabel="Show this tool view"
            onOpen={() => document.querySelector(`[data-instance="${CSS.escape(identity.instanceId)}"]`)?.scrollIntoView({ block: "nearest" })} />);
        }
        return;
      }
      renderedViews.add(identity.instanceId);
      flush();
      result.push(<InlineToolView key={identity.instanceId} sessionId={sessionId} identity={identity}
        live={views.find((frame) => frame.view?.instanceId === identity.instanceId)} receipt={item.panelReceipt}
        availabilityRevision={availabilityRevision} actions={actions} onInsert={onInsert} />);
      return;
    }
    if (item.kind === "reasoning" || item.callId) {
      workActive ||= operations.some(
        (op) => op.id === item.operationId && !isTerminal(op.state),
      );
      elapsedMs ??= operations.find((op) => op.id === item.operationId)
        ?.metrics?.elapsedMs;
      workLast ||= !item.operationId || (lastWork.get(item.operationId) === index && !laterWork.includes(item.operationId));
      const key = keys[index]!;
      // A call's live record and its history records have different ids; the call names the group across both.
      workIds.push(item.id, ...(item.callId ? [`call:${key}`] : []));
      if (item.kind === "reasoning") work.push({ reasoning: item.text ?? "", id: item.id });
      else {
        if (renderedTools.has(key)) return;
        renderedTools.add(key);
        work.push({ key, callId: item.callId!, operationId: item.operationId });
      }
      return;
    }
    if (item.panelReceipt) {
      // A call's receipt is a pill of its group; one without a call in the open group (a user action) is a row of its own.
      const receipt = item.panelReceipt;
      if (receipt.source === "tool" && work.some((entry) => "callId" in entry && entry.callId === receipt.toolCallId)) {
        receipts.push(receipt);
        return;
      }
      flush();
      result.push(<Receipt key={item.id} receipt={receipt} icon={stackOf(receipt)?.icon ?? "panel"} onOpen={() => onOpenPanel(receiptPanel(receipt))} />);
      return;
    }
    flush();
    if (item.hook) {
      result.push(<p className="run-status" key={item.id}>
        Hook {item.hook.id} · {item.hook.event} · {item.hook.outcome}
        {item.hook.message ? ` · ${item.hook.message}` : item.hook.code ? ` · ${item.hook.code}` : ""}
      </p>);
      return;
    }
    if (item.compaction) {
      const id = item.compaction.id;
      if (!renderedCompact.has(id)) {
        renderedCompact.add(id);
        result.push(<Compaction key={id} details={compactions.find((details) => details.id === id)!} />);
      }
      return;
    }
    if (item.kind === "run_end") {
      if (item.runResult?.status !== "completed")
        result.push(
          <p className="run-status" key={item.id}>
            {item.runResult?.status === "cancelled"
              ? "Stopped · response may be incomplete"
              : `${item.runResult?.status ?? item.status}${item.runResult?.message ? ` · ${item.runResult.message}` : ""}`}
          </p>,
        );
      return;
    }
    if (item.kind === "user" || item.kind === "assistant")
      result.push(<MessageRow key={item.id} item={item} segment={live.find((entry) => entry.segmentId === item.id)} sessionId={sessionId} />);
    else if (item.text)
      result.push(
        <p className="system-note" key={item.id}>
          {item.text}
        </p>,
      );
  });
  flush();
  const groups = result.filter((entry): entry is { unit: KeyUnit; render: (key: string) => ReactNode } => !!entry && typeof entry === "object" && "unit" in entry);
  const { keys: assigned, next } = assignStableKeys(groups.map((entry) => entry.unit), groupKeys.current);
  useLayoutEffect(() => {
    groupKeys.current = next;
  });
  let group = 0;
  return <>{result.map((entry) => (entry && typeof entry === "object" && "unit" in entry ? entry.render(assigned[group++]!) : entry))}</>;
}, sameTurn);

const noInsert: InsertRef = () => {};

/**
 * The conversation: history and live output, split at your messages into turns, each rendered by a TurnView under a key
 * that survives new records at either end (docs/chat-design.md §10).
 */
export const Timeline = memo(function Timeline({
  state,
  preferences,
  onOpenPanel,
  actions,
  onInsert = noInsert,
  pending,
}: {
  state: ChatState;
  preferences: Preferences;
  onOpenPanel: (panel: string) => void;
  actions?: ActionHost | undefined;
  onInsert?: InsertRef;
  /** Your message before the agent has it, and its operation once there is one (docs/chat-design.md §5). */
  pending?: { operationId: string | undefined; node: ReactNode } | undefined;
}) {
  /** Each record's turn key in the last committed render. */
  const turnKeys = useRef<ReadonlyMap<string, string>>(new Map());
  const records = [...state.history.items];
  for (const segment of state.live)
    if (!records.some((record) => record.id === segment.segmentId))
      records.push({
        id: segment.segmentId,
        kind: segment.kind,
        status: "streaming",
        text: segment.text,
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: Date.now(),
        operationId: segment.operationId,
        ...(segment.turnId ? { turnId: segment.turnId } : {}),
      });
  const pairs = new Map<string, Pair>();
  const scopes = new Map<string, string>();
  let legacyTurn = "legacy:before-page";
  for (const record of records) {
    if (record.kind === "user") legacyTurn = `legacy:${record.id}`;
    scopes.set(record.id, record.operationId ?? record.turnId ?? legacyTurn);
  }
  const keyFor = (record: HistoryView) =>
    `${scopes.get(record.id) ?? record.operationId ?? record.turnId ?? legacyTurn}:${record.callId}`;
  for (const record of records)
    if (record.callId) {
      const item = pairs.get(keyFor(record)) ?? {};
      if (record.toolCall) item.call = record.toolCall;
      if (record.toolResult) {
        item.result = record.toolResult;
        item.abbreviated = record.previewAbbreviated ?? false;
      }
      if (record.toolState) item.status = record.toolState;
      pairs.set(keyFor(record), item);
    }
  for (const tool of Object.values(state.tools)) {
    const key = `${tool.operationId}:${tool.callId}`;
    const old = pairs.get(key) ?? {};
    pairs.set(key, {
      ...old,
      ...(tool.call ? { call: tool.call } : {}),
      ...(tool.result ? { result: tool.result } : {}),
      ...(tool.state ? { status: tool.state } : {}),
    });
    if (!records.some((item) => keyFor(item) === key))
      records.push({
        id: `live:${key}`,
        kind: "tool_call",
        status: "streaming",
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: Date.now(),
        operationId: tool.operationId,
        callId: tool.callId,
      });
  }
  for (const approval of state.approvals) {
    const key = `${approval.operationId}:${approval.callId}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        call: {
          id: approval.callId,
          name: approval.name,
          arguments: approval.arguments,
          started: false,
        },
      });
      records.push({
        id: `approval:${approval.id}`,
        kind: "tool_call",
        status: "pending",
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: approval.createdAt,
        operationId: approval.operationId,
        callId: approval.callId,
      });
    }
  }
  for (const request of state.interactions ?? []) if (!records.some(item => item.interactionRequestId === request.identity.requestId)) {
    records.push({ id: `interaction:${request.identity.requestId}`, kind: "interaction_request", status: request.state,
      sequence: Number.MAX_SAFE_INTEGER, createdAt: request.createdAt, interactionRequestId: request.identity.requestId,
      ...(request.identity.viewInstanceId ? { interactionViewInstanceId: request.identity.viewInstanceId } : {}) });
  }
  for (const frame of Object.values(state.views)) if (frame.view && !records.some(item => item.panelReceipt?.view?.instanceId === frame.view!.instanceId)) {
    records.push({ id: `view:${frame.view.instanceId}`, kind: "tool_view", status: frame.live ? "streaming" : "complete",
      sequence: Number.MAX_SAFE_INTEGER, createdAt: Date.now(), operationId: frame.operationId, toolView: frame.view });
  }
  const compactions = new Map<string, CompactionDetails>();
  for (const item of records)
    if (item.compaction) compactions.set(item.compaction.id, item.compaction);
  for (const item of Object.values(state.compactions))
    if (item.details && !compactions.has(item.details.id)) {
      compactions.set(item.details.id, item.details);
      records.push({
        id: item.details.id,
        kind: "compaction",
        status: item.details.status,
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: Date.now(),
        compaction: item.details,
      });
    }
  if (pending) {
    // The bubble says how the operation ended; its run status would say it again.
    if (pending.operationId) {
      const ended = records.findIndex((item) => item.kind === "run_end" && item.operationId === pending.operationId);
      if (ended >= 0) records.splice(ended, 1);
    }
    // Where the history's bubble will be: after the operation's hook receipts, before its answer.
    const record: HistoryView = { id: PENDING_RECORD, kind: "user", status: "pending", sequence: Number.MAX_SAFE_INTEGER,
      createdAt: Date.now(), ...(pending.operationId ? { operationId: pending.operationId } : {}) };
    const at = pending.operationId ? records.findIndex((item) => item.operationId === pending.operationId && !item.hook) : -1;
    records.splice(at < 0 ? records.length : at, 0, record);
  }
  const availabilityRevision = `${state.snapshotCount}:${state.session.agentName}:${state.operations.filter(op => isTerminal(op.state)).map(op => `${op.id}:${op.state}`).join(",")}`;
  const turns = splitTurns(records);
  const { keys: turnKeyList, next } = assignStableKeys(turns.map((turn) => ({ ids: turn.map((record) => record.id), prefix: "" })), turnKeys.current);
  useLayoutEffect(() => {
    turnKeys.current = next;
  });
  /** What earlier turns rendered: a later record of the same call, view or compaction is not rendered again. */
  const seenTools = new Set<string>();
  const seenViews = new Set<string>();
  const seenCompactions = new Set<string>();
  const views = Object.values(state.views);
  const interactions = state.interactions ?? [];
  // A message delivered while a turn runs splits it; the operation's work after it is its last. Each operation's last
  // turn with work, so a turn is told only about its own operations and a new operation leaves settled turns alone.
  const lastWorkTurn = new Map<string, number>();
  turns.forEach((turn, index) => {
    for (const record of turn) if (record.operationId && isWork(record)) lastWorkTurn.set(record.operationId, index);
  });
  return (
    <>
      {turns.map((turn, index) => {
        const keys = turn.map((record) => (record.callId ? keyFor(record) : ""));
        const priorTools: string[] = [];
        const priorViews: string[] = [];
        const priorCompactions: string[] = [];
        const addViews: string[] = [];
        const addTools: string[] = [];
        const addCompactions: string[] = [];
        const requests = new Set<string>();
        const calls = new Set<string>();
        const operationIds = new Set<string>();
        const viewIds = new Set<string>();
        const segments = new Set<string>();
        const panelIds = new Set<string>();
        turn.forEach((record, at) => {
          segments.add(record.id);
          if (record.interactionRequestId) {
            requests.add(record.interactionRequestId);
            if (record.interactionViewInstanceId) addViews.push(record.interactionViewInstanceId);
            return;
          }
          const identity = record.toolView ?? record.panelReceipt?.view;
          if (record.panelReceipt) panelIds.add(receiptPanel(record.panelReceipt));
          if (identity) {
            viewIds.add(identity.instanceId);
            if (seenViews.has(identity.instanceId)) priorViews.push(identity.instanceId);
            addViews.push(identity.instanceId);
            return;
          }
          if (record.kind === "reasoning" || record.callId) {
            if (record.operationId) operationIds.add(record.operationId);
            if (record.callId) {
              calls.add(record.callId);
              if (seenTools.has(keys[at]!)) priorTools.push(keys[at]!);
              addTools.push(keys[at]!);
            }
            return;
          }
          if (record.compaction && !record.panelReceipt && !record.hook) {
            if (seenCompactions.has(record.compaction.id)) priorCompactions.push(record.compaction.id);
            addCompactions.push(record.compaction.id);
          }
        });
        const laterWork = [...operationIds].filter((operationId) => lastWorkTurn.get(operationId)! > index).sort();
        for (const id of addViews) seenViews.add(id);
        for (const id of addTools) seenTools.add(id);
        for (const id of addCompactions) seenCompactions.add(id);
        const turnPairs = new Map<string, Pair>();
        for (const key of keys) if (key && pairs.has(key)) turnPairs.set(key, pairs.get(key)!);
        const turnInteractions = interactions.filter((request) => requests.has(request.identity.requestId)
          || (request.identity.toolCallId !== undefined && calls.has(request.identity.toolCallId)));
        const interactive = requests.size > 0 || viewIds.size > 0;
        const props: TurnProps = {
          records: turn,
          keys,
          pairs: turnPairs,
          approvals: state.approvals.filter((approval) => calls.has(approval.callId)),
          interactions: turnInteractions.length ? turnInteractions : NONE,
          live: state.live.filter((segment) => segments.has(segment.segmentId)),
          views: viewIds.size ? views.filter((frame) => frame.view && viewIds.has(frame.view.instanceId)) : NONE,
          operations: operationIds.size ? state.operations.filter((op) => operationIds.has(op.id)) : NONE,
          compactions: [...compactions.values()].filter((details) => addCompactions.includes(details.id)),
          // Receipts in the group take their panel's title and icon; tool rows look up the same panels.
          panels: panelIds.size ? state.panels.filter((panel) => panelIds.has(panel.panel)) : NONE,
          priorTools: priorTools.length ? priorTools : NONE,
          priorViews: priorViews.length ? priorViews : NONE,
          priorCompactions: priorCompactions.length ? priorCompactions : NONE,
          sessionId: state.session.id,
          preferences,
          availabilityRevision: interactive ? availabilityRevision : "",
          actions: interactive ? actions : undefined,
          onInsert,
          onOpenPanel,
          pending: pending && segments.has(PENDING_RECORD) ? pending.node : undefined,
          laterWork: laterWork.length ? laterWork : NONE,
        };
        return <TurnView key={turnKeyList[index]} {...props} />;
      })}
    </>
  );
});
