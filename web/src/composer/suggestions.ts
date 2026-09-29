// Generic suggestion model: a provider owns one trigger character and turns the text before the caret into a list of items.
export interface SuggestionContext {
  /** Replace the trigger text (`/comp`) with `text`, keeping the rest of the draft. */
  replace: (text: string) => void;
}

export interface SuggestionItem {
  id: string;
  label: string;
  description?: string;
  /** Reason shown for an item that cannot run now; a disabled item is listed but never selected. */
  disabled?: string;
  onSelect: (context: SuggestionContext) => void;
}

export interface TriggerMatch {
  start: number;
  end: number;
  query: string;
}

export interface SuggestionProvider {
  id: string;
  emptyText: string;
  /** Returns the active trigger in `text` before `caret`, or null. */
  match: (text: string, caret: number) => TriggerMatch | null;
  /** `signal` aborts when the query is superseded; synchronous providers ignore it. */
  items: (
    query: string,
    signal?: AbortSignal,
  ) => SuggestionItem[] | Promise<SuggestionItem[]>;
}

/** Subsequence match; lower score is better, null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  if (!needle) return 0;
  const direct = hay.indexOf(needle);
  if (direct >= 0) return direct;
  let at = 0;
  let score = 100;
  for (const char of needle) {
    const found = hay.indexOf(char, at);
    if (found < 0) return null;
    score += found - at;
    at = found + 1;
  }
  return score;
}

export function fuzzyFilter<T extends { label: string; description?: string }>(
  items: T[],
  query: string,
): T[] {
  if (!query) return items;
  return items
    .map((item, order) => ({
      item,
      order,
      score: fuzzyScore(query, item.label),
      // Descriptions only match as a plain substring so short queries stay precise.
      fallback: (item.description ?? "").toLowerCase().includes(query.toLowerCase()) ? 0 : null,
    }))
    .filter((entry) => entry.score !== null || entry.fallback !== null)
    .sort(
      (a, b) =>
        (a.score ?? 1000 + (a.fallback ?? 0)) -
          (b.score ?? 1000 + (b.fallback ?? 0)) || a.order - b.order,
    )
    .map((entry) => entry.item);
}
