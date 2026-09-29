import type { PanelDeclaration, PanelDocument, PanelIcon, StoredPanel } from "./contract.js";
import type { KnownPanels } from "./declarations.js";

/** One section of a session's panel stack: the shape shared by the HTTP API, snapshots and `getSessionPanels` (§13.1). */
export interface PanelStackItem {
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

const fromStored = (stored: StoredPanel, declaration: PanelDeclaration, stale: boolean): PanelStackItem => ({
  panel: stored.panelId, owner: stored.owner, title: declaration.title, icon: declaration.icon, revision: stored.revision,
  updatedAt: stored.updatedAt, closed: stored.closed, stale, declaration, document: structuredClone(stored.document) });

/**
 * The stack for one agent in the default order of docs/panels-design.md §13.1: declared panels (with a muted, data-less
 * entry when nothing was published yet), implicit panels in creation order, then stale panels that still hold data.
 * When the agent's declarations cannot be read (`known` is undefined) every stored panel is listed in creation order
 * and none is called stale: the stack degrades instead of hiding data.
 */
export function buildPanelStack(known: KnownPanels | undefined, stored: readonly StoredPanel[]): PanelStackItem[] {
  const byId = new Map(stored.map((panel) => [panel.panelId, panel]));
  const oldestFirst = (list: StoredPanel[]) => list.sort((a, b) => a.createdAt - b.createdAt || (a.panelId < b.panelId ? -1 : 1));
  const listed = new Set<string>();
  const items: PanelStackItem[] = [];
  for (const { owner, declaration } of known?.declared ?? []) {
    const id = `${owner}#${declaration.id}`;
    if (listed.has(id)) continue;
    listed.add(id);
    const found = byId.get(id);
    items.push(found ? fromStored(found, declaration, false) : { panel: id, owner, title: declaration.title, icon: declaration.icon,
      revision: 0, updatedAt: null, closed: false, stale: false, declaration, document: null });
  }
  const implicit = new Set(known?.implicitOwners ?? []);
  for (const panel of oldestFirst(stored.filter((item) => !listed.has(item.panelId) && (known === undefined || implicit.has(item.owner))))) {
    listed.add(panel.panelId);
    items.push(fromStored(panel, panel.declaration, false));
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
