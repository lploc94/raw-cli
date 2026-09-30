import type { InteractionRequest } from "../interactions/contract.js";
import type { PanelDeclaration, PanelDocument, PanelIcon, StoredPanel, StoredToolView } from "./contract.js";
import type { KnownPanels } from "./declarations.js";

/** One section of a session's panel stack: the shape shared by the HTTP API, snapshots and `getSessionPanels` (§13.1). */
export interface PanelStackItem {
  interaction?: InteractionRequest;
  /** Present for a historical inline snapshot; actions bind to that instance. */
  instanceId?: string;
  /** The full id, `<owner>#<panel id>`. */
  panel: string;
  owner: string;
  title: string;
  icon: PanelIcon;
  revision: number;
  updatedAt: number | null;
  closed: boolean;
  stale: boolean;
  declaration: PanelDeclaration;
  document: PanelDocument | null;
}

/** A `deny` rule hides tool actions entirely; prompt actions only draft a message and stay. */
const visibleActions = (declaration: PanelDeclaration, owner: string, known: KnownPanels | undefined): PanelDeclaration =>
  known?.denied?.(owner) ? { ...declaration, actions: declaration.actions.filter((action) => action.kind !== "tool") } : declaration;

const fromStored = (stored: StoredPanel, declaration: PanelDeclaration, stale: boolean): PanelStackItem => ({
  panel: stored.panelId, owner: stored.owner, title: declaration.title, icon: declaration.icon, revision: stored.revision,
  updatedAt: stored.updatedAt, closed: stored.closed, stale, declaration, document: structuredClone(stored.document) });

export const toolViewStackItem = (view: StoredToolView, declaration = view.declaration, stale = false): PanelStackItem =>
  ({ ...fromStored(view, declaration, stale), instanceId: view.view.instanceId });

/** Immutable historical content plus current selection/policy for its controls. */
export interface ToolViewSnapshot extends StoredToolView {
  presentation: { declaration: PanelDeclaration; stale: boolean };
}

export function presentDeclaration(stored: PanelDeclaration, owner: string, known: KnownPanels | undefined) {
  const current = known?.declared.find(item => item.owner === owner && item.declaration.id === stored.id);
  const stale = known !== undefined && !current && !known.implicitOwners.includes(owner);
  const declaration = { ...stored, actions: (current?.declaration ?? stored).actions };
  return { declaration: visibleActions(declaration, owner, known), stale };
}
export function presentToolView(view: StoredToolView, known: KnownPanels | undefined): ToolViewSnapshot {
  return { ...view, presentation: presentDeclaration(view.declaration, view.owner, known) };
}

/**
 * The stack for one agent in the default order of docs/panels-design.md §13.1: declared panels (with a muted, data-less
 * entry when nothing was published yet), implicit panels in creation order, then stale panels that still hold data.
 * When the agent's declarations cannot be read (`known` is undefined) every stored panel is listed in creation order
 * and none is called stale: the stack degrades instead of hiding data.
 */
export function buildPanelStack(known: KnownPanels | undefined, stored: readonly StoredPanel[]): PanelStackItem[] {
  stored = stored.filter(item => item.declaration.placement !== "chat");
  const byId = new Map(stored.map((panel) => [panel.panelId, panel]));
  const oldestFirst = (list: StoredPanel[]) => list.sort((a, b) => a.createdAt - b.createdAt || (a.panelId < b.panelId ? -1 : 1));
  const listed = new Set<string>();
  const items: PanelStackItem[] = [];
  for (const { owner, declaration } of known?.declared ?? []) {
    if (declaration.placement === "chat") continue;
    const id = `${owner}#${declaration.id}`;
    if (listed.has(id)) continue;
    listed.add(id);
    const found = byId.get(id);
    const shown = visibleActions(declaration, owner, known);
    items.push(found ? fromStored(found, shown, false) : { panel: id, owner, title: declaration.title, icon: declaration.icon,
      revision: 0, updatedAt: null, closed: false, stale: false, declaration: shown, document: null });
  }
  const implicit = new Set(known?.implicitOwners ?? []);
  for (const panel of oldestFirst(stored.filter((item) => !listed.has(item.panelId) && (known === undefined || implicit.has(item.owner))))) {
    listed.add(panel.panelId);
    items.push(fromStored(panel, visibleActions(panel.declaration, panel.owner, known), false));
  }
  for (const panel of oldestFirst(stored.filter((item) => !listed.has(item.panelId)))) items.push(fromStored(panel, panel.declaration, true));
  return items;
}

/** Declarations tied to the agent they were read for, so a snapshot never pairs one agent's name with another's panels. */
export interface LoadedDeclarations { agent: string | undefined; known: KnownPanels | undefined }

/**
 * Reads the declarations of the session's saved agent and returns them only if that agent is still the saved one when the
 * (asynchronous) read finishes; otherwise it reads again, a few times, and finally degrades to "unknown".
 */
export async function loadDeclarationsForSaved(savedAgent: () => string | undefined,
  load: (agent: string) => Promise<KnownPanels | undefined>): Promise<LoadedDeclarations> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const agent = savedAgent();
    if (!agent) return { agent, known: undefined };
    const known = await load(agent);
    if (savedAgent() === agent) return { agent, known };
  }
  return { agent: savedAgent(), known: undefined };
}

/** The declarations to use for a snapshot taken now: only those read for the agent that is still saved. */
export const declarationsFor = (savedAgent: string | undefined, loaded: LoadedDeclarations | undefined): KnownPanels | undefined =>
  loaded !== undefined && loaded.agent === savedAgent ? loaded.known : undefined;
