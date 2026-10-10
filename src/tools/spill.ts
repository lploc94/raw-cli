import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Safety bound for one saved output file: runaway output stops being saved, it never fails the tool. */
export const SPILL_MAX_BYTES = 64 * 1024 * 1024;
const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = "raw-output-";

let directory: string | undefined;

/** Bytes a result reserves for a saved-output path: the temp root plus this module's directory and file names. */
export const SPILL_PATH_RESERVE = tmpdir().length + 64;

/** Private per-process directory; earlier processes' directories past retention are removed once. */
function spillDirectory(): string {
  if (directory) return directory;
  const root = tmpdir();
  try {
    const cutoff = Date.now() - SPILL_RETENTION_MS;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(PREFIX)) continue;
      const path = join(root, name);
      try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true }); } catch { /* another owner or a race */ }
    }
  } catch { /* cleanup is best effort */ }
  directory = mkdtempSync(join(root, PREFIX));
  return directory;
}

/**
 * Full copy of a tool output that was truncated before reaching the model. Writing is best effort: a failure leaves
 * `path` undefined and the truncated result unchanged.
 */
export class OutputSpill {
  private fd: number | undefined;
  private failed = false;
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
      }
      const room = SPILL_MAX_BYTES - this.bytes;
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      writeSync(this.fd, slice);
      this.bytes += slice.length;
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

/** Saves `text` whole and returns its path, or undefined when it cannot be saved. */
export function spillText(label: string, text: string): string | undefined {
  const spill = new OutputSpill(label);
  spill.write(text);
  spill.close();
  return spill.path;
}

/** The model-facing note that a result was shortened and where the complete copy is. */
export function truncationNotice(keptBytes: number, totalBytes: number, path: string | undefined, capped = false): string {
  const where = path
    ? ` Full output saved to ${path}${capped ? ` (first ${SPILL_MAX_BYTES} bytes)` : ""}; read it with read_file (start_line/max_lines) or search it with grep if you need the omitted part.`
    : "";
  return `[Output truncated: showing ${keptBytes} of ${totalBytes} bytes.${where}]`;
}
