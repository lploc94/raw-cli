import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { DropdownMenu, Popover } from "radix-ui";
import { Check, Copy, EyeOff, Folder, FolderOpen, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { api, ApiError, errorText } from "../api.js";
import {
  arrange,
  baseName,
  batchPaths,
  chatsLabel,
  displayPath,
  filterRows,
  hide,
  includePaths,
  mergeItems,
  recordOpened,
  relativeTime,
  togglePin,
  type WorkspaceItem,
  type WorkspaceRow,
  type WorkspaceState,
} from "./workspace-state.js";

interface Listing {
  items: WorkspaceItem[];
  home: string;
}
type Row = WorkspaceRow & { isCurrent: boolean };

const query = (paths: string[]) => (paths.length ? `?${paths.map((path) => `include=${encodeURIComponent(path)}`).join("&")}` : "");

/**
 * The sidebar workspace button and its switcher popover: the current workspace, pinned and recent ones, a filter and an Open folder action.
 * Every row is re-validated on the server before it is chosen, because the listed existence can be stale.
 */
export function WorkspaceSwitcher({
  current,
  state,
  onState,
  activityRevision,
  onChoose,
  onOpenFolder,
}: {
  current: string;
  state: WorkspaceState;
  onState: (update: (old: WorkspaceState) => WorkspaceState) => void;
  activityRevision: number;
  onChoose: (cwd: string) => void;
  onOpenFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [home, setHome] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(state);
  latest.current = state;
  const sequence = useRef(0);
  const selection = useRef(0);
  const content = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    try {
      const groups = batchPaths(includePaths(latest.current));
      const responses = await Promise.all((groups.length ? groups : [[]]).map((paths) => api<Listing>(`/workspaces${query(paths)}`)));
      if (mine !== sequence.current) return;
      setItems(mergeItems(responses.map((response) => response.items)));
      setHome(responses[0]?.home ?? "");
      setMissing(new Set());
      setError("");
    } catch (cause) {
      if (mine === sequence.current) {
        setItems([]);
        setError(`Could not load workspaces. ${errorText(cause)}`);
      }
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (open) void load();
    else sequence.current++;
  }, [open, activityRevision, load]);
  useEffect(() => {
    if (!open) {
      selection.current++;
      setBusy(false);
      setFilter("");
      setNotice("");
    }
  }, [open]);

  const shown = arrange(
    items.map((item) => (missing.has(item.cwd) ? { ...item, exists: false } : item)),
    state,
    current,
  );
  const mark = (row: WorkspaceRow): Row => ({ ...row, isCurrent: row.cwd === current });
  const groups = [
    { id: "current", title: "Current", rows: [mark(shown.current)] },
    { id: "pinned", title: "Pinned", rows: filterRows(shown.pinned, filter).map(mark) },
    { id: "recent", title: "Recent", rows: filterRows(shown.recent, filter).map(mark) },
  ].map((group) => (group.id === "current" ? { ...group, rows: filterRows(group.rows, filter) } : group)).filter((group) => group.rows.length);
  const hasRows = groups.length > 0;

  const choose = async (row: Row) => {
    if (busy) return;
    if (row.isCurrent) {
      setOpen(false);
      return;
    }
    if (!row.exists) return;
    const mine = ++selection.current;
    setBusy(true);
    setNotice("");
    try {
      const value = await api<{ cwd: string }>("/workspaces/validate", "POST", { cwd: row.cwd });
      if (mine !== selection.current) return;
      onState((old) => recordOpened(old, value.cwd, Date.now()));
      onChoose(value.cwd);
      setOpen(false);
    } catch (cause) {
      if (mine !== selection.current) return;
      if (cause instanceof ApiError && cause.code === "invalid_workspace") {
        setMissing((old) => new Set(old).add(row.cwd));
        setNotice(`${baseName(row.cwd)} was not found. It can be removed from the list.`);
      } else setNotice(errorText(cause));
    } finally {
      if (mine === selection.current) setBusy(false);
    }
  };
  const copy = (row: Row) => {
    const unavailable = () => setNotice("Copy unavailable; select the path to copy it.");
    try {
      void navigator.clipboard.writeText(row.cwd).then(() => setNotice(`Copied ${row.cwd}`), unavailable);
    } catch {
      unavailable();
    }
  };
  const focusables = () => Array.from(content.current?.querySelectorAll<HTMLElement>("[data-row-main]") ?? []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const inFilter = target === filterInput.current;
    if (!inFilter && !target.hasAttribute("data-row-main")) return;
    const stops = focusables();
    const index = stops.indexOf(target);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stops[inFilter ? 0 : Math.min(index + 1, stops.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (inFilter) return;
      if (index <= 0) filterInput.current?.focus();
      else stops[index - 1]?.focus();
    } else if (event.key === "Enter" && inFilter) {
      const first = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row-main]") ?? []).find((stop) => stop.getAttribute("aria-disabled") !== "true");
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button ref={trigger} className="workspace-button" title={current}>
          <Folder size={17} aria-hidden="true" />
          <span>
            <strong>Workspace</strong>
            <small>{baseName(current)}</small>
          </span>
          <span className="muted" aria-hidden="true">
            ⌄
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal container={trigger.current?.closest<HTMLElement>('[role="dialog"]') ?? undefined}>
        <Popover.Content
          ref={content}
          className="workspace-popover"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Switch workspace"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            filterInput.current?.focus();
          }}
          onKeyDown={onKeyDown}
        >
          <input
            ref={filterInput}
            className="workspace-filter"
            type="search"
            aria-label="Filter workspaces"
            placeholder="Filter by name or path"
            autoComplete="off"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {error && (
            <div className="workspace-message error-text" role="alert">
              {error}
            </div>
          )}
          <div className="workspace-notice" role="status">
            {notice}
          </div>
          <div className="workspace-list" ref={list} aria-busy={loading}>
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`workspace-group-${group.id}`}>
                <h2 id={`workspace-group-${group.id}`} className="workspace-group-title">
                  {group.title}
                </h2>
                <ul>
                  {group.rows.map((row) => (
                    <WorkspaceRowView
                      key={row.cwd}
                      row={row}
                      home={home}
                      onChoose={() => void choose(row)}
                      onPin={() => onState((old) => togglePin(old, row.cwd))}
                      onCopy={() => copy(row)}
                      onRemove={() => onState((old) => hide(old, row.cwd))}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {!hasRows && <p className="workspace-message muted">No matching workspaces</p>}
          </div>
          <button
            type="button"
            className="workspace-open-folder"
            data-row-main
            onClick={() => {
              selection.current++;
              trigger.current?.focus();
              setOpen(false);
              onOpenFolder();
            }}
          >
            <FolderOpen size={16} aria-hidden="true" />
            <span>Open folder…</span>
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WorkspaceRowView({
  row,
  home,
  onChoose,
  onPin,
  onCopy,
  onRemove,
}: {
  row: Row;
  home: string;
  onChoose: () => void;
  onPin: () => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const name = baseName(row.cwd);
  const when = relativeTime(row.rank, Date.now());
  const meta = !row.exists ? "Folder not found" : [chatsLabel(row.sessions), when].filter(Boolean).join(" · ");
  return (
    <li className="workspace-row" data-missing={!row.exists || undefined}>
      <button
        type="button"
        className="workspace-row-main"
        data-row-main
        aria-disabled={!row.exists || undefined}
        aria-current={row.isCurrent ? "true" : undefined}
        title={row.cwd}
        onClick={() => {
          if (row.exists || row.isCurrent) onChoose();
        }}
      >
        {row.isCurrent ? <Check size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
        <span className="workspace-row-text">
          <strong>{name}</strong>
          <small className="workspace-row-path">{displayPath(row.cwd, home)}</small>
          <small className="workspace-row-meta">{meta}</small>
        </span>
        {row.running > 0 && <span className="workspace-badge running">Running</span>}
        {!row.exists && <span className="workspace-badge missing">Missing</span>}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={row.pinned ? `Unpin ${name}` : `Pin ${name}`}
        aria-pressed={row.pinned}
        onClick={onPin}
      >
        {row.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="icon-button" aria-label={`More actions for ${name}`}>
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={4} collisionPadding={8}>
            <DropdownMenu.Item className="workspace-menu-item" onSelect={onCopy}>
              <Copy size={14} aria-hidden="true" /> Copy path
            </DropdownMenu.Item>
            {!row.isCurrent && (
              <DropdownMenu.Item className="workspace-menu-item" onSelect={onRemove}>
                <EyeOff size={14} aria-hidden="true" /> Remove from recent
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}
