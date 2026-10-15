import type { Approval } from "../../src/dashboard/approvals.js";
import { api } from "./api.js";

/**
 * Answers one pending approval: allow this call once, or deny it. The host keeps the first valid answer, so a
 * second one is refused with `stale_approval` and its message is what the caller shows (docs/dashboard-api.md).
 */
export async function answerApproval(approval: Pick<Approval, "id" | "operationId" | "callId">, allow: boolean): Promise<void> {
  await api(`/permissions/${encodeURIComponent(approval.id)}`, "POST", { operationId: approval.operationId, callId: approval.callId, allow });
}
