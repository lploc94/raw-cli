import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DashboardError } from "./errors.js";

export interface LiveSegment {
  segmentId: string; operationId: string; kind: "assistant" | "reasoning"; turnId?: string;
  text: string; bytes: number; paged: boolean; unavailable?: string;
}
interface Spool { view: LiveSegment; path: string }
const PAGE_BYTES = 64 * 1024;
const PREVIEW_BYTES = 8192;
const MAX_OPERATION_BYTES = 64 * 1024 * 1024;
export class LiveOutput {
  private readonly directory: string;
  private readonly segments = new Map<string, Spool>();
  private readonly sizes = new Map<string, number>();
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(root).slice(0, 1000)) {
      const pid = /^(\d+)-/.exec(name)?.[1]; if (!pid) continue;
      try { process.kill(Number(pid), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(root, name), { recursive: true, force: true }); }
    }
    this.directory = mkdtempSync(join(root, `${process.pid}-`));
  }
  append(operationId: string, segmentId: string, kind: LiveSegment["kind"], text: string, turnId?: string): LiveSegment {
    let item = this.segments.get(segmentId);
    if (!item) {
      item = { path: join(this.directory, randomUUID()), view: { segmentId, operationId, kind, ...(turnId ? { turnId } : {}), text: "", bytes: 0, paged: false } };
      this.segments.set(segmentId, item);
    }
    const bytes = Buffer.byteLength(text); const total = (this.sizes.get(operationId) ?? 0) + bytes;
    this.sizes.set(operationId, total);
    const view = item.view; view.bytes += bytes;
    if (!view.unavailable) {
      if (total > MAX_OPERATION_BYTES) view.unavailable = "Live preview reached its 64 MiB limit; committed history remains available after the turn";
      else try { appendFileSync(item.path, text, { mode: 0o600 }); }
      catch { view.unavailable = "Live preview storage is unavailable; wait for committed history"; }
    }
    if (!view.paged && Buffer.byteLength(view.text) + bytes <= PREVIEW_BYTES) view.text += text;
    else view.paged = true;
    return { ...view };
  }
  list(operationIds: ReadonlySet<string>): LiveSegment[] { return [...this.segments.values()].filter((item) => operationIds.has(item.view.operationId)).map((item) => ({ ...item.view })); }
  read(operationId: string, segmentId: string, offset: number): { text: string; offset: number; nextOffset: number; bytes: number; done: boolean } {
    const item = this.segments.get(segmentId);
    if (!item || item.view.operationId !== operationId) throw new DashboardError(404, "output_unavailable", "Live output has committed or is unavailable; refresh history");
    if (item.view.unavailable) throw new DashboardError(409, "output_unavailable", item.view.unavailable);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.view.bytes) throw new DashboardError(400, "invalid_offset", "Invalid UTF-8 byte offset");
    const fd = openSync(item.path, "r"); const buffer = Buffer.alloc(PAGE_BYTES + 4); let length: number;
    try { length = readSync(fd, buffer, 0, Math.min(buffer.length, item.view.bytes - offset), offset); }
    finally { closeSync(fd); }
    if (length && (buffer[0]! & 0xc0) === 0x80) throw new DashboardError(400, "invalid_offset", "Offset must be on a UTF-8 character boundary");
    let end = Math.min(length, PAGE_BYTES);
    if (end < length) while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    return { text: buffer.subarray(0, end).toString("utf8"), offset, nextOffset: offset + end, bytes: item.view.bytes, done: offset + end === item.view.bytes };
  }
  removeSegment(id: string): void { const item = this.segments.get(id); if (item) { rmSync(item.path, { force: true }); this.segments.delete(id); } }
  finish(operationId: string): void { for (const [id, item] of this.segments) if (item.view.operationId === operationId) this.removeSegment(id); this.sizes.delete(operationId); }
  close(): void { this.segments.clear(); this.sizes.clear(); rmSync(this.directory, { recursive: true, force: true }); }
}
