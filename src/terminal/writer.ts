import type { Writable } from "node:stream";
import { textWidth } from "./layout.js";

export class TerminalWriter {
  private active = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private tail = "";
  constructor(private readonly output: Writable, private readonly cursor: boolean,
    private readonly clock: { interval: typeof setInterval; clear: typeof clearInterval } = { interval: setInterval, clear: clearInterval },
    private readonly columns = 80) {}

  write(value: string): void {
    this.suspend();
    this.clearTail();
    this.output.write(value);
  }

  replaceTail(value: string): void {
    if (!this.cursor) { this.write(value); return; }
    this.suspend();
    this.clearTail();
    if (value) this.output.write(value);
    this.tail = value;
  }

  clearTail(): void {
    if (!this.tail || !this.cursor) { this.tail = ""; return; }
    const plain = this.tail.replace(/\x1b\[[0-9;]*m/g, "");
    const logical = plain.split("\n");
    const rows = logical.reduce((sum, line, index) => sum + (index === logical.length - 1 && line === "" ? 0
      : Math.max(1, Math.ceil(textWidth(line) / Math.max(1, this.columns)))), 0);
    const up = Math.max(0, rows - (plain.endsWith("\n") ? 0 : 1));
    if (up) this.output.write(`\x1b[${up}A`);
    for (let index = 0; index < rows; index++) {
      this.output.write("\r\x1b[2K");
      if (index < rows - 1) this.output.write("\x1b[1B");
    }
    if (rows > 1) this.output.write(`\x1b[${rows - 1}A`);
    this.output.write("\r");
    this.tail = "";
  }

  activity(label: string): void {
    this.suspend();
    this.clearTail();
    if (!this.cursor) { this.output.write(`${label}\n`); return; }
    const frames = ["◌", "◐", "◓", "◑"];
    const draw = () => { this.output.write(`\r\x1b[2K${frames[this.frame++ % frames.length]} ${label}`); };
    this.active = true;
    draw();
    this.timer = this.clock.interval(draw, 160);
  }

  suspend(): void {
    if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined; }
    if (this.active) { this.output.write("\r\x1b[2K"); this.active = false; }
  }

  finish(): void { this.suspend(); this.clearTail(); }
}
