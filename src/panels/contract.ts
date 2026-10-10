/** raw.panel/2 data model. The normative reference is docs/panels-design.md. */

export const PANEL_PROTOCOL = "raw.panel/2";

/** Largest text answer one form field accepts; the result still has to fit the tool output budget it is returned in. */
export const MAX_TEXT_ANSWER_BYTES = 65536;

export const PANEL_LIMITS = {
  panelsPerTool: 4,
  actionsPerPanel: 8,
  panelsPerSession: 16,
  documentBytes: 64 * 1024,
  blocks: 20,
  items: 200,
  steps: 30,
  checklistDepth: 3,
  updatesPerCall: 200,
  receiptBytes: 1024,
  reminderBytes: 2 * 1024,
  reminderTotalBytes: 8 * 1024,
  markdownBytes: 16 * 1024,
  fallbackBytes: 4 * 1024,
  contextSummaryBytes: 2048,
} as const;

export const PANEL_ICONS = ["list-checks", "list-ordered", "file-text", "table", "activity", "gauge", "folder-tree", "flag", "panel"] as const;
export type PanelIcon = (typeof PANEL_ICONS)[number];

export const PANEL_ITEM_STATUSES = ["pending", "in_progress", "done", "skipped", "blocked", "failed"] as const;
export type PanelItemStatus = (typeof PANEL_ITEM_STATUSES)[number];
export const PANEL_STATUSES = ["idle", "active", "done", "failed"] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

export type PanelErrorCode =
  | "panel_invalid" | "panel_too_large" | "panel_unknown" | "panel_not_owned" | "panel_undeclared"
  | "panel_revision_conflict" | "panel_limit" | "panel_rate_limited" | "panel_closed_context";

export class PanelError extends Error {
  constructor(readonly code: PanelErrorCode, message: string) { super(message); this.name = "PanelError"; }
}

export interface PanelRef { path: string; line?: number }

export interface ChecklistItem {
  id: string; label: string; status?: PanelItemStatus; priority?: "high" | "medium" | "low";
  note?: string; ref?: PanelRef; children?: ChecklistItem[];
}
export interface StepItem { id: string; label: string; status?: PanelItemStatus; detail?: string; started_at?: number; ended_at?: number }
export interface TableColumn { id: string; label: string; align?: "start" | "end" | "center" }
export interface TableRow { id: string; status?: PanelItemStatus; cells: Record<string, string>; ref?: PanelRef }
export interface TimelineEvent { id: string; at: number; level: "info" | "success" | "warning" | "error"; label: string; detail?: string }
export interface FileEntry { path: string; status?: "added" | "modified" | "deleted" | "referenced"; line?: number; label?: string }
export interface KeyValueEntry { key: string; value: string; ref?: PanelRef }
export interface FormOption { id: string; label: string }
export type FormField = { id: string; label: string; description?: string; required?: boolean } & (
  | { kind: "text"; multiline?: boolean; max_bytes?: number }
  | { kind: "single_select"; options: FormOption[] }
  | { kind: "multi_select"; options: FormOption[]; min_selected?: number; max_selected?: number }
);

interface BlockBase { id: string; title?: string; fallback?: string }
export type PanelBlock =
  | (BlockBase & { kind: "checklist"; items: ChecklistItem[] })
  | (BlockBase & { kind: "steps"; items: StepItem[] })
  | (BlockBase & { kind: "progress"; label?: string; value?: number; max?: number; indeterminate?: boolean })
  | (BlockBase & { kind: "key_value"; entries: KeyValueEntry[] })
  | (BlockBase & { kind: "table"; columns: TableColumn[]; rows: TableRow[] })
  | (BlockBase & { kind: "markdown"; text: string })
  | (BlockBase & { kind: "timeline"; max?: number; events: TimelineEvent[] })
  | (BlockBase & { kind: "files"; entries: FileEntry[] })
  | (BlockBase & { kind: "form"; fields: FormField[] })
  | (BlockBase & { kind: "mermaid"; source: string })
  /** A kind this host does not know. Only the common fields are interpreted. */
  | (BlockBase & { kind: string; [field: string]: unknown });

export interface PanelDocument {
  title?: string; subtitle?: string; status?: PanelStatus;
  progress?: { done: number; total: number }; summary?: string; context_summary?: string;
  blocks: PanelBlock[];
}

