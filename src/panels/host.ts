import {
  PANEL_LIMITS, PanelError, type PanelContext, type PanelDeclaration, type PanelDocument, type PanelReceipt,
  type PanelUpdateBody, type PanelWrites, type StoredPanel,
} from "./contract.js";
import { applyUpdate } from "./patch.js";
import { derivedProgress, derivedSummary, truncateBytes } from "./render.js";
import type { ToolContentPanel } from "../tools/types.js";

/** What observers (dashboard stream, library callers) receive for each state change. */
export interface PanelLiveEvent {
  panel: string; owner: string; revision: number; document: PanelDocument; closed: boolean; live: boolean;
}

export interface PanelOwnerInfo { owner: string; declarations: readonly PanelDeclaration[]; implicit: boolean }

export interface SettledPanels {
  /** Lines appended to the model-visible tool result (§10). */
  lines: string[];
  /** Receipts, in history order. Rejections are receipts with `error`. */
  receipts: PanelReceipt[];
  writes?: PanelWrites;
}

const LIVE_INTERVAL_MS = 250;
const clone = <T>(value: T): T => structuredClone(value);

/** A bounded label for identifiers that failed validation, so diagnostics can never grow with hostile input. */
export function panelLabel(value: unknown): string {
  return typeof value === "string" ? truncateBytes(value, 64) : `<${value === null ? "null" : typeof value}>`;
}

/** The panel's local id for `info.owner`; a full `<owner>#<id>` spelling is accepted only for the owner itself. */
export function localPanelId(info: PanelOwnerInfo, panel: unknown): string {
  if (typeof panel !== "string") throw new PanelError("panel_invalid", `/panel: must be a string, got ${panelLabel(panel)}`);
  const hash = panel.indexOf("#");
  if (hash < 0) return panel;
  if (panel.slice(0, hash) !== info.owner) throw new PanelError("panel_not_owned", `panel "${panelLabel(panel)}" belongs to another owner`);
  return panel.slice(hash + 1);
}

function implicitDeclaration(id: string, title: string): PanelDeclaration {
  return { id, title: title.slice(0, 40) || id, icon: "panel", open: "never", context: "none", acp_plan: false, actions: [] };
}

/**
 * Per-runtime owner of tool panel state (docs/panels-design.md §4). Every emission path converges here, so
 * validation, ownership, limits and revisions are identical everywhere. One tool call is settled at a time.
 */
