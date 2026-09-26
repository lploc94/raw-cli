import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function textWidth(value: string): number { return stringWidth(value); }

export function wrapText(value: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const result: string[] = [];
  let line = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    if (segment === "\n") { result.push(line); line = ""; used = 0; continue; }
    const cells = textWidth(segment);
    if (used > 0 && used + cells > limit) { result.push(line); line = ""; used = 0; }
    line += segment;
    used += cells;
  }
  result.push(line);
  return result;
}

export function wrapStyled(value: string, width: number): string[] {
  return wrapAnsi(value, Math.max(1, Math.floor(width)), { hard: true, trim: false, wordWrap: true }).split("\n");
}
