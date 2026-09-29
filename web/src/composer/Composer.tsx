import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { AttachMenu } from "./AttachMenu.js";
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
  chips,
  onFiles,
  controls,
  accept,
  note,
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
  /** Attachment chips, rendered above the message box. */
  chips: ReactNode;
  onFiles: (files: File[]) => void;
  /** Request-controls pill, rendered in the toolbar before Send/Stop. */
  controls?: ReactNode;
  /** `accept` attribute for the file picker, from composer metadata. */
  accept: string;
  note?: string;
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
  const call = useMemo(() => {
    const controller = new AbortController();
    return {
      controller,
      result: found
        ? found.provider.items(found.match.query, controller.signal)
        : [],
    };
    // `key` covers provider identity and query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, found?.provider]);
  const result = call.result;
  const direct = Array.isArray(result) ? result : null;
  useEffect(() => {
    // A superseded query aborts its request; the promise's rejection is handled below.
    const controller = call.controller;
    let live = true;
    if (!Array.isArray(result))
      result.then(
        (next) => live && setLoaded({ key, items: next }),
        () => live && setLoaded({ key, items: [] }),
      );
    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call]);
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const insert = (next: string, at: number) => {
    pendingCaret.current = { value: next, at };
    onDraft(next);
  };
  const insertReference = () => {
    const at = inputRef.current?.selectionStart ?? draft.length;
    const lead = at > 0 && !/\s/.test(draft[at - 1]!) ? " " : "";
    insert(draft.slice(0, at) + lead + "@" + draft.slice(at), at + lead.length + 1);
  };
  const insertCommands = () => insert("/" + draft, 1);
  const pick = (item: SuggestionItem) => {
    if (!found || item.disabled) return;
    item.onSelect({ replace: replace(found.match) });
  };

  const hasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");
  return (
    <div
      className={`composer-box ${dragging ? "dragging" : ""}`}
      ref={boxRef}
      onDragEnter={(event) => hasFiles(event) && setDragging(true)}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop to attach
        </div>
      )}
      {chips}
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
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          // Text that travels with the files (a copied spreadsheet range, say) still pastes normally.
          if (!event.clipboardData.getData("text/plain"))
            event.preventDefault();
          onFiles(files);
        }}
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
      {note && <p className="composer-note muted small">{note}</p>}
      <div className="composer-toolbar">
        <AttachMenu
          onUpload={() => fileInput.current?.click()}
          onReference={insertReference}
          onCommands={insertCommands}
          onClosed={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={accept}
          aria-label="Upload image"
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <span className="composer-spacer" />
        {controls}
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
