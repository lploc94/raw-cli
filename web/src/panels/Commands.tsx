import { useEffect, useRef, useState } from "react";
import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { ProcessOutput } from "../../../src/processes/contract.js";
import { api, errorText } from "../api.js";
import { commandRunning, terminalText } from "./commands-state.js";
import { formatDuration } from "./panel-state.js";
const MAX_TEXT = 65536;
function Command({ item, sessionId, now, expanded }: { item: CommandRecord; sessionId: string; now: number; expanded: boolean }) {
  const row = useRef<HTMLLIElement>(null);
  const [focused, setFocused] = useState(false);
  const [opened, setOpened] = useState(false);
  const [output, setOutput] = useState({ text: "", next: 0, truncated: false });
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | undefined>(undefined);
  const stopAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stopAbort.current?.abort(), []);
  const [page, setPage] = useState(0);
  const live = commandRunning(item);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && focused) row.current?.focus();
    wasLive.current = live;
  }, [live, focused]);
  const url = `/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(item.id)}`;
  const latestCursor = useRef(item.cursor);
  latestCursor.current = item.cursor;
  useEffect(() => {
    if (!opened) return;
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
          const text = old.text + result.chunks.map(chunk => `[${chunk.channel}]\n${terminalText(chunk.text)}`).join("");
          return { text: text.slice(-MAX_TEXT), next: result.nextCursor, truncated: old.truncated || result.truncated || result.droppedBytes > 0 || text.length > MAX_TEXT };
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
  return <li ref={row} tabIndex={-1} className="command-row" hidden={!live && !expanded && !opened && !stopping && !focused}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <strong>{item.label || item.command}</strong>
    {item.label && <code>{item.command}</code>}
    <div><small>{item.kind} · {item.state} · {formatDuration((item.endedAt ?? now) - item.createdAt)}{item.exitCode != null ? ` · exit ${item.exitCode}` : ""}{item.signal ? ` · ${item.signal}` : ""}</small></div>
    <div><small>{item.cwd}</small></div>
    {item.error && <p role="note">{item.error}</p>}
    <button type="button" aria-expanded={opened} onClick={() => setOpened(value => !value)}>Output</button>
    {item.kind === "background" && live && <button type="button" disabled={stopping || item.state === "stopping"} onClick={() => void stop()}>Stop</button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {opened && <div className="command-output">
      {output.truncated && <p role="note">Output truncated: older bytes were dropped or the display limit was reached.</p>}
      <pre tabIndex={0} aria-label={`Output for ${item.label || item.command}`}>{output.text || "No output yet."}</pre>
      {output.next < item.cursor && <button type="button" onClick={() => setPage(value => value + 1)}>Load more output</button>}
    </div>}
  </li>;
}
export function Commands({ items, sessionId }: { items: readonly CommandRecord[]; sessionId: string }) {
  const [now, setNow] = useState(Date.now);
  const running = items.filter(commandRunning);
  const done = items.filter(item => !commandRunning(item));
  useEffect(() => { if (!running.length) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running.length > 0]);
  const [expanded, setExpanded] = useState(false);
  return <div>{!items.length && <p>No commands yet.</p>}<ul className="commands-list">
    {[...running.map(item => <Command key={`${sessionId}:${item.id}`} item={item} sessionId={sessionId} now={now} expanded={expanded} />),
      ...(done.length ? [<li key="completed-heading"><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Completed commands ({done.length})</button></li>] : []),
      ...done.map(item => <Command key={`${sessionId}:${item.id}`} item={item} sessionId={sessionId} now={now} expanded={expanded} />)]}
  </ul></div>;
}
