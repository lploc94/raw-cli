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
import { ArrowUp, ChevronDown, Square, Zap } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { AttachMenu } from "./AttachMenu.js";
import { transferLinks } from "./attachment-kinds.js";
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
  onInterrupt,
  onEditLast,
  providers,
  chips,
  onFiles,
  onPaths,
  controls,
  context,
  accept,
  note,
  noteTone,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  sendDisabled: boolean;
  sendMode: "enter" | "modifier";
  /** Present while an owned operation runs and the box is empty; replaces Send. */
  stop?: () => void;
  /**
   * Present while an owned operation runs: Send then queues, and Interrupt and send (the menu beside Send, or
   * Ctrl/⌘+Shift+Enter) stops the current step and sends (docs/chat-design.md §8).
   */
  onInterrupt?: () => void;
  /** Up in the empty box edits the last waiting message, when there is one. */
  onEditLast?: () => void;
  providers: SuggestionProvider[];
  /** Attachment chips, rendered above the message box. */
  chips: ReactNode;
  /** Files dropped, pasted or picked, with the link the browser gave for each (its source) when it gave one. */
  onFiles: (files: File[], sources?: (string | undefined)[]) => void;
  /** Local paths dropped without their bytes (a `file:` link from an editor such as VS Code). */
  onPaths?: (paths: string[]) => void;
  /** Request-controls pill, rendered in the toolbar after Add attachment. */
  controls?: ReactNode;
  /** The context button, rendered before Send/Stop. */
  context?: ReactNode;
  /** `accept` attribute for the file picker, from composer metadata. */
  accept: string;
  note?: string;
  /** `warning`: the note says something the user should act on, shown in the warning color. */
  noteTone?: "warning";
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

  // A drop with files, or with `file:` links only (an editor drags its files as links): both attach.
  const hasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files") || (!!onPaths && Array.from(event.dataTransfer.types).includes("text/uri-list")
      && !Array.from(event.dataTransfer.types).includes("text/html"));
  return (
    <>
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
        const files = Array.from(event.dataTransfer.files);
        const { links, sources } = transferLinks(event.dataTransfer, files);
        const paths = files.length ? [] : links.flatMap((link) => {
          try {
            const url = new URL(link);
            // A Windows path arrives as `/C:/…`.
            return url.protocol === "file:" ? [decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1")] : [];
          } catch { return []; }
        });
        // Links that are not local files (a web link, say) drop into the text as the browser would.
        if (!files.length && !paths.length) { setDragging(false); return; }
        event.preventDefault();
        setDragging(false);
        if (files.length) onFiles(files, sources);
        else onPaths?.(paths);
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
          onFiles(files, transferLinks(event.clipboardData, files).sources);
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
          if (event.key === "ArrowUp" && onEditLast && !draft && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            onEditLast();
            return;
          }
          if (event.key !== "Enter") return;
          const modifier = event.ctrlKey || event.metaKey;
          // Ctrl/⌘+Shift+Enter interrupts and sends while the agent works; when idle it sends, as Enter does.
          if (modifier && event.shiftKey) {
            event.preventDefault();
            if (!sendDisabled) (onInterrupt ?? onSend)();
            return;
          }
          if (event.shiftKey) return;
          if (sendMode === "modifier" && !modifier) return;
          event.preventDefault();
          onSend();
        }}
      />
      {note && <p className={`composer-note small ${noteTone === "warning" ? "composer-note-warning" : "muted"}`} {...(noteTone === "warning" ? { role: "status" } : {})}>{note}</p>}
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
          aria-label="Upload file"
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {controls}
        <span className="composer-spacer" />
        {context}
        {stop ? (
          <button type="button" className="composer-send stop" aria-label="Stop" title="Stop" onClick={stop}>
            <Square size={12} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <>
            <button
              type="submit"
              className="composer-send"
              aria-label="Send"
              title={onInterrupt ? "Send after the current step" : "Send"}
              disabled={sendDisabled}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
            {onInterrupt && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="icon-button composer-send-more"
                    aria-label="More send options"
                    title="More send options"
                    disabled={sendDisabled}
                  >
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="menu"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={8}
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      inputRef.current?.focus();
                    }}
                  >
                    <DropdownMenu.Item className="menu-item" disabled={sendDisabled} onSelect={onInterrupt}>
                      <Zap size={15} aria-hidden="true" /> Interrupt and send
                      <kbd className="menu-shortcut">Ctrl/⌘ Shift Enter</kbd>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </>
        )}
      </div>
    </div>
    {/* How to send, under the card; the message box refers to it (docs/chat-design.md §8). */}
    <p id={hintId} className="composer-hint">
      {onInterrupt
        ? sendMode === "enter"
          ? "Enter to send after the current step · Ctrl/⌘ Shift Enter to interrupt and send"
          : "Ctrl/⌘ Enter to send after the current step · Ctrl/⌘ Shift Enter to interrupt and send"
        : sendMode === "enter"
          ? "Enter to send · Shift Enter for a new line · / for commands"
          : "Ctrl/⌘ Enter to send · Enter for a new line · / for commands"}
    </p>
    </>
  );
}
