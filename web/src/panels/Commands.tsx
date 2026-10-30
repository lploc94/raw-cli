import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowUpRight, AtSign, Ban, Check, CircleCheck, CircleX, Clock, Copy, Loader, Pause, Square, Unplug, type LucideIcon } from "lucide-react";
import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { ProcessOutput } from "../../../src/processes/contract.js";
import { api, errorText } from "../api.js";
import { FullOutput } from "../tool-cards/FullOutput.js";
import { formatDuration } from "../tool-cards/status.js";
import { CopyButton } from "../ui.js";
import { COMMAND_FILTERS, commandFilterOf, commandFilters, commandMatches, commandRunning, commandStatus, terminalText, type CommandFilter } from "./commands-state.js";
import type { InsertRef } from "./status.js";
const MAX_TEXT = 65536;


const ICONS: Record<CommandRecord["state"], LucideIcon> = {
  starting: Loader, running: Loader, stopping: Loader, exited: CircleCheck, failed: CircleX, timed_out: Clock, stopped: Ban, lost: Unplug,
};
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Copy the command line, unless only its first 4 KiB were kept: copying them would paste a different command. */
function CopyCommand({ item }: { item: CommandRecord }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  if (item.commandTruncated) return (
    <button type="button" className="command-action" aria-label="Copy command (unavailable: the command was cut at 4 KiB)" title="The command was cut at 4 KiB for display, so it cannot be copied" disabled>
      <Copy size={12} aria-hidden="true" />Copy
    </button>
  );
  return <>
    <button type="button" className="command-action" aria-label="Copy command" title="Copy command"
      onClick={() => void navigator.clipboard.writeText(item.command).then(() => { setCopied(true); setError(""); }, () => setError("Copy unavailable; select the text to copy it."))}>
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}Copy
      <span className="sr-only" role="status">{copied ? "Copied" : ""}</span>
    </button>
    {error && <span className="error-text">{error}</span>}
  </>;
}

/** The last lines of a foreground command; a failed card highlights its stderr lines. */
function Tail({ item }: { item: CommandRecord }) {
  if (!item.tail?.length) return null;
  return <div className="command-tail" role="group" aria-label="Last output lines">
    {item.tail.map((line, index) => <div key={index} className="command-tail-line" data-channel={line.channel} title={line.text}>
      {line.channel === "stderr" && <span className="sr-only">stderr: </span>}{line.text}
    </div>)}
  </div>;
}

/**
 * One command card (docs/side-panel-design.md §4). Running and failed commands show the whole card; a finished command
 * that succeeded, timed out, stopped or was lost is one compact row until its output is opened.
 */
