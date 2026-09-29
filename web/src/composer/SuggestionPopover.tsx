import type { SuggestionItem } from "./suggestions.js";

export const optionId = (listId: string, index: number) =>
  `${listId}-option-${index}`;

export function SuggestionPopover({
  id,
  items,
  active,
  emptyText,
  maxHeight,
  onHover,
  onPick,
}: {
  id: string;
  items: SuggestionItem[];
  active: number;
  emptyText: string;
  maxHeight?: number;
  onHover: (index: number) => void;
  onPick: (item: SuggestionItem) => void;
}) {
  return (
    <div
      className="suggestions"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <ul id={id} role="listbox" aria-label="Suggestions">
        {items.map((item, index) => (
          <li
            key={item.id}
            id={optionId(id, index)}
            role="option"
            aria-selected={index === active}
            aria-disabled={item.disabled ? true : undefined}
            className={`suggestion ${index === active ? "active" : ""}`}
            onMouseMove={() => onHover(index)}
            // Keep focus in the textarea while picking with the pointer.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
          >
            <span className="suggestion-label">{item.label}</span>
            <span className="suggestion-detail">
              {item.disabled ?? item.description}
            </span>
          </li>
        ))}
      </ul>
      {!items.length && emptyText && <p className="suggestion-empty">{emptyText}</p>}
      <span className="sr-only" role="status" aria-live="polite">
        {items.length
          ? `${items.length} ${items.length === 1 ? "result" : "results"}`
          : "0 results"}
      </span>
    </div>
  );
}
