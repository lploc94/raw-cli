import assert from "node:assert/strict";
import test from "node:test";
import jsQRModule from "jsqr";
import { renderQr } from "../src/dashboard/qr.js";

// jsqr ships CommonJS typings whose default export is the module itself under NodeNext.
const jsQR = jsQRModule as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

/** Reads the printed half-block text back into dark/light modules, quiet zone included, and decodes it as a camera would. */
function decodeText(text: string): string | undefined {
  const rows: boolean[][] = [];
  for (const line of text.split("\n")) {
    const top: boolean[] = []; const bottom: boolean[] = [];
    for (const ch of line) { top.push(ch === "█" || ch === "▀"); bottom.push(ch === "█" || ch === "▄"); }
    rows.push(top, bottom);
  }
  const scale = 4; const width = rows[0]!.length; const margin = 4; // an extra light margin only for the decoder's finder search
  const w = (width + 2 * margin) * scale; const h = (rows.length + 2 * margin) * scale;
  const pixels = new Uint8ClampedArray(w * h * 4).fill(255);
  rows.forEach((row, y) => row.forEach((dark, x) => { if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + margin) * scale + dy) * w + (x + margin) * scale + dx) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 0; } }));
  return jsQR(pixels, w, h)?.data;
}

const token = "cRxxXRAuzOcG6Af4foaIAv-YkV7-xrHHdByV9kYeNOg";
for (const input of [
  `https://eddie-incentive-combinations-understanding.trycloudflare.com/#token=${token}`,
  "http://127.0.0.1:21517/#token=a",
  `https://x.trycloudflare.com/#${"é".repeat(5)}`,
]) test(`the printed QR decodes to ${input.slice(0, 40)}`, () => {
  const text = renderQr(input);
  assert.match(text, /^[█▀▄ \n]+$/u);
  assert.equal(decodeText(text), input);
});

test("the QR has a 2-module quiet zone on every side and uses two rows per line", () => {
  const lines = renderQr("https://x.trycloudflare.com/#token=a").split("\n");
  assert.ok(lines.every((line) => [...line].length === [...lines[0]!].length));
  assert.ok(/^ +$/.test(lines[0]!) && /^ +$/.test(lines.at(-1)!)); // the first and last lines are quiet zone only
  assert.ok([...lines[0]!].slice(0, 2).every((ch) => ch === " ") && [...lines[0]!].slice(-2).every((ch) => ch === " "));
});

test("input beyond the largest QR capacity throws instead of printing a broken code", () => {
  assert.throws(() => renderQr("x".repeat(5000)));
});
