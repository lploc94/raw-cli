import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { OperationEvent } from "../sessions/operations.js";
import { terminalOperationStates } from "../sessions/operation-types.js";
import { projectHistoryItem } from "../sessions/view.js";
import { projectToolCall, projectToolResult } from "../sessions/visible.js";
import { MAX_REPLAY_BYTES, MAX_REPLAY_FRAMES } from "./contract.js";
import type { DashboardContext } from "./server.js";
import type { LiveOutput } from "./live-output.js";
import type { SessionSnapshot } from "./sessions.js";
import type { SessionOperation } from "../sessions/operations.js";
import type { HistoryView } from "../sessions/view.js";
import type { VisibleToolCall, VisibleToolResult } from "../sessions/visible.js";
import type { SessionMetrics } from "../sessions/metrics.js";
import type { RunEvent } from "../agent.js";
import type { Approval } from "./approvals.js";

export interface DashboardEventData {
  snapshot: SessionSnapshot; reset: SessionSnapshot;
  history: { items: HistoryView[]; historyWatermark: number };
  text: { segmentId: string; kind: "assistant" | "reasoning"; turnId?: string; text: string; bytes: number; unavailable?: string };
  tool: { callId: string; state?: "requested" | "running"; call?: VisibleToolCall; result?: VisibleToolResult; turnId?: string };
  operation: SessionOperation; metrics: SessionMetrics;
  compaction: Extract<RunEvent, { type: "compact_start" | "compact_end" | "compact_error" }>;
  approval: Approval & { status: "pending" | "allowed" | "denied" | "expired" | "cancelled" };
  ownership: { ownership: "idle" | "here" | "elsewhere" };
  host_error: { message: string };
}
export type DashboardEvent = {
  id: string; instanceId: string; sessionId: string; operationId?: string; sequence: number;
} & { [K in keyof DashboardEventData]: { type: K; data: DashboardEventData[K] } }[keyof DashboardEventData];
interface Channel { epoch: string; sequence: number; bytes: number; frames: Array<{ event: DashboardEvent; frame: string; bytes: number }>;
  clients: Set<ServerResponse>; history: number; ownership: string }

