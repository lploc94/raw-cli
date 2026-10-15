import { useRef } from "react";
import { Dialog } from "radix-ui";
import { Info, X } from "lucide-react";
import type { DashboardBootstrap } from "../../src/dashboard/contract.js";
import type { UsageSummary } from "../../src/llm/cache.js";
import type { ChatState } from "./session.js";
import type { Preferences } from "./preferences.js";
import { CopyButton } from "./ui.js";
import { SidePanel, type SidePanelProps } from "./panels/SidePanel.js";
import { compactTokens, reportsTokens, summarizeContext } from "./panels/summaries.js";
import { contextUsage } from "./composer/context-usage.js";

const resume = (id: string) => `raw --resume ${id} "Your next message"`;
const count = (value: number) => value.toLocaleString();
const requests = (value: number) => `${count(value)} ${value === 1 ? "request" : "requests"}`;
const percent = (value: number | undefined) => (value === undefined ? undefined : `${(value * 100).toFixed(1)}%`);
/** The cache read share and how many requests it covers: "50.0% (1 of 2)". */
const share = (value: UsageSummary) => (value.cacheReadRatio === undefined ? undefined : `${percent(value.cacheReadRatio)} (${value.cacheRatioCoverage} of ${value.requests})`);
/** A measure of the last turn and the session, written as one value: "1,000 · 1,200 in session". */
const both = (turn: string | undefined, session: string | undefined) => (turn ?? session) === undefined ? undefined : `${turn ?? "—"} · ${session ?? "—"} in session`;
const uncached = (value: UsageSummary) => (value.requests > 0 && value.inputCoverage === value.requests && value.cacheReadCoverage === value.requests
  ? count(Math.max(0, value.inputTokensKnown - value.cacheReadTokensKnown)) : undefined);