function Command({ item, sessionId, sessionCwd, now, matches, selection, onInsert }: {
  /** `selection` counts the user's filter choices: each one, the current chip included, re-applies the filter. */
  item: CommandRecord; sessionId: string; sessionCwd?: string | undefined; now: number; matches: boolean; selection: number; onInsert: InsertRef;
}) {
  const card = useRef<HTMLLIElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const outputButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  // Follows new output while the reader stays at the bottom of the frame.
  const following = useRef(true);
  const [focused, setFocused] = useState(false);
  const [opened, setOpened] = useState(false);
  const [output, setOutput] = useState({ text: "", next: 0, truncated: false, channel: "" });
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | undefined>(undefined);
  const stopAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stopAbort.current?.abort(), []);
  const [page, setPage] = useState(0);
  const live = commandRunning(item);
  // A CLI's background task: the CLI keeps its output, and Raw can stop it only when the CLI allows.
  const cli = item.owner === "cli/claude-code" ? "Claude Code" : item.owner === "cli/codex" ? "Codex" : undefined;
  const wasLive = useRef(live);
  // A Stop button that disappears with the job hands focus to its card.
  useEffect(() => {
    if (wasLive.current && !live && focused && !card.current?.contains(document.activeElement)) card.current?.focus();
    wasLive.current = live;
  }, [live, focused]);
  // Opening a compact row swaps it for the whole card, and closing swaps it back: focus follows to the button that replaces it.
  const focusAfter = useRef<RefObject<HTMLButtonElement | null> | undefined>(undefined);
  useEffect(() => { focusAfter.current?.current?.focus(); focusAfter.current = undefined; }, [opened]);
  const url = `/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(item.id)}`;
  const latestCursor = useRef(item.cursor);
  latestCursor.current = item.cursor;
  useEffect(() => {
    if (!opened || cli) return;
    const abort = new AbortController();
    let pending = false;
    let failed = false;
    let cursor = output.next;
    const read = async (force = false) => {
      if (pending || failed || (!force && cursor >= latestCursor.current)) return;
      pending = true;
      try {
        const result = await api<ProcessOutput>(`${url}/output?cursor=${cursor}&maxBytes=16384`, "GET", undefined, abort.signal);
        if (abort.signal.aborted) return;
        cursor = result.nextCursor;
        setOutput(old => {
          // A channel label only where the channel changes, so streamed output reads as one terminal.
          let channel = old.channel;
          let text = old.text;
          for (const chunk of result.chunks) {
            if (chunk.channel !== channel) text += `${text && !text.endsWith("\n") ? "\n" : ""}[${chunk.channel}]\n`;
            channel = chunk.channel;
            text += terminalText(chunk.text);
          }
          return { text: text.slice(-MAX_TEXT), next: result.nextCursor, channel,
            truncated: old.truncated || result.truncated || result.droppedBytes > 0 || text.length > MAX_TEXT };
        });
        setError("");
      } catch (cause) { failed = true; if (!abort.signal.aborted) setError(errorText(cause)); }
      finally { pending = false; }
    };
    void read(true);
    // Serialize reads so a slow approval or output flood cannot create overlapping permission requests.
    const timer = setInterval(() => { void read(); }, 1000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [opened, page, url]);
  useLayoutEffect(() => {
    if (following.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output.text, opened]);
  const stop = async () => {
    const abort = new AbortController();
    stopAbort.current?.abort(); stopAbort.current = abort;
    requestId.current ??= crypto.randomUUID();
    setStopping(true); setError("");
    try {
      type Receipt = { id: string; state: string; result?: { content?: Array<{ type: string; text?: string }> } };
      const settled = (receipt: Receipt) => {
        setNotice(receipt.state === "completed" ? "Stop completed." : `Stop ${receipt.state}. ${receipt.result?.content?.map(c => c.text ?? "").join(" ") ?? ""}`);
        requestId.current = undefined;
      };
      const receipt = await api<Receipt>(`${url}/stop`, "POST", { clientRequestId: requestId.current }, abort.signal);
      if (receipt.state !== "running") settled(receipt);
      else setNotice("Stop requested. Check approval controls if approval is required.");
      // A receipt is an independent audited control, not a model operation.
      while (receipt.state === "running" && !abort.signal.aborted) {
        const result = await api<Receipt>(`${url}/controls/${encodeURIComponent(receipt.id)}`, "GET", undefined, abort.signal);
        if (result.state !== "running") { settled(result); break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (cause) { if (!abort.signal.aborted) setError(errorText(cause)); }
    finally { setStopping(false); }
  };
  const status = commandStatus(item);
  const Icon = status.tone === "failed" ? CircleX : item.paused && live ? Pause : ICONS[item.state];
  const commandLine = `${item.command}${item.commandTruncated ? "…" : ""}`;
  const name = item.label || commandLine;
  const duration = formatDuration((item.endedAt ?? now) - item.createdAt);
  const otherCwd = sessionCwd !== undefined && item.cwd !== sessionCwd;
  // A card in use stays in the current filter after its state changes; choosing another filter re-applies it.
  const inUse = opened || stopping || focused || !!notice || !!error;
  const shown = useRef({ selection, visible: matches });
  const visible = matches || (inUse && shown.current.visible && shown.current.selection === selection);
  shown.current = { selection, visible };
  const compact = status.compact && !opened;
  const notes = <>
    {item.error && !compact && <p className="command-note" role="note">{item.error}</p>}
    {cli && !compact && <p className="command-note" role="note">Output stays in {cli}</p>}
    {notice && <p className="command-note" role="status">{notice}</p>}
    {error && <p className="command-note error" role="alert">{error}</p>}
  </>;
  // A compact row already leads with the state's glyph: its chip is the word alone.
  const chip = <span className="command-chip" data-tone={status.tone}>
    {!compact && <Icon size={11} aria-hidden="true" className={status.tone === "running" && !item.paused ? "panel-spin" : undefined} />}{status.chip}
  </span>;
  return <li ref={card} tabIndex={-1} className="command-card" data-id={item.id} data-state={item.state} data-tone={status.tone} data-kind={item.kind} data-compact={compact || undefined} hidden={!visible}
    aria-label={`${name}: ${status.label}`}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    {compact ? <>
      <button ref={openButton} type="button" className="command-card-open" aria-expanded={false} title={item.error ? `${item.command}\n${item.error}` : item.command}
        onClick={() => { focusAfter.current = outputButton; setOpened(true); }}>
        <span className="command-card-glyph" data-tone={status.tone}><Icon size={14} aria-hidden="true" /><span className="sr-only">{status.label}</span></span>
        <span className="command-card-title">{name}</span>
        {status.tone !== "success" && chip}
        <span className="command-card-time">{duration}</span>
      </button>
      {item.label && <code className="command-card-sub" title={item.command}>{commandLine}</code>}
      {notes}
    </> : <>
      <div className="command-card-head">
        {chip}
        <span className="command-card-time">{live ? duration : `${duration} · ${clock(item.createdAt)}`}</span>
      </div>
      {item.label && <div className="command-card-title" title={item.label}>{item.label}</div>}
      <code className="command-card-line" title={item.command}>{commandLine}</code>
      {otherCwd && <div className="command-card-cwd" title={item.cwd}>in {item.cwd}</div>}
      <Tail item={item} />
      {notes}
      <div className="command-card-foot">
        <span className="command-card-kind">{live ? `${clock(item.createdAt)} · ${item.kind}` : ""}</span>
        {item.kind === "background" && live && item.canStop !== false && (
          // aria-disabled, not disabled: a disabled button drops focus, and the card keeps it while Stop settles.
          <button type="button" className="command-action danger" aria-label="Stop" title={`Stop ${name}`} aria-disabled={stopping || item.state === "stopping"}
            onClick={() => { if (!stopping && item.state !== "stopping") void stop(); }}>
            <Square size={11} aria-hidden="true" />Stop
          </button>
        )}
        {!live && <CopyCommand item={item} />}
        {item.fullOutputPath && (
          <button type="button" className="command-action icon" aria-label={`Insert @${item.fullOutputPath} into the message`} title={`Insert @${item.fullOutputPath} into the message`} onClick={() => onInsert(item.fullOutputPath!)}>
            <AtSign size={12} aria-hidden="true" />
          </button>
        )}
        {cli ? opened && status.compact && <button ref={outputButton} type="button" className="command-action" aria-expanded={true}
          onClick={() => { focusAfter.current = openButton; setOpened(false); }}>Less</button>
          : <OutputToggle button={outputButton} opened={opened} onToggle={() => {
            if (opened && status.compact) focusAfter.current = openButton;
            setOpened(!opened);
          }} />}
      </div>
    </>}
    {opened && !cli && <div className="terminal-frame command-output">
      <div className="terminal-bar">
        <span>{item.exitCode != null ? `exit ${item.exitCode}` : status.label}</span>
        <CopyButton value={output.text} label="Copy output" />
      </div>
      {output.truncated && <p className="command-note" role="note">Output truncated: older bytes were dropped or the display limit was reached.</p>}
      <pre ref={pre} tabIndex={0} aria-label={`Output for ${name}`}
        onScroll={event => { const el = event.currentTarget; following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4; }}>
        <code>{output.text || "No output yet."}</code>
      </pre>
      {output.next < item.cursor && <button type="button" className="command-more-output" onClick={() => setPage(value => value + 1)}>Load more output</button>}
    </div>}
    {opened && item.toolCallId && item.fullOutputPath && <FullOutput sessionId={sessionId} callId={item.toolCallId} />}
  </li>;
}

function OutputToggle({ button, opened, onToggle }: { button: RefObject<HTMLButtonElement | null>; opened: boolean; onToggle: () => void }) {
  return <button ref={button} type="button" className="command-action" aria-expanded={opened} onClick={onToggle}>
    <ArrowUpRight size={12} aria-hidden="true" />Output
  </button>;
}

/** The filter lives outside the tab body, so switching tabs or reloading keeps it. */
function useCommandFilter(sessionId: string): [CommandFilter, (filter: CommandFilter) => void] {
  const [prefs, setPrefs] = useState(commandFilters.get);
  return [commandFilterOf(prefs, sessionId), filter => setPrefs(commandFilters.set(sessionId, filter))];
}
const FILTER_LABELS: Record<CommandFilter, string> = { all: "All", running: "Running", failed: "Failed" };
const EMPTY: Record<CommandFilter, string> = { all: "No commands yet.", running: "Nothing is running.", failed: "No failed commands." };

/**
 * New cards are inserted above the one being read: keep that card where it was on screen. The browser's own scroll
 * anchoring is turned off on the tab content so the two never both adjust.
 */
function useScrollAnchor(list: RefObject<HTMLUListElement | null>, items: readonly CommandRecord[]) {
  const anchor = useRef<{ id: string; top: number } | undefined>(undefined);
  const measure = () => {
    const scroller = list.current?.closest(".sp-content");
    if (!scroller || !list.current) return;
    const top = scroller.getBoundingClientRect().top;
    const first = [...list.current.querySelectorAll<HTMLElement>(":scope > li.command-card:not([hidden])")].find(card => card.getBoundingClientRect().bottom > top);
    anchor.current = scroller.scrollTop > 0 && first ? { id: first.dataset.id!, top: first.getBoundingClientRect().top - top } : undefined;
  };
  useEffect(() => {
    const scroller = list.current?.closest(".sp-content");
    scroller?.addEventListener("scroll", measure, { passive: true });
    return () => scroller?.removeEventListener("scroll", measure);
  }, []);
  useLayoutEffect(() => {
    const scroller = list.current?.closest(".sp-content");
    const saved = anchor.current;
    if (scroller && saved) {
      const card = list.current?.querySelector<HTMLElement>(`:scope > li.command-card[data-id="${CSS.escape(saved.id)}"]`);
      if (card) scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.top;
    }
    measure();
  }, [items]);
}

export function Commands({ items, sessionId, sessionCwd, omitted = 0, onInsert }: {
  /** `omitted`: older commands the server left out of `items`. */
  items: readonly CommandRecord[]; sessionId: string; sessionCwd?: string | undefined; omitted?: number | undefined; onInsert: InsertRef;
}) {
  const [now, setNow] = useState(Date.now);
  const live = items.some(commandRunning);
  useEffect(() => { if (!live) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [live]);
  const [filter, setFilter] = useCommandFilter(sessionId);
  const [selection, setSelection] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  useScrollAnchor(list, items);
  // Running commands first, then the others under "Earlier"; newest first in each. A card that finishes moves below the
  // label, and the scroll anchor keeps the card being read in place.
  const newest = (a: CommandRecord, b: CommandRecord) => b.createdAt - a.createdAt || b.id.localeCompare(a.id);
  const running = items.filter(commandRunning).sort(newest);
  const earlier = items.filter((item) => !commandRunning(item)).sort(newest);
  const split = running.some((item) => commandMatches(item, filter)) && earlier.some((item) => commandMatches(item, filter));
  const counts = Object.fromEntries(COMMAND_FILTERS.map(value => [value, items.filter(item => commandMatches(item, value)).length])) as Record<CommandFilter, number>;
  if (!items.length && !omitted) return <div className="commands"><p className="muted small">No commands yet.</p></div>;
  return <div className="commands">
    <div className="command-filter" role="group" aria-label="Filter commands">
      {COMMAND_FILTERS.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setSelection(count => count + 1); }}>
        {`${FILTER_LABELS[value]} ${counts[value]}`}
      </button>)}
    </div>
    {!counts[filter] && <p className="muted small command-empty">{EMPTY[filter]}</p>}
    <ul ref={list} className="commands-list">
      {[...running, ...earlier].map((item, index) => <Fragment key={`${sessionId}:${item.id}`}>
        {index === running.length && split && <li className="command-group-label">Earlier</li>}
        <Command item={item} sessionId={sessionId} sessionCwd={sessionCwd} now={now}
          matches={commandMatches(item, filter)} selection={selection} onInsert={onInsert} />
      </Fragment>)}
    </ul>
    {omitted > 0 && <p className="command-more">Older commands not shown</p>}
  </div>;
}
