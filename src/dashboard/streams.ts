import type { CommandRecord } from "../processes/presentation.js";
import type { ProcessControl } from "../processes/controls.js";
import type { InteractionRequest } from "../interactions/contract.js";
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
import type { PanelDocument, PanelDeclaration, ToolViewIdentity } from "../panels/contract.js";
import type { LoadedDeclarations } from "../panels/stack.js";

const PANEL_FRAME_INTERVAL_MS = 250;

export interface DashboardEventData {
  commands: { items: CommandRecord[] };
  process_control: ProcessControl;
  interaction: InteractionRequest;
  snapshot: SessionSnapshot; reset: SessionSnapshot;
  history: { items: HistoryView[]; historyWatermark: number };
  text: { segmentId: string; kind: "assistant" | "reasoning"; turnId?: string; text: string; bytes: number; unavailable?: string };
  tool: { callId: string; state?: "requested" | "running"; call?: VisibleToolCall; result?: VisibleToolResult; turnId?: string };
  operation: SessionOperation; metrics: SessionMetrics;
  compaction: Extract<RunEvent, { type: "compact_start" | "compact_end" | "compact_error" }>;
  approval: Approval & { status: "pending" | "allowed" | "denied" | "expired" | "cancelled" };
  ownership: { ownership: "idle" | "here" | "elsewhere" };
  host_error: { message: string };
  /** A committed or live panel state: the full document (at most 64 KiB), keyed by the full panel id (§13.1). */
  panel: { panel: string; owner: string; revision: number; closed: boolean; live: boolean; document: PanelDocument;
    view?: ToolViewIdentity; declaration?: PanelDeclaration };
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
  /** Per session and panel: when the last frame went out and the newest state waiting for its turn (latest wins). */
  private readonly panelFrames = new Map<string, { at: number; operationId: string; chat: boolean;
    timer?: ReturnType<typeof setTimeout> | undefined; pending?: { data: DashboardEventData["panel"]; operationId: string } | undefined }>();
  constructor(private readonly context: DashboardContext, private readonly output: LiveOutput,
    private readonly snapshot: (sessionId: string, loaded?: LoadedDeclarations) => SessionSnapshot,
    private readonly known: (sessionId: string) => Promise<LoadedDeclarations>, private readonly limits = { frames: MAX_REPLAY_FRAMES, bytes: MAX_REPLAY_BYTES }) {
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
  /**
   * At most one `panel` frame per panel every 250 ms. A state that arrives inside the window replaces any waiting state and is
   * sent when the window ends, so the last state always reaches the client; a snapshot stays authoritative.
   */
  private publishPanel(sessionId: string, operationId: string, data: DashboardEventData["panel"]): void {
    const key = `${sessionId}\0${data.view?.instanceId ?? data.panel}`;
    // Entries idle past their window carry no state; dropping them keeps this map to the panels that are active right now.
    if (this.panelFrames.size >= 64) for (const [other, idle] of this.panelFrames) {
      if (!idle.timer && !idle.pending && Date.now() - idle.at >= PANEL_FRAME_INTERVAL_MS) this.panelFrames.delete(other);
    }
    const entry = this.panelFrames.get(key) ?? { at: 0, operationId, chat: !!data.view };
    entry.operationId = operationId;
    this.panelFrames.set(key, entry);
    const send = (frame: DashboardEventData["panel"], operation: string) => { entry.at = Date.now(); this.publish(sessionId, "panel", frame, operation); };
    if (data.view && !data.live) {
      if (entry.timer) clearTimeout(entry.timer);
      send(data, operationId);
      this.panelFrames.delete(key);
      return;
    }
    const wait = PANEL_FRAME_INTERVAL_MS - (Date.now() - entry.at);
    if (wait <= 0 && !entry.timer) { send(data, operationId); return; }
    entry.pending = { data, operationId };
    entry.timer ??= setTimeout(() => {
      entry.timer = undefined;
      const pending = entry.pending; entry.pending = undefined;
      if (pending) send(pending.data, pending.operationId);
    }, Math.max(1, wait));
    entry.timer.unref();
  }
  syncHistory(sessionId: string): void {
    this.context.store!.recoverInteractions();
    this.flushText();
    const channel = this.channel(sessionId); const through = this.context.store!.historyWatermark(sessionId);
    while (channel.history < through) {
      const items = this.context.store!.historyAfter(sessionId, channel.history, through).map(projectHistoryItem);
      if (!items.length) break;
      channel.history = items.at(-1)!.sequence;
      for (const item of items) this.output.removeSegment(item.id);
      this.publish(sessionId, "history", { items, historyWatermark: channel.history });
      // A foreign host's durable audit must reconcile question UI just like a local response.
      for (const item of items) {
        const requestId = item.interactionRequestId ?? item.interactionResponseId;
        if (!requestId) continue;
        const request = this.context.store!.getInteraction(sessionId, requestId);
        if (request) this.publish(sessionId, "interaction", request, request.identity.operationId);
      }
    }
  }
  observe(message: OperationEvent): void {
    const { sessionId, operationId } = message;
    this.channel(sessionId);
    if (message.type === "operation") {
      this.syncHistory(sessionId);
      if (terminalOperationStates.has(message.operation.state)) {
        this.output.finish(operationId);
        for (const [key, entry] of this.panelFrames) if (entry.chat && entry.operationId === operationId) {
          if (entry.timer) clearTimeout(entry.timer);
          this.panelFrames.delete(key);
        }
      }
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
    } else if (event.type === "panel_update") {
      this.publishPanel(sessionId, operationId, { panel: `${event.owner}#${event.panel}`, owner: event.owner, revision: event.revision,
        closed: event.closed, live: event.live, document: event.document,
        ...(event.view ? { view: event.view } : {}), ...(event.declaration ? { declaration: event.declaration } : {}) });
    } else if (event.type === "compact_start" || event.type === "compact_end" || event.type === "compact_error") this.publish(sessionId, "compaction", event, operationId);
    // Core commits can follow the synchronous callback. Flush after that commit and before a snapshot.
    queueMicrotask(() => { try { this.syncHistory(sessionId); } catch { /* Closing the host cannot abort execution through an observer. */ } });
    if (event.type === "usage" || event.type === "run_end") {
      const metrics = this.context.operations!.metrics(operationId); if (metrics) this.publish(sessionId, "metrics", metrics, operationId);
    }
  }
  async subscribe(sessionId: string, response: ServerResponse, cursor?: string): Promise<void> {
    // Declarations are read before the boundary is captured, so no await separates the capture from the subscription below.
    const known = await this.known(sessionId);
    if (response.destroyed || response.writableEnded) return;
    this.syncHistory(sessionId); const channel = this.channel(sessionId);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    const prefix = `${this.context.instanceId}:${channel.epoch}:`;
    const sequence = cursor?.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN;
    const valid = Number.isSafeInteger(sequence) && sequence >= (channel.frames[0]?.event.sequence ?? channel.sequence + 1) - 1 && sequence <= channel.sequence;
    // No await between boundary capture and subscription: this process cannot publish an intervening delta.
    if (cursor && valid) for (const item of channel.frames) { if (item.event.sequence > sequence) this.write(response, item.frame); }
    else {
      const event = this.envelope(sessionId, channel, cursor ? "reset" : "snapshot", this.snapshot(sessionId, known));
      this.write(response, `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    channel.clients.add(response);
    const heartbeat = setInterval(() => this.write(response, ": keepalive\n\n"), 15000); heartbeat.unref();
    response.once("close", () => { clearInterval(heartbeat); channel.clients.delete(response); });
  }
  close(): void { clearInterval(this.poll); if (this.flushTimer) clearImmediate(this.flushTimer); this.pending = undefined;
    for (const entry of this.panelFrames.values()) if (entry.timer) clearTimeout(entry.timer);
    this.panelFrames.clear();
    for (const channel of this.channels.values()) for (const client of channel.clients) client.end(); this.channels.clear(); }
}
