import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronRight, FileImage, FileText, Folder, FolderOpen, RotateCw, Search } from "lucide-react";
import type { WorkspaceFileText } from "../../../src/dashboard/files.js";
import { MAX_TEXT_BYTES } from "../../../src/dashboard/limits.js";
import { api, blobDataUrl, errorText, fetchBlob } from "../api.js";
import { keys } from "../data/keys.js";
import { useWorkspaceFiles } from "../data/queries.js";
import { ancestorFolders, buildTree, countFiles, fileKind, filterTree, type TreeFolder } from "../files/tree.js";
import { CodeBlock, Markdown } from "../markdown.js";
import { useRouter } from "../router.js";
import { usePageGate } from "../states.js";
import { CopyButton, Empty, ErrorMessage } from "../ui.js";

/** The languages the code block can highlight; anything else falls back to plain text. */
const LANGUAGE: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json", md: "md", markdown: "md",
  css: "css", html: "html", py: "py", rb: "rb", rs: "rs", go: "go", sh: "sh", bash: "sh", yml: "yaml",
  yaml: "yaml", toml: "toml", sql: "sql", java: "java", kt: "kotlin", php: "php", swift: "swift",
};

const languageOf = (path: string): string => LANGUAGE[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

/** One folder's children: folders first, then files, with each branch rendered only while it is open. */
function FolderRows({ node, open, toggle, selected, onOpen }: {
  node: TreeFolder; open: ReadonlySet<string>; toggle: (path: string) => void; selected: string; onOpen: (path: string) => void;
}) {
  return (
    <ul className="files-tree-list">
      {node.folders.map((folder) => {
        const expanded = open.has(folder.path);
        const Glyph = expanded ? FolderOpen : Folder;
        return (
          <li key={folder.path} className="files-tree-item">
            <button type="button" className="files-tree-row" data-folder={folder.path} aria-expanded={expanded} onClick={() => toggle(folder.path)}>
              <ChevronRight size={14} aria-hidden="true" className="files-tree-chevron" />
              <Glyph size={14} aria-hidden="true" />
              <span className="files-tree-name">{folder.name}</span>
            </button>
            {expanded && <FolderRows node={folder} open={open} toggle={toggle} selected={selected} onOpen={onOpen} />}
          </li>
        );
      })}
      {node.files.map((file) => {
        const Glyph = fileKind(file.path) === "image" ? FileImage : FileText;
        return (
          <li key={file.path} className="files-tree-item">
            <button
              type="button"
              className="files-tree-row"
              data-file={file.path}
              title={file.path}
              aria-current={file.path === selected ? "true" : undefined}
              onClick={() => onOpen(file.path)}
            >
              <Glyph size={14} aria-hidden="true" />
              <span className="files-tree-name">{file.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Above this, the text is shown without syntax highlighting: a megabyte through the highlighter blocks the page. */
const HEAVY_TEXT = 200_000;

/** The file itself: text or code, Markdown as source or preview, a raster image, or the reason it is not shown. */
function FileView({ workspace, path, tick, onRetry }: { workspace: string; path: string; tick: number; onRetry: () => void }) {
  const kind = fileKind(path);
  const [mode, setMode] = useState<"source" | "preview">("source");
  const [image, setImage] = useState<{ url: string; bytes: number } | { failed: true } | undefined>(undefined);
  const text = useSWR<WorkspaceFileText>(
    kind === "image" ? null : [keys.workspaceFile(workspace, path), tick],
    ([url]) => api<WorkspaceFileText>(url),
    { dedupingInterval: 0, keepPreviousData: false, shouldRetryOnError: false },
  );
  useEffect(() => {
    setMode("source");
    if (kind !== "image") { setImage(undefined); return; }
    // The request is aborted when the selection changes, so a slow image can never land under another file's name.
    const controller = new AbortController();
    setImage(undefined);
    // A data URL, not an object URL: the dashboard's CSP allows `img-src 'self' data:` and blocks `blob:`.
    void fetchBlob(keys.workspaceImage(workspace, path), controller.signal)
      .then(async (blob) => ({ url: await blobDataUrl(blob), bytes: blob.size }))
      .then((shown) => { if (!controller.signal.aborted) setImage(shown); })
      .catch(() => { if (!controller.signal.aborted) setImage({ failed: true }); });
    return () => controller.abort();
  }, [workspace, path, kind, tick]);

  if (kind === "image") {
    if (!image) return <p className="files-page-hint">Loading…</p>;
    if ("failed" in image) return <p className="files-page-hint" data-files-notice>This image cannot be shown.</p>;
    return (
      <div className="files-image">
        <img data-files-image src={image.url} alt={path.split("/").pop() ?? path} onError={() => setImage({ failed: true })} />
        <p className="files-summary" data-files-image-size>{image.bytes} bytes</p>
      </div>
    );
  }
  if (text.error) return (
    <div className="files-view-message">
      <ErrorMessage>{errorText(text.error)}</ErrorMessage>
      <button type="button" className="foot-button" onClick={onRetry}>Retry</button>
    </div>
  );
  if (!text.data) return <p className="files-page-hint">Loading…</p>;
  if ("binary" in text.data) return <p className="files-page-hint" data-files-notice>binary file, {text.data.bytes} bytes, not shown</p>;
  const cut = text.data.truncated
    ? <p className="files-page-hint" data-files-notice>Showing the first {MAX_TEXT_BYTES / (1024 * 1024)} MiB of {text.data.bytes} bytes</p>
    : null;
  const heavy = text.data.text.length > HEAVY_TEXT;
  const body = heavy
    ? <pre className="files-plain" tabIndex={0}>{text.data.text}</pre>
    : <CodeBlock code={text.data.text} language={kind === "markdown" ? "md" : languageOf(path)} />;
  const tools = (
    <div className="files-view-tools">
      <CopyButton value={text.data.text} label="Copy contents" />
      {heavy && <span className="files-page-hint">Large file: shown without highlighting</span>}
      {kind === "markdown" && !heavy && (
        <div className="files-modes" role="group" aria-label="Markdown view">
          <button type="button" className="foot-button" aria-pressed={mode === "source"} onClick={() => setMode("source")}>Source</button>
          <button type="button" className="foot-button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
        </div>
      )}
    </div>
  );
  if (kind === "markdown" && !heavy) return (
    <>
      {cut}
      {tools}
      {mode === "preview" ? <div className="files-markdown"><Markdown>{text.data.text}</Markdown></div> : <CodeBlock code={text.data.text} language="md" />}
    </>
  );
  return <>{cut}{tools}{body}</>;
}

/**
 * The Files tab: a read-only tree of the selected workspace with a filter and the file it opens. The listing is the
 * same git-aware view the agent's `@` references use, so the two never disagree.
 */
export function FilesPage({ workspace }: { workspace: string }) {
  const { path, navigate } = useRouter();
  const selected = useMemo(() => {
    const query = path.indexOf("?");
    return new URLSearchParams(query < 0 ? "" : path.slice(query + 1)).get("path") ?? "";
  }, [path]);
  const { data, error, mutate } = useWorkspaceFiles(workspace);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [tick, setTick] = useState(0);
  const previousWorkspace = useRef(workspace);
  const resettingWorkspace = useRef(false);
  const reload = async () => {
    setTick((value) => value + 1);
    if (!workspace) return;
    try {
      await mutate(api(keys.workspaceFiles(workspace, true)), { revalidate: false });
    } catch {
      // SWR stores the failure on the current key; the page gate/viewer renders it on the next pass.
    }
  };
  const gate = usePageGate({ ready: !!data, error, onRetry: () => void reload(), label: "Loading files" });
  const tree = useMemo(() => buildTree((data?.entries ?? []).map((entry) => entry.path)), [data]);
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = query.trim() !== "";
  const matches = countFiles(shown);
  const toggle = (folder: string) => setOpen((old) => {
    const next = new Set(old);
    if (!next.delete(folder)) next.add(folder);
    return next;
  });
  const openFile = (file: string) => {
    if (file === selected) setTick((value) => value + 1);
    navigate(`/files?path=${encodeURIComponent(file)}`);
  };
  useEffect(() => {
    const previous = previousWorkspace.current;
    previousWorkspace.current = workspace;
    if (!previous || !workspace || previous === workspace) return;
    resettingWorkspace.current = true;
    setQuery("");
    setOpen(new Set());
    setTick(0);
    if (selected) navigate("/files");
    else resettingWorkspace.current = false;
  }, [workspace, navigate, selected]);
  // The file in the address opens the folders leading to it, without closing what the reader opened.
  useEffect(() => {
    if (resettingWorkspace.current) {
      resettingWorkspace.current = false;
      return;
    }
    if (!selected) return;
    const ancestors = ancestorFolders(selected);
    if (!ancestors.length) return;
    setOpen((old) => new Set([...old, ...ancestors]));
  }, [selected]);
  // A filter really opens the folders that lead to its matches, rather than claiming to: the disclosure buttons
  // keep telling the truth about what a click would do.
  useEffect(() => {
    if (!filtering) return;
    const folders: string[] = [];
    const walk = (node: TreeFolder) => {
      for (const child of node.folders) { folders.push(child.path); walk(child); }
    };
    walk(shown);
    if (!folders.length) return;
    setOpen((old) => (folders.some((folder) => !old.has(folder)) ? new Set([...old, ...folders]) : old));
  }, [shown, filtering]);
  if (gate || !data) return gate;
  const listing = data;
  return (
    <div className="files-page">
      <header className="page-header">
        <h1>Files</h1>
        <span className="workspace-path" title={workspace}>{workspace}</span>
        <button type="button" className="foot-button" onClick={() => void reload()} title="Read the listing and the open file again">
          <RotateCw size={14} aria-hidden="true" />
          Reload
        </button>
      </header>
      {listing.total === 0 && !selected ? (
        <Empty title="This workspace has no files">
          The agent sees the same view through @ references, so there is nothing here to point it at.
        </Empty>
      ) : (
        <div className="files-panes">
          <div className="files-pane files-tree-pane">
            <label className="search-input files-filter">
              <Search size={14} aria-hidden="true" />
              <input aria-label="Filter files" placeholder="Filter by path…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            {filtering && (
              <p className="files-summary">
                {matches} of {listing.entries.length} {listing.truncated ? "files shown" : "files"}
              </p>
            )}
            {listing.truncated && <p className="files-summary">Showing {listing.entries.length} of {listing.total} files</p>}
            {matches === 0 ? (
              <p className="files-page-hint">{listing.total === 0 ? "No files are listed in this workspace" : "No file matches the filter"}</p>
            ) : (
              <div className="files-tree" data-files-tree>
                <FolderRows node={shown} open={open} toggle={toggle} selected={selected} onOpen={openFile} />
              </div>
            )}
          </div>
          <section className="files-pane files-viewer-pane" data-files-viewer aria-label={selected ? `File ${selected}` : "No file chosen"}>
            {selected ? (
              <>
                <div className="files-viewer-head">
                  <span className="files-viewer-name" title={selected}>{selected.split("/").pop()}</span>
                  <span className="files-viewer-path" title={selected}>{selected}</span>
                  <CopyButton value={selected} label="Copy path" />
                </div>
                <FileView key={`${workspace}:${selected}`} workspace={workspace} path={selected} tick={tick} onRetry={() => void reload()} />
              </>
            ) : (
              <p className="files-page-hint">Choose a file to read it here.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** The context panel's Files section: which workspace the tab is showing. */
export function FilesNav({ workspace }: { workspace: string }) {
  return (
    <nav aria-label="Files" className="context-nav">
      <div className="group-label">Files</div>
      <p className="files-nav-path" title={workspace}>
        {workspace}
      </p>
    </nav>
  );
}
