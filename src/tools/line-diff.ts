/** A unified line diff for display: hunks with context around each change, built and rendered within a byte budget. */

import { utf8Prefix } from "./results.js";

const CONTEXT_LINES = 3;
/** Above this many LCS cells the changed middle is aligned greedily on the nearest matching line instead. */
const MAX_CELLS = 1_000_000;
/** Marks a last line without a trailing newline so that adding or removing the final newline is a visible change. */
const NO_EOL = "\u0000";

interface Op { kind: " " | "-" | "+"; text: string; oldAt: number; newAt: number }

function lines(text: string): string[] {
  if (!text) return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  else split[split.length - 1] += NO_EOL;
  return split;
}

/** First index >= `from` in the ascending `positions`, or Infinity. */
function nextAt(positions: readonly number[] | undefined, from: number): number {
  if (!positions) return Infinity;
  let low = 0;
  let high = positions.length;
  while (low < high) { const mid = (low + high) >> 1; if (positions[mid]! < from) low = mid + 1; else high = mid; }
  return low < positions.length ? positions[low]! : Infinity;
}

/** Streams the edit script to `emit` until it returns false; `oldAt`/`newAt` count each side's lines before the op. */
function operations(before: readonly string[], after: readonly string[], emit: (op: Op) => boolean): void {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endOld = before.length;
  let endNew = after.length;
  while (endOld > start && endNew > start && before[endOld - 1] === after[endNew - 1]) { endOld--; endNew--; }
  // Unchanged lines farther than the context window from any change can never be shown.
  for (let index = Math.max(0, start - CONTEXT_LINES); index < start; index++) if (!emit({ kind: " ", text: before[index]!, oldAt: index, newAt: index })) return;
  const n = endOld - start;
  const m = endNew - start;
  const old = (i: number) => before[start + i]!;
  const neu = (j: number) => after[start + j]!;
  let i = 0;
  let j = 0;
  const step = (kind: Op["kind"]): boolean => {
    const op = { kind, text: kind === "+" ? neu(j) : old(i), oldAt: start + i, newAt: start + j };
    if (kind !== "+") i++;
    if (kind !== "-") j++;
    return emit(op);
  };
  if (n && m && n * m <= MAX_CELLS) {
    const width = m + 1;
    const common = new Uint32Array((n + 1) * width);
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) {
      common[a * width + b] = old(a) === neu(b) ? common[(a + 1) * width + b + 1]! + 1
        : Math.max(common[(a + 1) * width + b]!, common[a * width + b + 1]!);
    }
    while (i < n || j < m) {
      const kind = i < n && j < m && old(i) === neu(j) ? " "
        : i < n && (j === m || common[(i + 1) * width + j]! >= common[i * width + j + 1]!) ? "-" : "+";
      if (!step(kind)) return;
    }
  } else {
    // Greedy alignment: skip to whichever side's next occurrence of the other's current line is nearer.
    const index = (count: number, line: (k: number) => string) => {
      const positions = new Map<string, number[]>();
      for (let k = 0; k < count; k++) { const list = positions.get(line(k)); if (list) list.push(k); else positions.set(line(k), [k]); }
      return positions;
    };
    const inOld = index(n, old);
    const inNew = index(m, neu);
    while (i < n && j < m) {
      if (old(i) === neu(j)) { if (!step(" ")) return; continue; }
      const added = nextAt(inNew.get(old(i)), j) - j;
      const removed = nextAt(inOld.get(neu(j)), i) - i;
      if (added === Infinity && removed === Infinity) { if (!step("-") || !step("+")) return; }
      else if (added <= removed) { for (let k = 0; k < added; k++) if (!step("+")) return; }
      else for (let k = 0; k < removed; k++) if (!step("-")) return;
    }
    while (i < n) if (!step("-")) return;
    while (j < m) if (!step("+")) return;
  }
  for (let index = 0; index < Math.min(CONTEXT_LINES, before.length - endOld); index++) {
    if (!emit({ kind: " ", text: before[endOld + index]!, oldAt: endOld + index, newAt: endNew + index })) return;
  }
}

/**
 * Unified hunks (`@@ -a,b +c,d @@`) showing each changed region with three lines of context, in at most
 * `budgetBytes` of UTF-8. Each line keeps its `-`/`+`/space marker and is prefixed by `indent`.
 */
export function unifiedDiff(before: string, after: string, budgetBytes: number, indent = ""): { text: string; truncated: boolean } {
  const out: string[] = [];
  let bytes = 0;
  let truncated = false;
  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size <= budgetBytes) { out.push(line); bytes += size; return true; }
    // A line longer than what is left shows the start that fits; nothing after it is shown.
    const cut = utf8Prefix(line, budgetBytes - bytes - Buffer.byteLength("…", "utf8") - 1).text;
    if (cut.length > indent.length + 1) { out.push(`${cut}…`); bytes += Buffer.byteLength(`${cut}…`, "utf8") + 1; }
    truncated = true;
    return false;
  };
  const render = (hunk: readonly Op[]): boolean => {
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    const first = hunk[0]!;
    if (!push(`${indent}@@ -${first.oldAt + (oldCount ? 1 : 0)},${oldCount} +${first.newAt + (newCount ? 1 : 0)},${newCount} @@`)) return false;
    for (const op of hunk) {
      const ending = op.text.endsWith(NO_EOL);
      if (!push(`${indent}${op.kind}${ending ? op.text.slice(0, -1) : op.text}`)) return false;
      if (ending && !push(`${indent}\\ No newline at end of file`)) return false;
    }
    return true;
  };
  let leading: Op[] = [];
  let hunk: Op[] | undefined;
  let hunkBytes = 0;
  let trailing = 0;
  operations(lines(before), lines(after), (op) => {
    if (op.kind === " ") {
      if (!hunk) { leading.push(op); if (leading.length > CONTEXT_LINES) leading.shift(); return true; }
      hunk.push(op);
      // Changes at most two context windows apart share a hunk; past that the hunk closes after its own context.
      if (++trailing <= 2 * CONTEXT_LINES) return true;
      const closed = hunk.splice(0, hunk.length - trailing + CONTEXT_LINES);
      leading = hunk.slice(-CONTEXT_LINES);
      hunk = undefined;
      return render(closed);
    }
    if (!hunk) { hunk = leading; leading = []; hunkBytes = 0; }
    hunk.push(op);
    trailing = 0;
    // A hunk too large for what is left of the budget is rendered as far as it fits, and nothing more is built.
    hunkBytes += Buffer.byteLength(op.text, "utf8") + indent.length + 2;
    if (bytes + hunkBytes <= budgetBytes) return true;
    render(hunk);
    hunk = undefined;
    truncated = true;
    return false;
  });
  if (hunk && !truncated) render(hunk.slice(0, hunk.length - Math.max(0, trailing - CONTEXT_LINES)));
  return { text: out.join("\n"), truncated };
}
