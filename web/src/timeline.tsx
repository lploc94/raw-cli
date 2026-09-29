import { useState, type ReactNode } from "react";
import { Tabs } from "radix-ui";
import {
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleX,
  Terminal,
  ShieldQuestion,
  Brain,
} from "lucide-react";
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
import { HistoryAttachments } from "./composer/HistoryAttachments.js";

export function ApprovalActions({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(`/permissions/${approval.id}`, "POST", {
        operationId: approval.operationId,
        callId: approval.callId,
        allow,
      });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <section className="approval" aria-label="Tool permission">
      <strong>
        <ShieldQuestion size={17} aria-hidden="true" /> Permission needed
      </strong>
      <p>Allow this call once? This does not change your rules.</p>
      <CodeBlock
        code={JSON.stringify(approval.arguments, null, 2)}
        language="json"
      />
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            void answer(true);
          }}
        >
          Allow once
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void answer(false);
          }}
        >
          Deny
        </button>
      </div>
      <small className="muted">
        Expires {new Date(approval.deadline).toLocaleTimeString()}
      </small>
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}
function ToolCard({
  call,
  result,
  status,
  approval,
  preferences,
  previewAbbreviated,
}: {
  call?: VisibleToolCall | undefined;
  result?: VisibleToolResult | undefined;
  status?: string | undefined;
  approval?: Approval | undefined;
  preferences: Preferences;
  previewAbbreviated?: boolean | undefined;
}) {
  const failed =
    result?.failed ||
    ["denied", "outcome_unknown", "cancelled"].includes(status ?? "");
  const labels: Record<string, string> = {
    requested: "Requested",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    denied: "Denied",
    cancelled: "Cancelled",
    outcome_unknown: "Outcome unknown",
  };
  const state = approval
    ? "Needs approval"
    : result
      ? (labels[status ?? ""] ?? (result.failed ? "Failed" : "Succeeded"))
      : (labels[status ?? ""] ?? (call?.started ? "Running" : "Requested"));
  const Icon = approval
    ? ShieldQuestion
    : failed
      ? CircleX
      : result
        ? CheckCircle2
        : CircleDashed;
  const name = call?.name ?? result?.name ?? "Historical tool";
  const args = call?.arguments;
  const commands = args?.commands;
  const description = Array.isArray(commands)
    ? commands.map((item: { command?: string }) => item.command).join("; ")
    : (call?.identity ?? result?.identity ?? "Details");
  return (
    <details
      className={`tool-card ${failed ? "failed" : ""}`}
      open={preferences.toolDetails || !!approval || failed || undefined}
    >
      <summary>
        <Terminal size={16} aria-hidden="true" />
        <strong>{name}</strong>
        <span className="tool-summary">{description}</span>
        <span className="tool-status">
          <Icon size={14} aria-hidden="true" />
          {state}
        </span>
      </summary>
      <div className="tool-content">
        <Tabs.Root defaultValue={result ? "result" : "arguments"}>
          <Tabs.List aria-label={`${name} details`} className="tabs">
            <Tabs.Trigger value="arguments">Arguments</Tabs.Trigger>
            <Tabs.Trigger value="result">Result</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="arguments">
            {args ? (
              <CodeBlock code={JSON.stringify(args, null, 2)} language="json" />
            ) : (
              <p className="muted">
                Arguments are unavailable in this history record.
              </p>
            )}
          </Tabs.Content>
          <Tabs.Content value="result">
            {result ? (
              <>
                <div className="metadata">
                  {result.code && <span>{result.code}</span>}
                  {result.durationMs !== undefined && (
                    <span>{result.durationMs} ms</span>
                  )}
                  {result.exitCode !== undefined && (
                    <span>Exit {result.exitCode ?? "unavailable"}</span>
                  )}
                </div>
                {result.rows.length > 0 && (
                  <div className="batch-rows">
                    {result.rows.map((row) => (
                      <div key={row.index}>
                        <span>#{row.index}</span>
                        <span>{row.path}</span>
                        <strong>{row.status}</strong>
                        {row.exitCode !== undefined && (
                          <span>Exit {row.exitCode}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <CodeBlock
                  code={result.segments
                    .map((segment) => segment.text)
                    .join("\n")}
                  language={
                    result.segments.every((segment) => segment.kind === "json")
                      ? "json"
                      : "text"
                  }
                />
                <p className="muted small">
                  Saved preview
                  {previewAbbreviated ? " · Display abbreviated" : ""}
                  {result.truncated ? " · Tool truncated its output" : ""}. Full
                  historical output, image bytes and write diffs may be
                  unavailable.
                </p>
              </>
            ) : (
              <p className="muted">
                Waiting for the result. Shell output appears when the tool
                finishes.
              </p>
            )}
          </Tabs.Content>
        </Tabs.Root>
        {approval && <ApprovalActions approval={approval} />}
      </div>
    </details>
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
function WorkGroup({
  children,
  count,
  active,
  error,
  preferences,
  elapsedMs,
}: {
  children: ReactNode;
  count: number;
  active: boolean;
  error: boolean;
  preferences: Preferences;
  elapsedMs?: number | undefined;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? (active || error || preferences.reasoning);
  return (
    <details
      className="work-group"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open)
          setExpanded(event.currentTarget.open);
      }}
    >
      <summary>
        <ChevronRight className="chevron" size={16} aria-hidden="true" />
        <span>Work</span>
        <span className="muted">
          {count ? `${count} ${count === 1 ? "tool" : "tools"}` : "Reasoning"}
          {active
            ? " · Working"
            : elapsedMs !== undefined
              ? ` · ${(elapsedMs / 1000).toFixed(1)}s`
              : ""}
          {error ? " · Needs review" : ""}
        </span>
      </summary>
      <div className="work-content">{children}</div>
    </details>
  );
}
export function Timeline({
  state,
  preferences,
}: {
  state: ChatState;
  preferences: Preferences;
}) {
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
  const pairs = new Map<
    string,
    {
      call?: VisibleToolCall;
      result?: VisibleToolResult;
      status?: string;
      abbreviated?: boolean;
    }
  >();
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
  const result: ReactNode[] = [];
  let work: ReactNode[] = [];
  let count = 0;
  let workId = "";
  let workError = false;
  let workActive = false;
  let elapsedMs: number | undefined;
  const renderedTools = new Set<string>();
  const renderedCompact = new Set<string>();
  const flush = () => {
    if (work.length)
      result.push(
        <WorkGroup
          key={`work:${workId}`}
          count={count}
          active={workActive}
          error={workError}
          preferences={preferences}
          elapsedMs={elapsedMs}
        >
          {work}
        </WorkGroup>,
      );
    work = [];
    count = 0;
    workError = false;
    workActive = false;
    elapsedMs = undefined;
  };
  for (const item of records) {
    if (item.kind === "reasoning" || item.callId) {
      if (!work.length) workId = item.id;
      workActive ||= state.operations.some(
        (op) => op.id === item.operationId && !isTerminal(op.state),
      );
      elapsedMs ??= state.operations.find((op) => op.id === item.operationId)
        ?.metrics?.elapsedMs;
      if (item.kind === "reasoning")
        work.push(
          <div className="reasoning" key={item.id}>
            <span className="eyebrow">Reasoning</span>
            <Markdown>{item.text ?? ""}</Markdown>
          </div>,
        );
      else {
        const key = keyFor(item);
        if (renderedTools.has(key)) continue;
        renderedTools.add(key);
        count++;
        const pair = pairs.get(key)!;
        const approval = state.approvals.find(
          (pending) =>
            pending.operationId === item.operationId &&
            pending.callId === item.callId,
        );
        workError ||= !!pair.result?.failed || !!approval;
        work.push(
          <ToolCard
            key={key}
            call={pair.call}
            result={pair.result}
            status={pair.status}
            approval={approval}
            preferences={preferences}
            previewAbbreviated={pair.abbreviated}
          />,
        );
      }
      continue;
    }
    flush();
    if (item.hook) {
      result.push(<p className="run-status" key={item.id}>
        Hook {item.hook.id} · {item.hook.event} · {item.hook.outcome}
        {item.hook.message ? ` · ${item.hook.message}` : item.hook.code ? ` · ${item.hook.code}` : ""}
      </p>);
      continue;
    }
    if (item.compaction) {
      const id = item.compaction.id;
      if (!renderedCompact.has(id)) {
        renderedCompact.add(id);
        result.push(<Compaction key={id} details={compactions.get(id)!} />);
      }
      continue;
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
      continue;
    }
    if (item.kind === "user" || item.kind === "assistant") {
      const segment = state.live.find((entry) => entry.segmentId === item.id);
      result.push(
        <article
          className={`message ${item.kind}`}
          key={item.id}
          data-testid={
            item.kind === "user" ? "user-message" : "assistant-message"
          }
        >
          <div className="message-label">
            <strong>{item.kind === "user" ? "You" : "Raw"}</strong>
            <time dateTime={new Date(item.createdAt).toISOString()}>
              {new Date(item.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <CopyButton value={item.text ?? ""} label="Copy message" />
          </div>
          {segment?.paged ? (
            <PagedLive segment={segment} sessionId={state.session.id} />
          ) : item.kind === "assistant" ? (
            <Markdown>{item.text ?? ""}</Markdown>
          ) : (
            <>
              <div className="user-text">{item.text}</div>
              {item.attachments?.length ? (
                <HistoryAttachments
                  items={item.attachments}
                  sessionId={state.session.id}
                  sequence={item.sequence}
                />
              ) : null}
            </>
          )}
          {item.status === "interrupted" && (
            <small className="warning">Incomplete response</small>
          )}
        </article>,
      );
    } else if (item.text)
      result.push(
        <p className="system-note" key={item.id}>
          {item.text}
        </p>,
      );
  }
  flush();
  return <>{result}</>;
}