export class PanelHost {
  private working = new Map<string, StoredPanel>();
  private committed = new Map<string, StoredPanel>();
  private pendingDeletes = new Set<string>();
  private touched = new Set<string>();
  private listener: ((event: PanelLiveEvent) => void) | undefined;
  private readonly lastEmit = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: { initial?: readonly StoredPanel[]; now?: () => number } = {}) {
    for (const panel of options.initial ?? []) {
      this.working.set(panel.panelId, clone(panel));
      this.committed.set(panel.panelId, clone(panel));
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  setListener(listener: ((event: PanelLiveEvent) => void) | undefined): void {
    this.listener = listener;
    if (!listener) this.clearTimers();
  }
  /** Committed panels, oldest first. */
  snapshot(): StoredPanel[] { return [...this.committed.values()].map(clone); }
  close(): void { this.clearTimers(); this.listener = undefined; }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private event(panel: StoredPanel, live: boolean): PanelLiveEvent {
    return { panel: panel.panelId.slice(panel.owner.length + 1), owner: panel.owner, revision: panel.revision,
      document: clone(panel.document), closed: panel.closed, live };
  }

  /** At most one live frame per panel every 250 ms; the latest state wins. */
  private scheduleLive(panelId: string): void {
    if (!this.listener || this.timers.has(panelId)) return;
    const wait = LIVE_INTERVAL_MS - (Date.now() - (this.lastEmit.get(panelId) ?? 0));
    const emit = () => {
      this.timers.delete(panelId);
      const latest = this.working.get(panelId);
      if (!latest || !this.listener) return;
      this.lastEmit.set(panelId, Date.now());
      try { this.listener(this.event(latest, true)); } catch { /* observers never affect state */ }
    };
    if (wait <= 0) emit();
    else { const timer = setTimeout(emit, wait); timer.unref(); this.timers.set(panelId, timer); }
  }

  /** Starts one tool call. `owner` is the tool's canonical identity, never a presentation alias. */
  begin(callId: string, info: PanelOwnerInfo, source: PanelReceipt["source"] = "tool"): PanelCall {
    // An earlier call that never reached its commit (for example an aborted run) leaves nothing behind.
    if (this.touched.size || this.pendingDeletes.size) this.rollback();
    return new PanelCall(this, callId, info, source);
  }

  /** @internal Applies one update to the working state; used by PanelCall only. */
  applyTo(info: PanelOwnerInfo, panel: string, body: unknown): { revision: number; panelId: string; op: "replace" | "patch" | "close" } {
    const local = localPanelId(info, panel);
    const update = { ...(body as object), panel: local } as { panel: string; op: "replace" | "patch" | "close"; base_revision?: number };
    const panelId = `${info.owner}#${local}`;
    const entry = this.working.get(panelId);
    let declaration = info.declarations.find((item) => item.id === local);
    if (!declaration && !info.implicit) throw new PanelError("panel_undeclared", `tool ${info.owner} did not declare panel "${local}"`);
    const applied = applyUpdate(entry && { document: entry.document, closed: entry.closed }, update);
    declaration ??= entry?.declaration ?? implicitDeclaration(local, applied.document.title ?? local);
    const baseRevision = update.base_revision;
    if (baseRevision !== undefined && baseRevision !== (entry?.revision ?? 0)) {
      throw new PanelError("panel_revision_conflict", `panel "${local}" is at revision ${entry?.revision ?? 0}, not ${baseRevision}`);
    }
    if (!entry && this.working.size >= PANEL_LIMITS.panelsPerSession) {
      const evictable = [...this.working.values()].filter((item) => item.closed)
        .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)[0];
      if (!evictable) throw new PanelError("panel_limit", `this session already has ${PANEL_LIMITS.panelsPerSession} panels and none is closed`);
      this.working.delete(evictable.panelId);
      this.touched.delete(evictable.panelId);
      this.pendingDeletes.add(evictable.panelId);
    }
    const at = this.now();
    const next: StoredPanel = { panelId, owner: info.owner, revision: (entry?.revision ?? 0) + 1, createdAt: entry?.createdAt ?? at,
      updatedAt: at, closed: applied.closed, declaration: clone(declaration), document: applied.document };
    this.working.set(panelId, next);
    this.pendingDeletes.delete(panelId);
    this.touched.add(panelId);
    this.scheduleLive(panelId);
    return { revision: next.revision, panelId, op: update.op };
  }

  /** @internal */
  get(panelId: string): StoredPanel | undefined { return this.working.get(panelId); }

  /** @internal Builds the commit for everything touched since the last commit or rollback. */
  takeWrites(): PanelWrites | undefined {
    const upserts = [...this.touched].map((id) => this.working.get(id)).filter((item): item is StoredPanel => item !== undefined).map(clone);
    const deletes = [...this.pendingDeletes];
    return upserts.length || deletes.length ? { upserts, deletes } : undefined;
  }

  /** @internal The writes were durably stored: they become the committed state and observers get the final frames. */
  markCommitted(): void {
    for (const id of this.pendingDeletes) this.committed.delete(id);
    for (const id of this.touched) {
      const panel = this.working.get(id);
      if (panel) this.committed.set(id, clone(panel));
    }
    const finals = [...this.touched].map((id) => this.working.get(id)).filter((item): item is StoredPanel => item !== undefined);
    this.pendingDeletes.clear();
    this.touched.clear();
    for (const panel of finals) {
      const timer = this.timers.get(panel.panelId);
      if (timer) { clearTimeout(timer); this.timers.delete(panel.panelId); }
      this.lastEmit.set(panel.panelId, Date.now());
      try { this.listener?.(this.event(panel, false)); } catch { /* observers never affect state */ }
    }
  }

  /** @internal The commit failed: forget everything since the last committed state. */
  rollback(): void {
    for (const id of [...this.touched, ...this.pendingDeletes]) {
      const saved = this.committed.get(id);
      if (saved) this.working.set(id, clone(saved)); else this.working.delete(id);
    }
    this.pendingDeletes.clear();
    this.touched.clear();
    this.clearTimers();
  }
}

/** One tool call's view of the host: the streaming API, the extracted result blocks, and the settle step. */
export class PanelCall {
  private closed = false;
  private readonly counts = new Map<string, number>();
  private collected: ToolContentPanel[] = [];
  private readonly ops = new Map<string, "replace" | "patch" | "close">();

  constructor(private readonly host: PanelHost, private readonly callId: string, private readonly info: PanelOwnerInfo,
    private readonly source: PanelReceipt["source"] = "tool") {}

  /** Counts accepted updates per canonical panel; rejected attempts and alternative spellings neither add to nor dodge the limit. */
  private run(panel: unknown, body: unknown): { revision: number } {
    const key = `${this.info.owner}#${localPanelId(this.info, panel)}`;
    if ((this.counts.get(key) ?? 0) >= PANEL_LIMITS.updatesPerCall) {
      throw new PanelError("panel_rate_limited", `more than ${PANEL_LIMITS.updatesPerCall} updates to "${panelLabel(panel)}" in one tool call`);
    }
    const result = this.host.applyTo(this.info, panel as string, body);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.ops.set(result.panelId, result.op);
    return { revision: result.revision };
  }

  readonly context: PanelContext = {
    protocol: 2,
    update: async (panel: string, body: PanelUpdateBody) => {
      if (this.closed) throw new PanelError("panel_closed_context", "context.panels.update was called after the handler settled");
      return this.run(panel, body);
    },
    get: (panel: string) => {
      const found = this.host.get(`${this.info.owner}#${panel}`);
      return found ? { revision: found.revision, document: clone(found.document) } : undefined;
    },
  };

