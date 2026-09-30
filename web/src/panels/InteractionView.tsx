import { useEffect, useState } from "react";
import type { InteractionRequest, InteractionRequestView } from "../../../src/interactions/contract.js";
import type { FormAnswers } from "../../../src/panels/contract.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";
import { api, errorText } from "../api.js";
import { ToolView } from "./ToolView.js";
import type { ActionHost } from "./actions.js";
import type { InsertRef } from "./status.js";

/** A durable question survives independently of its ordinary provisional tool view. */
export function InteractionView({ sessionId, requestId, live, availabilityRevision, actions, onInsert, onOpenPanel }: {
  sessionId: string; requestId: string; live?: InteractionRequest | undefined; actions?: ActionHost | undefined;
  availabilityRevision: string; onInsert: InsertRef; onOpenPanel: (panel: string) => void;
}) {
  const [stored, setStored] = useState<InteractionRequestView>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (live?.state === "pending") return;
    let active = true;
    void api<InteractionRequestView>(`/sessions/${sessionId}/interactions/${encodeURIComponent(requestId)}`)
      .then(value => { if (active) setStored(value); }, cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [sessionId, requestId, live?.state, availabilityRevision]);
  const request = live?.state === "pending" ? live : stored ?? live;
  if (!request) return <p className={error ? "error small" : "muted small"}>{error || "Loading question…"}</p>;
  const panel = `${request.identity.owner}#${request.identity.panelId}`;
  if (request.declaration.placement !== "chat") {
    const answers = request.canonicalResult ? (JSON.parse(request.canonicalResult) as { answers?: FormAnswers }).answers : undefined;
    return <div className="interaction-receipt" data-request={requestId}>
      <span>{request.declaration.title} · {request.state === "pending" ? "Waiting for your answer" : request.state}</span>
      <button type="button" onClick={() => onOpenPanel(panel)}>{request.state === "pending" ? "Open question" : "Open panel"}</button>
      {answers && <dl>{request.form.fields.filter(field => Object.hasOwn(answers, field.id)).map(field => <div key={field.id}>
        <dt>{field.label}</dt><dd>{Array.isArray(answers[field.id]) ? (answers[field.id] as string[]).join(", ") : answers[field.id]}</dd>
      </div>)}</dl>}
    </div>;
  }
  const item: PanelStackItem = { panel, owner: request.identity.owner,
    ...(request.identity.viewInstanceId ? { instanceId: request.identity.viewInstanceId } : {}),
    title: request.declaration.title, icon: request.declaration.icon, revision: request.revision,
    updatedAt: request.createdAt, closed: request.state !== "pending", stale: request === stored ? stored.presentation.stale : false,
    declaration: request === stored ? stored.presentation.declaration : request.declaration, document: request.document, interaction: request };
  return <section className="inline-tool-view" data-request={requestId} data-instance={request.identity.viewInstanceId} aria-label={item.title}>
    <ToolView item={item} onInsert={onInsert} hideCompleted={false} onHideCompleted={() => {}} actions={actions} />
  </section>;
}
