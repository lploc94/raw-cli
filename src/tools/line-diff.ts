/** A unified line diff for display: hunks with context around each change, bounded in bytes. */

const CONTEXT_LINES = 3;
/** Above this many LCS cells the changed middle is shown as removed-then-added instead of aligned line by line. */
const MAX_CELLS = 1_000_000;
const MAX_LINE_CHARS = 500;

interface Op { kind: " " | "-" | "+"; text: string; oldAt: number; newAt: number }

function lines(text: string): string[] {
  if (!text) return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

/** Edit script between two line arrays; `oldAt`/`newAt` count the lines of each side consumed before the op. */
function operations(before: readonly string[], after: readonly string[]): Op[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endOld = before.length;
  let endNew = after.length;
  while (endOld > start && endNew > start && before[endOld - 1] === after[endNew - 1]) { endOld--; endNew--; }
  const ops: Op[] = [];
  // Unchanged lines farther than the context window from any change can never be shown.
  for (let index = Math.max(0, start - CONTEXT_LINES); index < start; index++) ops.push({ kind: " ", text: before[index]!, oldAt: index, newAt: index });
  const removed = before.slice(start, endOld);
  const added = after.slice(start, endNew);
  const n = removed.length;
  const m = added.length;
  if (n && m && n * m <= MAX_CELLS) {
    const width = m + 1;
    const common = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      common[i * width + j] = removed[i] === added[j] ? common[(i + 1) * width + j + 1]! + 1
        : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      const at = { oldAt: start + i, newAt: start + j };
      if (i < n && j < m && removed[i] === added[j]) { ops.push({ kind: " ", text: removed[i]!, ...at }); i++; j++; }
      else if (i < n && (j === m || common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) { ops.push({ kind: "-", text: removed[i]!, ...at }); i++; }
      else { ops.push({ kind: "+", text: added[j]!, ...at }); j++; }
    }
  } else {
    removed.forEach((text, index) => ops.push({ kind: "-", text, oldAt: start + index, newAt: start }));
    added.forEach((text, index) => ops.push({ kind: "+", text, oldAt: endOld, newAt: start + index }));
  }
  for (let index = 0; index < Math.min(CONTEXT_LINES, before.length - endOld); index++) {
    ops.push({ kind: " ", text: before[endOld + index]!, oldAt: endOld + index, newAt: endNew + index });
  }
  return ops;
}

/**
 * Unified hunks (`@@ -a,b +c,d @@`) showing each changed region with three lines of context, in at most
 * `budgetBytes` of UTF-8. Each line keeps its `-`/`+`/space marker and is prefixed by `indent`.
 */
export function unifiedDiff(before: string, after: string, budgetBytes: number, indent = ""): { text: string; truncated: boolean } {
  const ops = operations(lines(before), lines(after));
  const changed = ops.flatMap((op, index) => op.kind === " " ? [] : [index]);
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = hunks.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out: string[] = [];
  let bytes = 0;
  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > budgetBytes) return false;
    out.push(line); bytes += size; return true;
  };
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const first = slice[0]!;
    if (!push(`${indent}@@ -${first.oldAt + (oldCount ? 1 : 0)},${oldCount} +${first.newAt + (newCount ? 1 : 0)},${newCount} @@`)) return { text: out.join("\n"), truncated: true };
    for (const op of slice) {
      const chars = [...op.text];
      const text = chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS).join("")}…` : op.text;
      if (!push(`${indent}${op.kind}${text}`)) return { text: out.join("\n"), truncated: true };
    }
  }
  return { text: out.join("\n"), truncated: false };
}
