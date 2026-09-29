import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Folder, Link2 } from "lucide-react";
import { api, errorText } from "../api.js";
import { ErrorMessage, Field, Modal } from "../ui.js";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string; symlink?: boolean }>;
  truncated: boolean;
}

/**
 * "Open folder": a read-only, folders-only browser backed by `GET /api/workspaces/browse`, plus a typed path.
 * Open this folder always validates what is in the path field on the server, whether or not browsing works.
 */
export function FolderBrowser({
  open,
  onOpenChange,
  initialPath,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  initialPath: string;
  onOpen: (cwd: string) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Open folder"
      description="Choose the folder to work in. Only folders are listed; nothing is created or changed."
      className="folder-dialog"
    >
      <FolderBrowserBody initialPath={initialPath} onOpen={onOpen} />
    </Modal>
  );
}

const query = (path: string | undefined, hidden: boolean, filter: string) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (hidden) params.set("hidden", "1");
  if (filter) params.set("q", filter);
  const text = params.toString();
  return `/workspaces/browse${text ? `?${text}` : ""}`;
};

function FolderBrowserBody({ initialPath, onOpen }: { initialPath: string; onOpen: (cwd: string) => void }) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<Listing | undefined>();
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const shown = useRef<string | undefined>(undefined);
  /** The directory most recently asked for, which may still be loading. */
  const requested = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const openings = useRef(0);
  const applied = useRef("");
  const edited = useRef(false);

  /** Lists `target`; a newer request always wins over one still in flight. */
  const browse = (target: string | undefined, options: { hidden: boolean; filter: string; fallbackHome?: boolean; keepText?: boolean }) => {
    const mine = ++sequence.current;
    applied.current = options.filter;
    requested.current = target;
    if (!options.keepText) edited.current = false;
    const controller = new AbortController();
    setLoading(true);
    void api<Listing>(query(target, options.hidden, options.filter), "GET", undefined, controller.signal).then(
      (value) => {
        if (mine !== sequence.current) return;
        shown.current = value.path;
        setListing(value);
        if (!edited.current) setPath(value.path);
        setError("");
        setLoading(false);
      },
      (cause) => {
        if (mine !== sequence.current) return;
        if (options.fallbackHome) {
          browse(undefined, { hidden: options.hidden, filter: options.filter, keepText: true });
          return;
        }
        requested.current = shown.current ?? requested.current; // later refreshes update what is still on screen
        edited.current = true; // the text that failed stays until the user navigates or edits it
        setError(errorText(cause));
        setLoading(false);
      },
    );
  };
  useEffect(() => {
    browse(initialPath || undefined, { hidden: false, filter: "", fallbackHome: true });
    return () => {
      sequence.current++;
      openings.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dialog body mounts once per opening
  }, []);
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    if (filter === applied.current) return;
    const timer = setTimeout(() => refresh({ hidden, filter }), 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the filter changes
  }, [filter]);

  /** Re-lists the directory most recently asked for (even while it is still loading) with new filter or hidden settings. */
  const refresh = (next: { hidden: boolean; filter: string }) =>
    browse(requested.current, { ...next, keepText: true, ...(shown.current === undefined && requested.current !== undefined ? { fallbackHome: true } : {}) });
  const navigate = (target: string) => {
    setFilter("");
    browse(target, { hidden, filter: "" });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    browse(path, { hidden, filter });
  };
  const openHere = () => {
    const mine = ++openings.current;
    setOpening(true);
    void api<{ cwd: string }>("/workspaces/validate", "POST", { cwd: path }).then(
      (value) => {
        if (mine === openings.current) onOpen(value.cwd);
      },
      (cause) => {
        if (mine !== openings.current) return;
        setError(errorText(cause));
        setOpening(false);
      },
    );
  };
  return (
    <div className="folder-browser">
      <ErrorMessage>{error}</ErrorMessage>
      <form onSubmit={submit} className="folder-bar">
        <Field label="Workspace directory">
          <input value={path} onChange={(event) => {
              edited.current = true;
              setPath(event.target.value);
            }} spellCheck={false} autoComplete="off" />
        </Field>
        <button type="submit" className="folder-go" disabled={!path.trim() || path === listing?.path} title="Open the typed path in the list below">
          Go
        </button>
      </form>
      <div className="folder-tools">
        <button type="button" className="icon-button" aria-label="Parent folder" disabled={!listing?.parent} onClick={() => listing?.parent && navigate(listing.parent)}>
          <ArrowUp size={16} aria-hidden="true" />
        </button>
        <label className="folder-filter">
          <span className="sr-only">Filter folders</span>
          <input type="search" placeholder="Filter folders" aria-label="Filter folders" value={filter} onChange={(event) => setFilter(event.target.value)} autoComplete="off" />
        </label>
        <label className="folder-hidden">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => {
              setHidden(event.target.checked);
              refresh({ hidden: event.target.checked, filter });
            }}
          />
          Show hidden folders
        </label>
      </div>
      <div className="folder-list" aria-busy={loading}>
        {listing && listing.entries.length > 0 && (
          <ul>
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" className="folder-entry" onClick={() => navigate(entry.path)}>
                  <Folder size={16} aria-hidden="true" />
                  <span className="folder-name">{entry.name}</span>
                  {entry.symlink && (
                    <span className="folder-link" title="Symbolic link">
                      <Link2 size={13} aria-hidden="true" />
                      <span className="sr-only">symbolic link</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing && listing.entries.length === 0 && !loading && <p className="muted folder-note">No subfolders</p>}
        {!listing && loading && <p className="muted folder-note">Loading…</p>}
        {listing?.truncated && <p className="muted folder-note">Showing the first 500 folders. Filter the list or type a path.</p>}
      </div>
      <div className="folder-actions">
        <button type="button" className="primary" onClick={openHere} disabled={opening}>
          Open this folder
        </button>
      </div>
    </div>
  );
}