  /** Ends the streaming window; called as soon as the handler returns, before post-tool hooks can run. */
  endWindow(): void { this.closed = true; }

  /** The host-only sink for blocks removed from the handler result by `ToolRegistry.dispatch`. */
  collect(updates: readonly ToolContentPanel[]): void { this.collected.push(...updates.map(clone)); }

  /**
   * Ends the handler's window, applies result-block updates in order and prepares the commit. `resultIsEmpty` is true
   * when the tool returned only panel blocks, which earns the model a confirmation line (§10).
   */
  settle(resultIsEmpty: boolean): SettledPanels {
    this.closed = true;
    const rejected = new Map<string, { code: PanelError["code"]; message: string }>();
    const lines: string[] = [];
    for (const block of this.collected) {
      const { type: _type, ...update } = block;
      try { this.run(block.panel, update); }
      catch (error) {
        const failure = error instanceof PanelError ? error : new PanelError("panel_invalid", `update could not be applied: ${(error as Error).message}`);
        const raw = (block as { panel?: unknown }).panel;
        const local = panelLabel(typeof raw === "string" && raw.startsWith(`${this.info.owner}#`) ? raw.slice(this.info.owner.length + 1) : raw);
        if (!rejected.has(local)) rejected.set(local, { code: failure.code, message: truncateBytes(failure.message, 240) });
        if (lines.length < 5) lines.push(`panel ${local} update rejected: ${failure.code} ${truncateBytes(failure.message, 240)}`);
      }
    }
    const receipts: PanelReceipt[] = [];
    const confirmations: string[] = [];
    const writes = this.host.takeWrites();
    for (const stored of writes?.upserts ?? []) {
      const doc = stored.document;
      const title = doc.title ?? stored.declaration.title;
      const progress = derivedProgress(doc);
      const summary = derivedSummary(doc, title);
      receipts.push({ panel: stored.panelId.slice(stored.owner.length + 1), owner: stored.owner, title, revision: stored.revision, summary,
        ...(progress ? { progress } : {}), status: doc.status ?? "active", op: this.ops.get(stored.panelId) ?? "replace",
        toolCallId: this.callId, source: this.source });
      confirmations.push(`panel ${stored.panelId.slice(stored.owner.length + 1)} updated (revision ${stored.revision}): ${summary}`);
    }
    for (const [local, error] of rejected) {
      const current = this.host.get(`${this.info.owner}#${local}`);
      const declared = this.info.declarations.find((item) => item.id === local);
      receipts.push({ panel: local, owner: this.info.owner, title: current?.document.title ?? current?.declaration.title ?? declared?.title ?? local,
        revision: current?.revision ?? 0, summary: "", status: current?.document.status ?? "idle", op: "replace",
        toolCallId: this.callId, source: this.source, error });
    }
    if (resultIsEmpty) lines.unshift(...confirmations);
    return { lines, receipts: receipts.map((receipt) => this.bounded(receipt)), ...(writes ? { writes } : {}) };
  }

  /**
   * Keeps a receipt within `receiptBytes`. Order of sacrifice: summary, then title and error message, each cut to a
   * fixed size so the loop always terminates. Identifiers (panel, owner, tool call id) are never altered, so a receipt whose
   * identifiers alone exceed the budget stays over it rather than losing the link to its call.
   */
  private bounded(receipt: PanelReceipt): PanelReceipt {
    const size = (value: PanelReceipt) => Buffer.byteLength(JSON.stringify(value));
    let out = receipt;
    while (size(out) > PANEL_LIMITS.receiptBytes && out.summary.length > 0) {
      const next = truncateBytes(out.summary, Math.max(0, Buffer.byteLength(out.summary) - 64));
      out = { ...out, summary: next.length < out.summary.length ? next : "" };
    }
    if (size(out) > PANEL_LIMITS.receiptBytes) out = { ...out, title: truncateBytes(out.title, 80) };
    if (size(out) > PANEL_LIMITS.receiptBytes && out.error) out = { ...out, error: { ...out.error, message: truncateBytes(out.error.message, 120) } };
    return out;
  }

  /** The receipt of a panel this call did not change: its current state, bounded like every other receipt. */
  unchangedReceipt(local: string): PanelReceipt {
    const current = this.host.get(`${this.info.owner}#${local}`);
    const declared = this.info.declarations.find((item) => item.id === local);
    const title = current?.document.title ?? current?.declaration.title ?? declared?.title ?? local;
    const progress = current && derivedProgress(current.document);
    return this.bounded({ panel: local, owner: this.info.owner, title, revision: current?.revision ?? 0, summary: current ? derivedSummary(current.document, title) : "",
      ...(progress ? { progress } : {}), status: current ? current.document.status ?? "active" : "idle", op: "replace", toolCallId: this.callId, source: this.source });
  }

  commit(): void { this.host.markCommitted(); }
  rollback(): void { this.host.rollback(); }
}
