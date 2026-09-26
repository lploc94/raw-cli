import type { Writable } from "node:stream";

export class TerminalWriter {
  private active = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  constructor(private readonly output: Writable, private readonly cursor: boolean,
    private readonly clock: { interval: typeof setInterval; clear: typeof clearInterval } = { interval: setInterval, clear: clearInterval }) {}

  write(value: string): void {
    this.suspend();
    this.output.write(value);
  }

  activity(label: string): void {
    this.suspend();
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

  finish(): void { this.suspend(); }
}
