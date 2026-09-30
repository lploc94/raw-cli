import type { InteractionRequest } from "../../../src/interactions/contract.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";

/** Sidebar follows the latest question; an inline historical card keeps its exact request. */
export function formRequest(item: PanelStackItem | undefined, requests: readonly InteractionRequest[], blockId: string): InteractionRequest | undefined {
  if (!item) return undefined;
  const bound = item.interaction?.formBlockId === blockId ? item.interaction : undefined;
  let selected = bound;
  for (const request of requests) {
    if (request.formBlockId !== blockId || request.identity.owner !== item.owner || request.identity.panelId !== item.declaration.id) continue;
    if (item.instanceId) {
      if (bound ? request.identity.requestId !== bound.identity.requestId : request.identity.viewInstanceId !== item.instanceId) continue;
    } else if (request.declaration.placement === "chat") continue;
    if (selected?.identity.requestId === request.identity.requestId) {
      if (request.revision > selected.revision || (request.revision === selected.revision && request.canonicalResult)) selected = request;
    } else if (!selected || request.createdAt >= selected.createdAt) selected = request;
  }
  return selected;
}

/** Render a durable question independently of ordinary provisional/committed sidebar state. */
export function sidebarPresentation(item: PanelStackItem, requests: readonly InteractionRequest[]): PanelStackItem {
  if (item.instanceId || item.declaration.placement === "chat") return item;
  let latest = item.interaction;
  for (const request of requests) {
    if (request.declaration.placement === "chat" || request.identity.owner !== item.owner || request.identity.panelId !== item.declaration.id) continue;
    if (latest?.identity.requestId === request.identity.requestId) {
      if (request.revision > latest.revision || (request.revision === latest.revision && request.canonicalResult)) latest = request;
    } else if (!latest || request.createdAt >= latest.createdAt) latest = request;
  }
  return latest && (latest.state === "pending" || !item.document) ? { ...item, document: latest.document, interaction: latest } : item;
}
