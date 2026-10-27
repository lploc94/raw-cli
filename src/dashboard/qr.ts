import { encode } from "uqr";

const QUIET_ZONE = 2;
/**
 * Renders `text` as a QR code in terminal half-block characters (two module rows per line) with a 2-module quiet zone.
 * Throws when the text exceeds the largest QR capacity, so the caller can print the link alone.
 */
export function renderQr(text: string): string {
  const { data } = encode(text, { ecc: "L", border: 0 });
  const size = data.length + 2 * QUIET_ZONE;
  const dark = (y: number, x: number) => data[y - QUIET_ZONE]?.[x - QUIET_ZONE] === true;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = dark(y, x); const bottom = dark(y + 1, x);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