export type PanelPatch =
  | { op: "set"; field: "title" | "subtitle" | "status" | "summary" | "context_summary" | "progress"; value: unknown }
  | { op: "set_block"; block: PanelBlock; before?: string }
  | { op: "remove_block"; id: string }
  | { op: "upsert_items"; block: string; items: Record<string, unknown>[]; parent?: string }
  | { op: "remove_items"; block: string; ids?: string[]; keys?: string[]; paths?: string[] }
  | { op: "append_events"; block: string; events: TimelineEvent[] };

export type PanelUpdate =
  | { panel: string; op: "replace"; base_revision?: number; document: PanelDocument }
  | { panel: string; op: "patch"; base_revision?: number; patches: PanelPatch[] }
  | { panel: string; op: "close"; base_revision?: number };

export type PanelActionScope = "panel" | "block" | "item";
export interface PanelAction {
  id: string; label: string; scope: PanelActionScope; blocks?: string[]; kind: "prompt" | "tool" | "response";
  response?: "submit" | "cancel";
  text?: string; send?: boolean; arguments?: Record<string, unknown>; primary?: boolean; confirm?: string;
  when?: { status: PanelItemStatus[] };
}
export interface PanelDeclaration {
  placement?: "chat" | "sidebar";
  id: string; title: string; icon: PanelIcon; open: "never" | "first_update";
  context: "none" | "summary"; acp_plan: boolean; actions: PanelAction[];
}

/** Host-owned call identity. Library calls may have no durable session or operation. */
export interface ToolCallUIIdentity {
  sessionId?: string; operationId?: string; runId: string; toolCallId: string;
  owner: string; panelId: string;
}
/** Opaque identity of a historical chat view; never a lookup of the latest sidebar panel. */
export interface ToolViewIdentity extends ToolCallUIIdentity { instanceId: string }
/** A request is bound to its originating call and, when inline, its view instance. */
export interface InteractionRequestIdentity extends ToolCallUIIdentity { requestId: string; viewInstanceId?: string }
export type InteractionState = "pending" | "answered" | "cancelled" | "expired" | "interrupted";
export type FormAnswers = Record<string, string | string[]>;
/** Transport input; the host resolves session/call/owner bindings from the stored request. */
export type InteractionResponseSubmission = {
  requestId: string; expectedRevision: number; idempotencyKey: string;
} & ({ response: "submit"; answers: FormAnswers } | { response: "cancel" });
export interface InteractionResponseAcknowledgement {
  requestId: string; revision: number; state: Exclude<InteractionState, "pending">;
  /** Exact accepted JSON tool result, if answered. */
  canonicalResult?: string;
}

/** What a tool sees as `context.panels`. */
export interface PanelContext {
  readonly protocol: 2;
  update(panel: string, update: PanelUpdateBody): Promise<{ revision: number }>;
  get(panel: string): { revision: number; document: PanelDocument } | undefined;
}
export type PanelUpdateBody =
  | { op: "replace"; base_revision?: number; document: PanelDocument }
  | { op: "patch"; base_revision?: number; patches: PanelPatch[] }
  | { op: "close"; base_revision?: number };

/** The small persisted record of one committed (or rejected) update. */
export interface PanelReceipt {
  view?: ToolViewIdentity;
  panel: string; owner: string; title: string; revision: number; summary: string;
  progress?: { done: number; total: number }; status: PanelStatus; op: "replace" | "patch" | "close";
  toolCallId: string; source: "tool" | "user_action";
  error?: { code: PanelErrorCode; message: string };
}

/** One `session_panels` row: the latest committed state of a panel (docs/panels-design.md §12). */
export interface StoredPanel {
  /** Full id: `<owner>#<panel>`. */
  panelId: string; owner: string; revision: number; createdAt: number; updatedAt: number; closed: boolean;
  declaration: PanelDeclaration; document: PanelDocument;
}
export interface StoredToolView extends StoredPanel { view: ToolViewIdentity }
/** Panel changes committed in the same transaction as one tool result. Receipts travel as `panel_receipt` history records. */
export interface PanelWrites { upserts: StoredPanel[]; deletes: string[]; views?: StoredToolView[] }