/** Usage as key/value rows (details.png): each scope's requests and reported tokens, then the cache; a row only for what was reported. */
function UsageCard({ turn, session }: { turn: UsageSummary; session: UsageSummary }) {
  const scope = (value: UsageSummary) => [requests(value.requests), value.inputCoverage ? `${count(value.inputTokensKnown)} in` : undefined,
    value.outputCoverage ? `${count(value.outputTokensKnown)} out` : undefined].filter(Boolean).join(" · ");
  const cache = (value: UsageSummary) => `${value.cacheReadCoverage} of ${value.requests}${value.cacheReadCoverage ? ` · ${count(value.cacheReadTokensKnown)} tokens` : ""}`;
  const rows: Array<[string, string | undefined]> = [
    ["Last turn", scope(turn)],
    ["This session", scope(session)],
    ["Cache reads", cache(turn)],
    ["Session cache reads", session.cacheReadCoverage ? cache(session) : undefined],
    ["Cache writes", both(turn.cacheWriteCoverage ? count(turn.cacheWriteTokensKnown) : undefined, session.cacheWriteCoverage ? count(session.cacheWriteTokensKnown) : undefined)],
    ["Cache read share", both(share(turn), share(session))],
    ["Uncached input", both(uncached(turn), uncached(session))],
  ];
  const reported = [turn, session].some(reportsTokens);
  return (
    <section className="sp-card details-card" data-card="usage" aria-labelledby="details-usage">
      <h3 className="details-label" id="details-usage">Usage</h3>
      <dl className="details-kv">
        {rows.filter(([, value]) => value !== undefined).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
      </dl>
      {!reported && <p className="details-note"><Info size={12} aria-hidden="true" />This provider does not report token counts.</p>}
    </section>
  );
}
/** Details (docs/side-panel-design.md §7): the context first, then usage, the summary, the resume command and the session. */
function Details({
  id,
  state,
  bootstrap,
  compact,
}: {
  id: string;
  state: ChatState | undefined;
  bootstrap: DashboardBootstrap;
  compact?: CompactAction | undefined;
}) {
  const metrics = state?.metrics;
  const context = metrics?.context;
  const use = summarizeContext(context);
  const usage = contextUsage(context);
  const messages = state?.context.messageCount;
  const summary = state?.context.summary;
  const line = [
    messages === undefined ? undefined : `${messages} ${messages === 1 ? "message" : "messages"} kept`,
    summary ? "summary stored" : "no summary yet",
    context?.compactTrigger ? `auto compact at ${compactTokens(context.compactTrigger)}` : "auto compact off",
  ].filter(Boolean).join(" · ");
  const limits: Array<[string, number | undefined]> = [["Context window", context?.contextWindow], ["Input budget", context?.inputBudget], ["Output reserve", context?.outputReserve], ["Auto compact at", context?.compactTrigger || undefined]];
  return (
    <div className="details">
      <section className="sp-card details-card" data-card="context" aria-labelledby="details-context">
        <div className="details-card-head">
          <h3 className="details-label" id="details-context">Context</h3>
          {use?.chips[0] && <span className={`sp-chip tone-${use.chips[0].tone}`}>{use.chips[0].text}</span>}
        </div>
        {context ? (
          <div className="details-meter">
            <span className="details-big">{`${context.source === "provider" ? "" : "~"}${compactTokens(context.estimatedTokens)}`}</span>
            <span className="details-of">{usage ? `/ ${compactTokens(usage.limit)} tokens` : "tokens"}</span>
          </div>
        ) : <p className="details-note">Measured after the first turn.</p>}
        {use?.progress && <span className="sp-bar" aria-hidden="true"><i className={`tone-${use.progress.tone}`} style={{ width: `${use.progress.value * 100}%` }} /></span>}
        <p className="details-line">{line}</p>
        {compact && (
          <div className="details-actions">
            <button type="button" className="command-action" disabled={compact.disabled} title="Summarize model context while keeping visible history" onClick={compact.run}>Compact now</button>
          </div>
        )}
      </section>
      {metrics && <UsageCard turn={metrics.turn} session={metrics.session} />}
      {summary && (
        <section className="sp-card details-card" data-card="summary" aria-labelledby="details-summary">
          <h3 className="details-label" id="details-summary">Summary</h3>
          <details>
            <summary>Current summary</summary>
            <div className="summary-text">{summary}</div>
            <CopyButton value={summary} label="Copy summary" />
          </details>
        </section>
      )}
      <section className="sp-card details-card" data-card="resume" aria-labelledby="details-resume">
        <h3 className="details-label" id="details-resume">Continue in terminal</h3>
        <div className="resume-command">
          <code title={resume(id)}>{resume(id)}</code>
          <CopyButton value={resume(id)} label="Copy resume command" />
        </div>
      </section>
      <section className="sp-card details-card" data-card="limits" aria-labelledby="details-limits">
        <h3 className="details-label" id="details-limits">Context limits</h3>
        {context ? (
          <dl className="details-kv">
            {limits.filter(([, value]) => value !== undefined).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{count(value!)}</dd></div>)}
            <div><dt>{context.source === "provider" ? "Context tokens" : "Estimated tokens"}</dt><dd>{count(context.estimatedTokens)}</dd></div>
          </dl>
        ) : <p className="details-note">Measured after the first turn.</p>}
        <p className="details-hint">
          History shows what happened. Model context contains the current summary and retained messages.
          {metrics && <> Measured {new Date(metrics.measuredAt).toLocaleString()}{state?.metricsStale ? " · earlier context" : ""}.</>}
        </p>
      </section>
      <section className="sp-card details-card" data-card="capabilities" aria-labelledby="details-capabilities">
        <h3 className="details-label" id="details-capabilities">Last attached capabilities</h3>
        {metrics?.capabilities ? (
          <dl className="path-list">
            {(["tools", "skills", "vars"] as const).map((kind) => (
              <div key={kind}>
                <dt>{kind === "vars" ? "Variables" : kind[0]!.toUpperCase() + kind.slice(1)}</dt>
                <dd>{metrics.capabilities![kind].length ? metrics.capabilities![kind].join(", ") : "None selected"}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="details-note">Available after the next dashboard run.</p>}
        <p className="details-hint">Agent edits apply to the next turn. Variable values are not part of this list.</p>
      </section>
      <section className="sp-card details-card" data-card="session" aria-labelledby="details-session">
        <h3 className="details-label" id="details-session">Session</h3>
        <dl className="path-list">
          <dt>ID</dt>
          <dd>{id}</dd>
          <dt>Workspace</dt>
          <dd>{state?.session.cwd}</dd>
          <dt>Config for next turn</dt>
          <dd>{bootstrap.configPath}</dd>
          {state?.session.configPath !== bootstrap.configPath && (
            <>
              <dt>Previously saved config</dt>
              <dd>{state?.session.configPath}</dd>
            </>
          )}
          <dt>Model</dt>
          <dd>{metrics?.model ?? state?.session.modelId ?? "Not measured"}</dd>
        </dl>
      </section>
    </div>
  );
}
/** The composer's Compact now, offered next to the context use. */
export interface CompactAction { run: () => void; disabled: boolean }
export function Inspector({
  id,
  state,
  bootstrap,
  preferences,
  narrow,
  resizeInspector,
  keepFocus,
  stack,
  compact,
}: {
  id: string;
  state: ChatState | undefined;
  bootstrap: DashboardBootstrap;
  preferences: Preferences;
  narrow: boolean;
  resizeInspector: (width: number) => void;
  keepFocus: { current: boolean };
  stack: Omit<SidePanelProps, "details" | "sessionId" | "context" | "heading" | "close">;
  compact?: CompactAction | undefined;
}) {
  // Where a drag started: the width follows the pointer's movement, wherever the handle sits in the gap.
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <>
      <Dialog.Overlay className="inspector-shade" />
      <Dialog.Content
        asChild
        role={narrow ? "dialog" : "complementary"}
        onOpenAutoFocus={(event) => {
          if (!keepFocus.current) return;
          keepFocus.current = false;
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!narrow) event.preventDefault();
        }}
      >
        <aside className="inspector" aria-label="Side panel">
          <div
            className="inspector-resize"
            role="separator"
            tabIndex={0}
            aria-label="Inspector width"
            aria-orientation="vertical"
            aria-valuemin={300}
            aria-valuemax={360}
            aria-valuenow={preferences.inspectorWidth}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
                event.preventDefault();
                resizeInspector(
                  event.key === "Home"
                    ? 320
                    : Math.max(
                        300,
                        Math.min(
                          360,
                          preferences.inspectorWidth +
                            (event.key === "ArrowLeft" ? 10 : -10),
                        ),
                      ),
                );
              }
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              // The rendered width: a narrow window can clip the preferred one.
              const panel = event.currentTarget.closest(".inspector");
              drag.current = { x: event.clientX, width: panel?.getBoundingClientRect().width ?? preferences.inspectorWidth };
            }}
            onPointerMove={(event) => {
              if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId))
                resizeInspector(
                  Math.max(300, Math.min(360, drag.current.width - (event.clientX - drag.current.x))),
                );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onDoubleClick={() => resizeInspector(320)}
          />
          <Dialog.Description className="sr-only">
            Tool panels and session details for this chat.
          </Dialog.Description>
          <SidePanel
            {...stack}
            context={state?.metrics?.context}
            commands={state?.commands ?? []}
            commandsOmitted={state?.commandsOmitted}
            approvals={state?.approvals ?? []}
            sessionCwd={state?.session.cwd}
            sessionId={id}
            details={<Details id={id} state={state} bootstrap={bootstrap} compact={compact} />}
            heading={<Dialog.Title asChild><h2>Side panel</h2></Dialog.Title>}
            close={<Dialog.Close className="icon-button sp-close" aria-label="Close side panel"><X size={16} aria-hidden="true" /></Dialog.Close>}
          />
        </aside>
      </Dialog.Content>
    </>
  );
}
