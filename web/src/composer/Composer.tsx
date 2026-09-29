import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { SuggestionPopover, optionId } from "./SuggestionPopover.js";
import { useAutoGrow } from "./useAutoGrow.js";
import type {
  SuggestionItem,
  SuggestionProvider,
  TriggerMatch,
} from "./suggestions.js";

export function Composer({
  inputRef,
  draft,
  onDraft,
  onSend,
  sendDisabled,
  sendMode,
  stop,
  providers,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  sendDisabled: boolean;
  sendMode: "enter" | "modifier";
  /** Present while an owned operation runs; replaces Send. */
  stop?: () => void;
  providers: SuggestionProvider[];
}) {
  const listId = useId();
  const hintId = useId();
  const composing = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const [loaded, setLoaded] = useState<{
    key: string;
    items: SuggestionItem[];
  }>({ key: "", items: [] });
  const [active, setActive] = useState(0);
  useAutoGrow(inputRef, draft);

  const found = useMemo(() => {
    for (const provider of providers) {
      const match = provider.match(draft, caret);
      if (match) return { provider, match };
    }
    return null;
  }, [providers, draft, caret]);
  const open = !!found && dismissed !== draft;
  const key = found ? `${found.provider.id}:${found.match.query}` : "";

  // One call per provider+query: synchronous lists are used directly so a keystroke never sees the previous query's list; a promise is awaited once.
  const result = useMemo(
    () => (found ? found.provider.items(found.match.query) : []),
    // `key` covers provider identity and query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, found?.provider],
  );
  const direct = Array.isArray(result) ? result : null;
  useEffect(() => {
    if (Array.isArray(result)) return;
    let live = true;
    result.then(
      (next) => live && setLoaded({ key, items: next }),
      () => live && setLoaded({ key, items: [] }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  const ready = direct !== null || loaded.key === key;
  const items = direct ?? (loaded.key === key ? loaded.items : []);
  useEffect(() => setActive(0), [key]);
  // Cap the popover to the room above the composer so it never leaves the viewport.
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const top = boxRef.current?.getBoundingClientRect().top ?? 0;
      setRoom(Math.max(96, Math.floor(top - 24)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, items.length]);

  // The caret is restored in a layout effect, and only while the draft is still exactly what the pick produced, so fast typing is never displaced.
  const pendingCaret = useRef<{ value: string; at: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const target = pendingCaret.current;
    pendingCaret.current = undefined;
    const element = inputRef.current;
    if (!target || !element || element.value !== target.value) return;
    element.focus();
    element.setSelectionRange(target.at, target.at);
    setCaret(target.at);
  }, [draft, inputRef]);
  const replace = (match: TriggerMatch) => (text: string) => {
    const next = draft.slice(0, match.start) + text + draft.slice(match.end);
    pendingCaret.current = { value: next, at: match.start + text.length };
    onDraft(next);
  };
  const pick = (item: SuggestionItem) => {
    if (!found || item.disabled) return;
    item.onSelect({ replace: replace(found.match) });
  };

  return (
    <div className="composer-box" ref={boxRef}>
      {open && found && (
        <SuggestionPopover
          id={listId}
          items={items}
          active={active}
          emptyText={ready ? found.provider.emptyText : ""}
          {...(room ? { maxHeight: room } : {})}
          onHover={setActive}
          onPick={pick}
        />
      )}
      <textarea
        ref={inputRef}
        aria-label="Message"
        aria-describedby={hintId}
        title={sendMode === "enter" ? "Enter to send · Shift-Enter for newline" : "Ctrl/⌘-Enter to send"}
        placeholder="Message your agent…"
        rows={1}
        value={draft}
        {...(open
          ? {
              // A textarea cannot take role=combobox (axe aria-allowed-role), so the listbox is wired with the attributes a textbox may carry.
              "aria-haspopup": "listbox" as const,
              "aria-controls": listId,
              "aria-autocomplete": "list" as const,
              ...(items.length
                ? { "aria-activedescendant": optionId(listId, active) }
                : {}),
            }
          : {})}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          onDraft(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (items.length) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((active + step + items.length) % items.length);
              }
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(draft);
              return;
            }
            if (
              (event.key === "Enter" && !event.shiftKey) ||
              (event.key === "Tab" && !event.shiftKey)
            ) {
              const item = items[active];
              if (item) {
                event.preventDefault();
                pick(item);
                return;
              }
              if (event.key === "Tab") return;
              // No matches: Enter falls through so `/unknown` sends verbatim.
            }
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          if (sendMode === "modifier" && !event.ctrlKey && !event.metaKey)
            return;
          event.preventDefault();
          onSend();
        }}
      />
      <span id={hintId} className="sr-only">
        {sendMode === "enter"
          ? "Enter to send, Shift-Enter for newline"
          : "Ctrl or Command-Enter to send"}
      </span>
      <div className="composer-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Add attachment"
          title="Add attachment"
          disabled
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <span className="composer-spacer" />
        {stop ? (
          <button type="button" className="stop" onClick={stop}>
            <Square size={14} aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={sendDisabled}>
            <ArrowUp size={17} aria-hidden="true" />
            Send
          </button>
        )}
      </div>
    </div>
  );
}
