import { textWidth } from "../../src/terminal/layout.js";

// Small screen model for assertions about Raw's cursor ownership. It intentionally
// recognizes only the SGR, erase-line, cursor-up, CR, and newline forms we emit.
export function terminalScreen(source: string, width = 80): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let column = 0;
  const ensure = () => { while (rows.length <= row) rows.push([]); };
  for (let i = 0; i < source.length;) {
    if (source[i] === "\x1b" && source[i + 1] === "[") {
      const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(source.slice(i));
      if (!match) throw new Error("unknown cursor escape");
      i += match[0].length;
      if (match[2] === "m") continue;
      if (match[2] === "K" && (match[1] === "2" || match[1] === "")) { rows[row] = []; column = 0; continue; }
      if (match[2] === "A") { row = Math.max(0, row - Number(match[1] || "1")); column = 0; continue; }
      throw new Error(`unsupported cursor escape ${match[0]}`);
    }
    const point = String.fromCodePoint(source.codePointAt(i)!);
    i += point.length;
    if (point === "\r") { column = 0; continue; }
    if (point === "\n") { row++; column = 0; ensure(); continue; }
    const cells = Math.max(0, textWidth(point));
    if (column + cells > width && column > 0) { row++; column = 0; ensure(); }
    rows[row]![column] = point;
    for (let cell = 1; cell < cells; cell++) rows[row]![column + cell] = "";
    column += cells;
  }
  return rows.map((line) => line.join("").replace(/\s+$/, ""));
}
