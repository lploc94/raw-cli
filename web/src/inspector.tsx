import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import type { DashboardBootstrap } from "../../src/dashboard/contract.js";
import type { UsageSummary } from "../../src/llm/cache.js";
import type { ChatState } from "./session.js";
import type { Preferences } from "./preferences.js";
import { CopyButton } from "./ui.js";

const resume = (id: string) => `raw --resume ${id} "Your next message"`;
function Usage({ name, value }: { name: string; value: UsageSummary }) {
  return (
    <section>
      <h3>{name}</h3>
      <dl className="stats">
        <dt>Requests</dt>
        <dd>{value.requests}</dd>
        <dt>Input tokens</dt>
        <dd>
          {value.inputCoverage
            ? value.inputTokensKnown.toLocaleString()
            : "Unavailable"}
        </dd>
        <dt>Output tokens</dt>
        <dd>
          {value.outputCoverage
            ? value.outputTokensKnown.toLocaleString()
            : "Unavailable"}
        </dd>
        <dt>Cache read</dt>
        <dd>
          {value.cacheReadCoverage
            ? value.cacheReadTokensKnown.toLocaleString()
            : "Unavailable"}
        </dd>
        <dt>Cache write</dt>
        <dd>
          {value.cacheWriteCoverage
            ? value.cacheWriteTokensKnown.toLocaleString()
            : "Unavailable"}
        </dd>
        <dt>Cache read coverage</dt>
        <dd>
          {value.cacheReadCoverage}/{value.requests} requests
        </dd>
        <dt>Cache read share</dt>
        <dd>
          {value.cacheReadRatio === undefined
            ? "Unavailable"
            : `${(value.cacheReadRatio * 100).toFixed(1)}% (${value.cacheRatioCoverage}/${value.requests} requests)`}
        </dd>
        <dt>Uncached input (derived)</dt>
        <dd>
          {value.requests > 0 &&
          value.inputCoverage === value.requests &&
          value.cacheReadCoverage === value.requests
            ? Math.max(
                0,
                value.inputTokensKnown - value.cacheReadTokensKnown,
              ).toLocaleString()
            : "Unavailable"}
        </dd>
      </dl>
    </section>
  );
}
export function Inspector({
  id,
  state,
  bootstrap,
  preferences,
  narrow,
  resizeInspector,
}: {
  id: string;
  state: ChatState | undefined;
  bootstrap: DashboardBootstrap;
  preferences: Preferences;
  narrow: boolean;
  resizeInspector: (width: number) => void;
}) {
  const metrics = state?.metrics;
  const context = metrics?.context;
  return (
    <>
      <Dialog.Overlay className="inspector-shade" />
      <Dialog.Content
        asChild
        role={narrow ? "dialog" : "complementary"}
        onInteractOutside={(event) => {
          if (!narrow) event.preventDefault();
        }}
      >
        <aside className="inspector" aria-label="Session context and usage">
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
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                resizeInspector(
                  Math.max(300, Math.min(360, innerWidth - event.clientX)),
                );
            }}
            onDoubleClick={() => resizeInspector(320)}
          />
          <div className="section-heading">
            <Dialog.Title asChild>
              <h2>Context</h2>
            </Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close details">
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted small">
            History shows what happened. Model context contains the current
            summary and retained messages.
          </Dialog.Description>
          <dl className="stats">
            <dt>Estimated tokens</dt>
            <dd>
              {context
                ? `~${context.estimatedTokens.toLocaleString()}`
                : "Unavailable"}
            </dd>
            <dt>Context window</dt>
            <dd>{context?.contextWindow?.toLocaleString() ?? "Unavailable"}</dd>
            <dt>Input budget</dt>
            <dd>{context?.inputBudget?.toLocaleString() ?? "Unavailable"}</dd>
            <dt>Output reserve</dt>
            <dd>{context?.outputReserve?.toLocaleString() ?? "Unavailable"}</dd>
            <dt>Auto compact trigger</dt>
            <dd>
              {context?.compactTrigger?.toLocaleString() ?? "Not configured"}
            </dd>
            <dt>Retained messages</dt>
            <dd>{state?.context.messageCount ?? "Unavailable"}</dd>
          </dl>
          {metrics && (
            <p className="muted small">
              Measured {new Date(metrics.measuredAt).toLocaleString()}
              {state?.metricsStale ? " · earlier context" : ""}
            </p>
          )}
          {state?.context.summary ? (
            <details>
              <summary>Current summary</summary>
              <div className="summary-text">{state.context.summary}</div>
              <CopyButton value={state.context.summary} label="Copy summary" />
            </details>
          ) : (
            <p className="muted small">No stored summary.</p>
          )}
          {metrics && (
            <>
              <Usage name="Last turn" value={metrics.turn} />
              <Usage name="Session totals" value={metrics.session} />
            </>
          )}
          <h3>Last attached capabilities</h3>
          {metrics?.capabilities ? (
            <dl className="path-list">
              {(["tools", "skills", "vars"] as const).map((kind) => (
                <div key={kind}>
                  <dt>
                    {kind === "vars"
                      ? "Variables"
                      : kind[0]!.toUpperCase() + kind.slice(1)}
                  </dt>
                  <dd>
                    {metrics.capabilities![kind].length
                      ? metrics.capabilities![kind].join(", ")
                      : "None selected"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted small">
              Available after the next dashboard run.
            </p>
          )}
          <p className="muted small">
            Agent edits apply to the next turn. Variable values are not part of
            this list.
          </p>
          <h3>Session</h3>
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
            <dd>
              {metrics?.model ?? state?.session.modelId ?? "Not measured"}
            </dd>
          </dl>
          <div className="resume-command">
            <code>{resume(id)}</code>
            <CopyButton value={resume(id)} label="Copy resume command" />
          </div>
        </aside>
      </Dialog.Content>
    </>
  );
}
