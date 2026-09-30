import { randomUUID } from "node:crypto";
import type { SessionOperation } from "../sessions/operations.js";
import type { ToolContext } from "../tools/primitives.js";
import { DashboardError } from "./errors.js";

export interface Approval {
  id: string; sessionId: string; operationId: string; callId: string; name: string;
  arguments: Record<string, unknown>; createdAt: number; deadline: number;
  effects?: Record<string, unknown>;
}
export class Approvals {
  private readonly pending = new Map<string, { value: Approval; finish: (allow: boolean) => void }>();
  constructor(private readonly publish: (approval: Approval, status: "pending" | "allowed" | "denied" | "expired" | "cancelled") => void) {}
  forOperation(operation: Pick<SessionOperation, "id" | "sessionId">, timeout: () => number): NonNullable<ToolContext["approve"]> {
    return ({ name, arguments: args, signal, toolCallId: callId, effects }) => {
      if (signal?.aborted || !callId) return false;
      return new Promise<boolean>((resolve) => {
        const createdAt = Date.now();
        const value: Approval = { id: randomUUID(), sessionId: operation.sessionId, operationId: operation.id,
          callId, name, arguments: structuredClone(args), ...(effects ? { effects: structuredClone(effects) } : {}), createdAt, deadline: createdAt + timeout() };
        const finish = (allow: boolean, status: "allowed" | "denied" | "expired" | "cancelled" = allow ? "allowed" : "denied") => {
          if (!this.pending.delete(value.id)) return;
          clearTimeout(timer); signal?.removeEventListener("abort", abort);
          this.publish(value, status); resolve(allow);
        };
        const abort = () => finish(false, "cancelled");
        const timer = setTimeout(() => finish(false, "expired"), Math.max(1, value.deadline - Date.now()));
        this.pending.set(value.id, { value, finish });
        signal?.addEventListener("abort", abort, { once: true });
        this.publish(value, "pending");
      });
    };
  }
  list(sessionId?: string): Approval[] { return [...this.pending.values()].map((item) => item.value).filter((item) => !sessionId || item.sessionId === sessionId); }
  answer(id: string, operationId: string, callId: string, allow: boolean): void {
    const item = this.pending.get(id);
    if (!item || item.value.operationId !== operationId || item.value.callId !== callId || item.value.deadline <= Date.now()) {
      throw new DashboardError(409, "stale_approval", "This approval is no longer pending for that operation and tool call");
    }
    item.finish(allow);
  }
  close(): void { for (const item of this.pending.values()) item.finish(false); }
}
