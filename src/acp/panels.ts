import type { PanelDeclaration, PanelDocument, StoredPanel, ToolViewIdentity } from "../panels/contract.js";
import { planEntries } from "../panels/render.js";

/** One outgoing ACP notification about a panel (docs/panels-design.md §13.3). */
export interface PanelNotification { method: "session/update" | "_raw/panel/update"; params: Record<string, unknown> }

export interface PanelState { panel: string; owner: string; revision: number; closed: boolean; declaration: PanelDeclaration; document: PanelDocument; view?: ToolViewIdentity }

/**
 * The messages for one committed panel state: the standard `plan` when the panel is declared with `acp_plan` (a closed panel
 * sends an empty plan, so the client's list is cleared), and `_raw/panel/update` only when the client negotiated it.
 */
export function panelNotifications(sessionId: string, state: PanelState, rawNegotiated: boolean): PanelNotification[] {
  const messages: PanelNotification[] = [];
  if (state.declaration.acp_plan) {
    messages.push({ method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: state.closed ? [] : planEntries(state.document) } } });
  }
  if (rawNegotiated) {
    messages.push({ method: "_raw/panel/update", params: { sessionId, panel: state.panel, owner: state.owner, revision: state.revision,
      closed: state.closed, declaration: state.declaration, document: state.document, ...(state.view ? { view: state.view } : {}) } });
  }
  return messages;
}

/** The current state of every open panel, sent once after `session/load` and `session/resume`; history is not reconstructed (D1). */
export const currentPanelNotifications = (sessionId: string, stored: readonly StoredPanel[], rawNegotiated: boolean): PanelNotification[] =>
  stored.filter((panel) => !panel.closed).flatMap((panel) =>
    panelNotifications(sessionId, { panel: panel.panelId, owner: panel.owner, revision: panel.revision, closed: false, declaration: panel.declaration, document: panel.document }, rawNegotiated));