export class SessionStreams {
  private readonly channels = new Map<string, Channel>();
  private readonly poll: ReturnType<typeof setInterval>;
  private pending: { sessionId: string; operationId: string; data: DashboardEventData["text"] } | undefined;
  private flushTimer: ReturnType<typeof setImmediate> | undefined;
  constructor(private readonly context: DashboardContext, private readonly output: LiveOutput,
    private readonly snapshot: (sessionId: string) => SessionSnapshot, private readonly limits = { frames: MAX_REPLAY_FRAMES, bytes: MAX_REPLAY_BYTES }) {
    this.poll = setInterval(() => {
      for (const [id, channel] of this.channels) if (channel.clients.size) {
        try { this.syncHistory(id); const ownership = this.ownership(id);
          if (ownership !== channel.ownership) { channel.ownership = ownership; this.publish(id, "ownership", { ownership }); }
        } catch { for (const client of channel.clients) client.end(); channel.clients.clear(); }
      }
    }, 1500);
    this.poll.unref();
  }
  ownership(id: string): "idle" | "here" | "elsewhere" {
    if (!this.context.store!.sessionIsBusy(id)) return "idle";
    return this.context.operations!.activeIds().some((op) => this.context.store!.getOperation(op)?.sessionId === id) ? "here" : "elsewhere";
  }
  private channel(sessionId: string): Channel {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      // Inactive cursors may reset. Active sessions and readers retain their channel.
      if (this.channels.size >= 100) for (const [id, old] of this.channels) {
        if (!old.clients.size && this.ownership(id) !== "here") { this.channels.delete(id); break; }
      }
      channel = { epoch: randomUUID(), sequence: 0, bytes: 0, frames: [], clients: new Set(),
        history: this.context.store!.historyWatermark(sessionId), ownership: this.ownership(sessionId) };
      this.channels.set(sessionId, channel);
    }
    return channel;
  }
  private envelope<K extends keyof DashboardEventData>(sessionId: string, channel: Channel, type: K, data: DashboardEventData[K], operationId?: string): DashboardEvent {
    return { id: `${this.context.instanceId}:${channel.epoch}:${channel.sequence}`, instanceId: this.context.instanceId,
      sessionId, sequence: channel.sequence, type, data, ...(operationId ? { operationId } : {}) } as DashboardEvent;
  }
  private write(response: ServerResponse, frame: string): void {
    try {
      if (response.destroyed || response.writableEnded) return;
      // Allow one complete snapshot, including a large committed message. A reader that
      // cannot drain it is detached before another frame can grow the network queue.
      if (response.writableLength > MAX_REPLAY_BYTES) { response.destroy(); return; }
      response.write(frame);
    } catch { response.destroy(); }
  }
  publish<K extends keyof DashboardEventData>(sessionId: string, type: K, data: DashboardEventData[K], operationId?: string): void {
    if (type !== "text") this.flushText();
    const channel = this.channel(sessionId); channel.sequence++;
    const event = this.envelope(sessionId, channel, type, data, operationId);
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`; const bytes = Buffer.byteLength(frame);
    channel.frames.push({ event, frame, bytes }); channel.bytes += bytes;
    while (channel.frames.length > this.limits.frames || channel.bytes > this.limits.bytes) channel.bytes -= channel.frames.shift()!.bytes;
    for (const client of channel.clients) this.write(client, frame);
  }
  private flushText(): void {
    if (this.flushTimer) { clearImmediate(this.flushTimer); this.flushTimer = undefined; }
    const pending = this.pending; this.pending = undefined;
    if (pending) this.publish(pending.sessionId, "text", pending.data, pending.operationId);
  }
  private bufferText(sessionId: string, operationId: string, data: DashboardEventData["text"]): void {
    if (this.pending && (this.pending.sessionId !== sessionId || this.pending.operationId !== operationId
      || this.pending.data.segmentId !== data.segmentId || this.pending.data.text.length + data.text.length > 8192)) this.flushText();
    if (this.pending) this.pending.data = { ...data, text: this.pending.data.text + data.text };
    else this.pending = { sessionId, operationId, data };
    this.flushTimer ??= setImmediate(() => this.flushText());
  }
  syncHistory(sessionId: string): void {
    this.flushText();
    const channel = this.channel(sessionId); const through = this.context.store!.historyWatermark(sessionId);
    while (channel.history < through) {
      const items = this.context.store!.historyAfter(sessionId, channel.history, through).map(projectHistoryItem);
      if (!items.length) break;
      channel.history = items.at(-1)!.sequence;
      for (const item of items) this.output.removeSegment(item.id);
      this.publish(sessionId, "history", { items, historyWatermark: channel.history });
    }
  }
  observe(message: OperationEvent): void {
    const { sessionId, operationId } = message;
    this.channel(sessionId);
    if (message.type === "operation") {
      this.syncHistory(sessionId);
      if (terminalOperationStates.has(message.operation.state)) this.output.finish(operationId);
      this.publish(sessionId, "operation", message.operation, operationId);
      if (message.operation.metrics) this.publish(sessionId, "metrics", message.operation.metrics, operationId);
      return;
    }
    if (message.type === "host_error") { this.publish(sessionId, "host_error", { message: message.message }, operationId); return; }
    const event = message.event;
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const kind = event.type === "text_delta" ? "assistant" : "reasoning";
      const segmentId = event.segmentId ?? `${operationId}:${kind}`;
      const view = this.output.append(operationId, segmentId, kind, event.text, event.turnId);
      // The spool is authoritative for long live segments. Small frames keep replay memory bounded.
      for (let offset = 0; offset < event.text.length; offset += 8192) this.bufferText(sessionId, operationId, {
        segmentId, kind, ...(event.turnId ? { turnId: event.turnId } : {}), text: event.text.slice(offset, offset + 8192), bytes: view.bytes,
        ...(view.unavailable ? { unavailable: view.unavailable } : {}),
      });
      return;
    } else if (event.type === "tool_call" || event.type === "tool_start") {
      this.publish(sessionId, "tool", { callId: event.id, state: event.type === "tool_start" ? "running" : "requested",
        call: projectToolCall(event.name, this.context.operations!.toolIdentity(operationId, event.name), event.arguments, event.type === "tool_start"),
        ...(event.turnId ? { turnId: event.turnId } : {}) }, operationId);
    } else if (event.type === "tool_result") {
      this.publish(sessionId, "tool", { callId: event.id, result: event.display ?? projectToolResult(event.name,
        this.context.operations!.toolIdentity(operationId, event.name), event.result), ...(event.turnId ? { turnId: event.turnId } : {}) }, operationId);
    } else if (event.type === "compact_start" || event.type === "compact_end" || event.type === "compact_error") this.publish(sessionId, "compaction", event, operationId);
    // Core commits can follow the synchronous callback. Flush after that commit and before a snapshot.
    queueMicrotask(() => { try { this.syncHistory(sessionId); } catch { /* Closing the host cannot abort execution through an observer. */ } });
    if (event.type === "usage" || event.type === "run_end") {
      const metrics = this.context.operations!.metrics(operationId); if (metrics) this.publish(sessionId, "metrics", metrics, operationId);
    }
  }
  subscribe(sessionId: string, response: ServerResponse, cursor?: string): void {
    this.syncHistory(sessionId); const channel = this.channel(sessionId);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    const prefix = `${this.context.instanceId}:${channel.epoch}:`;
    const sequence = cursor?.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN;
    const valid = Number.isSafeInteger(sequence) && sequence >= (channel.frames[0]?.event.sequence ?? channel.sequence + 1) - 1 && sequence <= channel.sequence;
    // No await between boundary capture and subscription: this process cannot publish an intervening delta.
    if (cursor && valid) for (const item of channel.frames) { if (item.event.sequence > sequence) this.write(response, item.frame); }
    else {
      const event = this.envelope(sessionId, channel, cursor ? "reset" : "snapshot", this.snapshot(sessionId));
      this.write(response, `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    channel.clients.add(response);
    const heartbeat = setInterval(() => this.write(response, ": keepalive\n\n"), 15000); heartbeat.unref();
    response.once("close", () => { clearInterval(heartbeat); channel.clients.delete(response); });
  }
  close(): void { clearInterval(this.poll); if (this.flushTimer) clearImmediate(this.flushTimer); this.pending = undefined;
    for (const channel of this.channels.values()) for (const client of channel.clients) client.end(); this.channels.clear(); }
}
