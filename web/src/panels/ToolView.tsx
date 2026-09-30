import { useEffect, useState, type ReactNode } from "react";
import type { PanelStackItem, ToolViewSnapshot } from "../../../src/panels/stack.js";
import type { PanelReceipt, ToolViewIdentity } from "../../../src/panels/contract.js";
import type { DashboardEventData } from "../../../src/dashboard/streams.js";
import { api, errorText } from "../api.js";
import { ActionScope, ActionMenu, offeredActions, type ActionHost } from "./actions.js";
import { Blocks } from "./Blocks.js";
import type { InsertRef } from "./status.js";

/** The same document/action presentation at either destination. */
export function ToolView({ item, onInsert, hideCompleted, onHideCompleted, actions, children }: {
  item: PanelStackItem; onInsert: InsertRef; hideCompleted: boolean; onHideCompleted: (value: boolean) => void;
  actions?: ActionHost | undefined; children?: ReactNode;
}) {
  return <ActionScope value={actions && { item, host: actions }}>
    {item.stale && <p className="panel-banner" role="note">The tool that owns this panel is not selected by this agent.</p>}
    {children}
    {item.document ? <Blocks document={item.document} onInsert={onInsert} hideCompleted={hideCompleted} onHideCompleted={onHideCompleted} /> : <p className="muted small">No data yet.</p>}
  </ActionScope>;
}

export function InlineToolView({ sessionId, identity, live, receipt, availabilityRevision, actions, onInsert }: {
  sessionId: string; identity: ToolViewIdentity; live?: DashboardEventData["panel"] | undefined;
  receipt?: PanelReceipt | undefined; availabilityRevision: string;
  actions?: ActionHost | undefined; onInsert: InsertRef;
}) {
  const [stored, setStored] = useState<ToolViewSnapshot>();
  const [error, setError] = useState("");
  const [hideCompleted, setHideCompleted] = useState(false);
  useEffect(() => {
    if (live) return;
    let active = true;
    void api<ToolViewSnapshot>(`/sessions/${sessionId}/views/${encodeURIComponent(identity.instanceId)}`)
      .then(view => { if (active) { setStored(view); setError(""); } }, cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [sessionId, identity.instanceId, !!live, availabilityRevision]);
  const declaration = live?.declaration ?? stored?.presentation.declaration;
  const document = live?.document ?? stored?.document;
  const item: PanelStackItem | undefined = declaration && document ? {
    panel: `${identity.owner}#${identity.panelId}`, owner: identity.owner, instanceId: identity.instanceId,
    title: declaration.title, icon: declaration.icon, revision: live?.revision ?? stored!.revision,
    updatedAt: stored?.updatedAt ?? null, closed: live?.closed ?? stored!.closed, stale: stored?.presentation.stale ?? false, declaration, document,
  } : undefined;
  return <section className="inline-tool-view" data-instance={identity.instanceId} aria-label={declaration?.title ?? "Tool view"}>
    {item ? <>
      <div className="panel-block-header"><h4>{item.title}</h4>{receipt?.source === "user_action" && <small className="panel-tag">You</small>}
        {actions && <ActionMenu offered={offeredActions(item, actions, "panel")} label={`Actions for ${item.title}`} />}</div>
      <ToolView item={item} onInsert={onInsert} hideCompleted={hideCompleted} onHideCompleted={setHideCompleted} actions={actions} />
    </> : <p className={error ? "error small" : "muted small"}>{error || "Loading tool view…"}</p>}
  </section>;
}
