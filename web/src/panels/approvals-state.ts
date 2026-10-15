import type { Approval } from "../../../src/dashboard/approvals.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";

export const APPROVALS_ID = "__approvals";

/**
 * The side panel's Approvals tab, from the session's pending approvals. A local layout descriptor only: never
 * submitted to PanelHost or exposed as tool authority. The revision is the newest request's time, so answering one
 * and being asked again later counts as unseen, which a count of the pending calls would not.
 */
export function approvalsSection(approvals: readonly Approval[]): PanelStackItem {
  const revision = approvals.reduce((max, item) => Math.max(max, item.createdAt), 0);
  return { panel: APPROVALS_ID, owner: "", title: "Approvals", icon: "flag", revision, updatedAt: revision || null, closed: false, stale: false,
    declaration: { id: APPROVALS_ID, title: "Approvals", icon: "flag", open: "never", context: "none", acp_plan: false, actions: [] },
    document: approvals.length ? { blocks: [], subtitle: "Tool calls waiting for your answer", summary: `${approvals.length} waiting for approval` } : null };
}
