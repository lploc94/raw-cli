import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Safety bound for one saved output file: runaway output stops being saved, it never fails the tool. */
export const SPILL_MAX_BYTES = 64 * 1024 * 1024;
/** Safety bound for all files this process has saved; the oldest are deleted to make room for new ones. */
export const SPILL_TOTAL_BYTES = 1024 * 1024 * 1024;
const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const PREFIX = "raw-output-";

let directory: string | undefined;
let lastSweep = 0;
/** Files of this process, oldest first, with the bytes each holds. */
const saved: Array<{ path: string; bytes: number }> = [];
let savedBytes = 0;
let totalLimit = SPILL_TOTAL_BYTES;
/** Lowers the aggregate bound so tests can exercise eviction without writing a gigabyte. */
export function setSpillTotalBytesForTests(bytes: number): void { totalLimit = bytes; }

/** Bytes a result reserves for a saved-output path: the temp root plus this module's directory and file names. */
export const SPILL_PATH_RESERVE = tmpdir().length + 96;

/** Removes directories of earlier processes past retention; repeated hourly so a long-lived host keeps cleaning. */
function sweep(root: string): void {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  try {
    const cutoff = Date.now() - SPILL_RETENTION_MS;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(PREFIX)) continue;
      const path = join(root, name);
      if (path === directory) continue;
      try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true }); } catch { /* another owner or a race */ }
    }
  } catch { /* cleanup is best effort */ }
}

/** Private per-process directory. */
function spillDirectory(): string {
  const root = tmpdir();
  sweep(root);
  directory ??= mkdtempSync(join(root, PREFIX));
  return directory;
}

/** Keeps this process's saved files within SPILL_TOTAL_BYTES by deleting the oldest ones other than `keep`. */
function reserve(bytes: number, keep: { path: string; bytes: number }): void {
  savedBytes += bytes;
  keep.bytes += bytes;
  while (savedBytes > totalLimit) {
    const oldest = saved.find((entry) => entry !== keep);
    if (!oldest) break;
    saved.splice(saved.indexOf(oldest), 1);
    savedBytes -= oldest.bytes;
    try { rmSync(oldest.path, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Full copy of a tool output that was truncated before reaching the model. Writing is best effort: a failure leaves
 * `path` undefined and the truncated result unchanged.
 */
export class OutputSpill {
  private fd: number | undefined;
  private failed = false;
  private entry: { path: string; bytes: number } | undefined;
  path: string | undefined;
  bytes = 0;
  capped = false;

  constructor(private readonly label: string) {}

  write(data: Buffer | string): void {
    if (this.failed || this.capped) return;
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    try {
      if (this.fd === undefined) {
        const path = join(spillDirectory(), `${this.label}-${randomUUID().slice(0, 8)}.log`);
        this.fd = openSync(path, "wx", 0o600);
        this.path = path;
        this.entry = { path, bytes: 0 };
        saved.push(this.entry);
      }
      const room = SPILL_MAX_BYTES - this.bytes;
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      writeSync(this.fd, slice);
      this.bytes += slice.length;
      reserve(slice.length, this.entry!);
      if (slice.length < buffer.length) this.capped = true;
    } catch {
      this.failed = true;
      this.close();
      this.path = undefined;
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { /* already closed */ }
    this.fd = undefined;
  }
}

/** Saves `text` and returns where, or no path when it cannot be saved; `capped` when only its start fit. */
export function spillText(label: string, text: string): { path?: string; capped: boolean } {
  const spill = new OutputSpill(label);
  spill.write(text);
  spill.close();
  return { ...(spill.path ? { path: spill.path } : {}), capped: spill.capped };
}

/** How an omission marker names the saved copy: its path, flagged when the copy holds only the start. */
export function savedLabel(path: string | undefined, capped = false): string | undefined {
  return path && capped ? `${path} (first ${SPILL_MAX_BYTES} bytes only)` : path;
}

/** The model-facing note that a result was shortened and where the complete copy is. */
export function truncationNotice(keptBytes: number, totalBytes: number, path: string | undefined, capped = false): string {
  const where = path
    ? ` Full output saved to ${path}${capped ? ` (first ${SPILL_MAX_BYTES} bytes)` : ""}; read it with read_file (start_line/max_lines) or search it with grep if you need the omitted part.`
    : "";
  return `[Output truncated: showing ${keptBytes} of ${totalBytes} bytes.${where}]`;
}
