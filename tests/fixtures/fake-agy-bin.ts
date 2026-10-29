import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAKE = join(import.meta.dirname, "fake-agy.mjs");
const RECORDINGS = join(import.meta.dirname, "agy");

/** An `agy` in `root/bin` that is the fake (a .cmd on Windows; a copy reading the recordings from here elsewhere). */
export function fakeAgy(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") { writeFileSync(join(bin, "agy.cmd"), `@"${process.execPath}" "${FAKE}" %*\r\n`); return join(bin, "agy.cmd"); }
  writeFileSync(join(bin, "agy"), readFileSync(FAKE, "utf8").replace("const recordings = join(dirname(fileURLToPath(import.meta.url)), \"agy\");",
    `const recordings = ${JSON.stringify(RECORDINGS)};`));
  chmodSync(join(bin, "agy"), 0o755);
  return join(bin, "agy");
}
