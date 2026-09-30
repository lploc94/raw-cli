import { createContext, useContext, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import type { PanelAction, PanelActionScope, PanelItemStatus } from "../../../src/panels/contract.js";
import { resolveAction, type ActionRequest } from "../../../src/panels/actions.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";

/** What the chat page offers the panel stack for running actions (docs/panels-design.md §11). */
export interface ActionHost {
  /** Why tool actions cannot run right now (busy, unsent agent switch), or undefined. Prompt actions ignore it. */
  toolBlocked: string | undefined;
  run: (item: PanelStackItem, action: PanelAction, request: ActionRequest) => void;
}
interface Scope { item: PanelStackItem; host: ActionHost }
const Context = createContext<Scope | undefined>(undefined);
export const ActionScope = ({ value, children }: { value: Scope | undefined; children: ReactNode }) => <Context.Provider value={value}>{children}</Context.Provider>;

export interface Offered { action: PanelAction; request: ActionRequest; disabled: string | undefined; run: () => void }

/** The actions of one panel that apply to one target, each with the reason it cannot run now. */
export function offeredActions(panel: PanelStackItem, host: ActionHost, scope: PanelActionScope, block?: string, item?: { id: string; status?: PanelItemStatus | undefined }): Offered[] {
  const offered: Offered[] = [];
  for (const action of panel.declaration.actions) {
    // Response controls are offered by the interaction adapter once a request exists.
    if (action.kind === "response") continue;
    if (action.scope !== scope) continue;
    const request: ActionRequest = { action: action.id, ...(block !== undefined && scope !== "panel" ? { block } : {}), ...(item && scope === "item" ? { item: item.id } : {}) };
    try { resolveAction(panel.declaration, request, panel.document); } catch { continue; }
    const disabled = action.kind === "tool" ? (panel.stale ? "This panel is stale: its tool is not selected by this agent" : host.toolBlocked) : undefined;
    offered.push({ action, request, disabled, run: () => host.run(panel, action, request) });
  }
  return offered;
}
/** Same, for the panel the surrounding section shows. Call it once per component; `useOfferer` is for loops. */
export const useOfferer = () => {
  const context = useContext(Context);
  return (scope: PanelActionScope, block?: string, item?: { id: string; status?: PanelItemStatus | undefined }): Offered[] =>
    context ? offeredActions(context.item, context.host, scope, block, item) : [];
};
export const useOffered = (scope: PanelActionScope, block?: string, item?: { id: string; status?: PanelItemStatus | undefined }): Offered[] => useOfferer()(scope, block, item);

/** A "…" menu with every offered action; nothing is drawn when the target has none. */
export function ActionMenu({ offered, label }: { offered: Offered[]; label: string }) {
  if (!offered.length) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-button panel-action-menu" aria-label={label} title={label}>
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={4} collisionPadding={8}>
          {offered.map((entry) => (
            <DropdownMenu.Item key={entry.action.id} className="workspace-menu-item" disabled={!!entry.disabled} title={entry.disabled} onSelect={entry.run}>
              {entry.action.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The status glyph, which becomes the item's primary action when it has one (with its disabled reason and a label). */
export function StatusControl({ block, item, name, children }: { block: string; item: { id: string; status?: PanelItemStatus | undefined }; name: string; children: ReactNode }) {
  const primary = useOffered("item", block, item).find((entry) => entry.action.primary);
  if (!primary) return <>{children}</>;
  return (
    <button type="button" className="panel-glyph-button" aria-label={`${primary.action.label}: ${name}`} disabled={!!primary.disabled}
      title={primary.disabled ?? primary.action.label} onClick={primary.run}>
      {children}
    </button>
  );
}

/** The "…" menu with every action that applies to one item. */
export const ItemActions = ({ block, item, name }: { block: string; item: { id: string; status?: PanelItemStatus | undefined }; name: string }) =>
  <ActionMenu offered={useOffered("item", block, item)} label={`Actions for ${name}`} />;

/** Block-scope actions as one menu in the block header. */
export const BlockActions = ({ block, label }: { block: string; label: string }) => <ActionMenu offered={useOffered("block", block)} label={label} />;
