import { api } from "../api.js";
import type { SuggestionProvider } from "./suggestions.js";

/** `@` at a word start opens workspace file suggestions. */
export function matchAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const found = /(^|\s)@(\S*)$/.exec(before);
  if (!found) return null;
  const query = found[2]!;
  return { start: before.length - query.length - 1, end: caret, query };
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });

/** Debounced (150 ms) search; a superseded query aborts its request. */
export function fileProvider(
  sessionId: string,
  addRef: (path: string) => void,
): SuggestionProvider {
  return {
    id: "files",
    emptyText: "No matching files",
    match: matchAt,
    items: async (query, signal) => {
      await wait(150, signal);
      const result = await api<{ items: Array<{ path: string; name: string }> }>(
        `/sessions/${encodeURIComponent(sessionId)}/files?q=${encodeURIComponent(query)}&limit=20`,
        "GET",
        undefined,
        signal,
      );
      return result.items.map((hit) => ({
        id: `file:${hit.path}`,
        label: hit.name,
        description: hit.path,
        onSelect: ({ replace }) => {
          replace("");
          addRef(hit.path);
        },
      }));
    },
  };
}
