import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Tabs } from "radix-ui";
import { FilePlus, GitFork, Trash2 } from "lucide-react";
import type { ComponentInfo } from "../../../../src/management/components.js";
import { api, errorText } from "../../api.js";
import { useConfig } from "../../data/queries.js";
import { DraftActions, SourceEditor, useDraft, type DraftDocument } from "../../editors/shared.js";
import { Markdown } from "../../markdown.js";
import { Link, useRouter } from "../../router.js";
import { Skeleton, SkeletonRegion } from "../../states.js";
import { ErrorMessage, Field, Modal } from "../../ui.js";
import { ActionMenu } from "../../ui/ActionMenu.js";
import { kindCopy, sourceLabel, type ComponentKind } from "./ComponentsList.js";
import { UsedByCard } from "./UsedByCard.js";

type Section = "overview" | "source";
type Action = "fork" | "add" | "delete";
const dirtyReason = "Save or discard changes first";
const entryFile: Record<ComponentKind, string> = { tools: "tool.json", skills: "SKILL.md", hooks: "hook.json" };

export function ComponentDetail({
  kind,
  id,
  changed,
  refresh,
}: {
  kind: ComponentKind;
  id: string;
  changed: () => Promise<void>;
  /** Refreshes the catalog list. */
  refresh: () => Promise<void>;
}) {
  const endpoint = `/components/${kind}/${encodeURIComponent(id)}`;
  const { data: info, error: infoError, mutate: mutateInfo } = useSWR<ComponentInfo>(endpoint);
  const { data: config, error: configError, mutate: mutateConfig } = useConfig();
  // Local state, not the URL: every navigation while dirty opens the leave guard.
  const [section, setSection] = useState<Section>("overview");
  const [action, setAction] = useState<Action>();
  const [file, setFile] = useState(entryFile[kind]);
  const [fileIsNew, setFileIsNew] = useState(false);
  const url = `${endpoint}/file?path=${encodeURIComponent(file)}`;
  // The file whose contents the draft holds; the editor waits for it so a new file never starts from the previous one.
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const draft = useDraft(
    url,
    () =>
      (fileIsNew ? Promise.resolve({ source: "", revision: "missing" }) : api<DraftDocument>(url)).then((value) => {
        // A late response for a file the user already left must not claim the editor.
        if (currentUrl.current === url) setLoadedUrl(url);
        return value;
      }),
    (value) => api<DraftDocument>(url, "PUT", value),
    async () => {
      setFileIsNew(false);
      await mutateInfo();
      await refresh();
    },
  );
  const readOnly = info?.readOnly ?? true;
  const disabledReason = draft.dirty ? dirtyReason : undefined;
  const copy = kindCopy[kind];
  const panel = (value: Section) => ({
    value,
    forceMount: true as const,
    hidden: section !== value,
    className: "detail-panel",
  });
  return (
    <div className="management-page component-detail">
      <header className="detail-header">
        <nav aria-label="Breadcrumb" className="page-breadcrumb">
          <Link href="/library">Library</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/library/${kind}`}>{copy.title}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{id}</span>
        </nav>
        <div className="detail-title">
          <div>
            <h1>{id}</h1>
            {info && (
              <div className="metadata">
                <span className="badge">{sourceLabel[info.source] ?? info.source}</span>
                {info.readOnly && <span className="badge">Read-only</span>}
                {info.validation !== "valid" && <span className="badge error">Invalid</span>}
              </div>
            )}
          </div>
          {info && (
            <div className="actions">
              {info.readOnly && (
                <button className="primary" disabled={!!disabledReason} title={disabledReason} onClick={() => setAction("fork")}>
                  <GitFork size={15} aria-hidden="true" />
                  Fork to local
                </button>
              )}
              <ActionMenu<Action>
                label={`Actions for ${id}`}
                {...(disabledReason ? { disabledReason } : {})}
                onSelect={(next) => {
                  if (next === "add") setSection("source");
                  setAction(next);
                }}
                items={[
                  { id: "fork", label: "Fork to local", icon: <GitFork size={15} aria-hidden="true" /> },
                  { id: "add", label: "Add text file", icon: <FilePlus size={15} aria-hidden="true" />, hidden: info.readOnly },
                  {
                    id: "delete",
                    label: "Delete component",
                    icon: <Trash2 size={15} aria-hidden="true" />,
                    danger: true,
                    hidden: info.readOnly || info.source === "linked",
                  },
                ]}
              />
            </div>
          )}
        </div>
      </header>
      {!info ? (
        infoError ? (
          <ErrorMessage>
            Could not load {id}. {errorText(infoError)}{" "}
            <button className="text-button" onClick={() => void mutateInfo()}>
              Try again
            </button>
          </ErrorMessage>
        ) : (
          <SkeletonRegion label="Loading details" className="skeleton-page">
            {[60, 90].map((width) => (
              <div className="skeleton-card" key={width}>
                <Skeleton width={width as 60 | 90} />
              </div>
            ))}
          </SkeletonRegion>
        )
      ) : (
        <Tabs.Root value={section} onValueChange={(next) => setSection(next as Section)}>
          <Tabs.List className="tabs page-tabs" aria-label="Component sections">
            <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
            <Tabs.Trigger value="source">Source</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content {...panel("overview")}>
            <section className="card">
              <div className="card-header">
                <div>
                  <h2>About</h2>
                  <p>Static inspection only. Raw never runs a component while you view it.</p>
                </div>
              </div>
              {info.description && <p>{info.description}</p>}
              {info.validation === "valid" ? (
                <p className="metadata">
                  <span className="badge success">Valid structure</span>
                  <span>Not executed</span>
                  <span>
                    {info.files.length} {info.files.length === 1 ? "file" : "files"}
                  </span>
                </p>
              ) : (
                <ErrorMessage>{info.diagnostic ?? "This component is invalid."}</ErrorMessage>
              )}
            </section>
            {kind === "hooks" && info.manifest && <HookEvents manifest={info.manifest} />}
            <UsedByCard
              info={info}
              config={config}
              endpoint={endpoint}
              {...(disabledReason ? { disabledReason } : {})}
              {...(configError ? { configError: errorText(configError), retryConfig: () => void mutateConfig() } : {})}
              reload={async () => {
                // A direct GET: SWR's mutate() would hand back cached usage if revalidation failed.
                const next = await api<ComponentInfo>(endpoint);
                await mutateInfo(next, { revalidate: false });
                return next;
              }}
              changed={async () => {
                await changed();
                await refresh();
              }}
            />
          </Tabs.Content>
          <Tabs.Content {...panel("source")}>
            <section className="card">
              <div className="card-header">
                <div>
                  <h2>Source</h2>
                  <p>{readOnly ? "Read-only source. Fork to local to edit." : "Each file is saved separately and applies to the next turn."}</p>
                </div>
                {readOnly && (
                  <button disabled={!!disabledReason} onClick={() => setAction("fork")}>
                    Fork to local
                  </button>
                )}
              </div>
              <Field label="Source file" {...(draft.dirty ? { hint: "Save or discard before switching files." } : {})}>
                <select
                  disabled={draft.dirty}
                  value={file}
                  onChange={(e) => {
                    setFile(e.target.value);
                    setFileIsNew(false);
                  }}
                >
                  {[...new Set([...info.files, file])].map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </Field>
              {(readOnly || !draft.base) && <ErrorMessage>{draft.error}</ErrorMessage>}
              {draft.base && loadedUrl === url ? (
                <SourceView key={url} file={file} draft={draft} readOnly={readOnly} />
              ) : (
                !draft.error && (
                  <SkeletonRegion label="Loading file">
                    <Skeleton width={90} />
                  </SkeletonRegion>
                )
              )}
            </section>
          </Tabs.Content>
        </Tabs.Root>
      )}
      {info && !readOnly && draft.base && <DraftActions draft={draft} variant="bar" />}
      <ComponentActionDialog
        action={action}
        kind={kind}
        id={id}
        info={info}
        endpoint={endpoint}
        refresh={refresh}
        onClose={() => setAction(undefined)}
        onAddFile={(path) => {
          setAction(undefined);
          setFile(path);
          setFileIsNew(true);
          setSection("source");
        }}
      />
    </div>
  );
}

function SourceView({
  file,
  draft,
  readOnly,
}: {
  file: string;
  draft: ReturnType<typeof useDraft>;
  readOnly: boolean;
}) {
  const markdown = file.endsWith(".md");
  const [view, setView] = useState<"source" | "preview">("source");
  return (
    <>
      {markdown && <MarkdownView value={view} onChange={setView} />}
      {markdown && view === "preview" ? (
        <div className="markdown-preview">
          <Markdown>{draft.source}</Markdown>
        </div>
      ) : (
        <SourceEditor
          label={`Source ${file}`}
          value={draft.source}
          onChange={draft.setSource}
          readOnly={readOnly || draft.busy}
          language={markdown ? "markdown" : file.endsWith(".json") ? "json" : "javascript"}
        />
      )}
    </>
  );
}

/** Source | Preview switch; a radio group, so arrow keys move between the two choices. */
function MarkdownView({ value, onChange }: { value: "source" | "preview"; onChange: (value: "source" | "preview") => void }) {
  const options = [
    { value: "source", label: "Source" },
    { value: "preview", label: "Preview" },
  ] as const;
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label="Markdown view"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const next = value === "source" ? "preview" : "source";
        onChange(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function HookEvents({ manifest }: { manifest: Record<string, unknown> }) {
  const events = Array.isArray(manifest.events) ? (manifest.events as Record<string, any>[]) : [];
  const args = Array.isArray(manifest.args) ? (manifest.args as string[]) : [];
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Events</h2>
          <p>When this hook runs. Listing it here never runs it.</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="events-table" aria-label="Hook events">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Tool</th>
              <th scope="col">Condition</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, index) => (
              <tr key={index}>
                <td>{String(event.name)}</td>
                <td>{event.match ? <code>{String(event.match)}</code> : <span className="muted">Any tool</span>}</td>
                <td>
                  {event.when ? (
                    <>
                      <code>{String(event.when.any)}</code> matches <code>{String(event.when.regex)}</code>
                      <span className="muted"> in {String(event.when.source)}</span>
                    </>
                  ) : (
                    <span className="muted">Always</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="details-grid">
        <dt>Command</dt>
        <dd>
          <code>{[String(manifest.command), ...args].join(" ")}</code>
        </dd>
        <dt>Timeout</dt>
        <dd>{String(manifest.timeoutMs)} ms</dd>
      </dl>
    </section>
  );
}

function ComponentActionDialog({
  action,
  kind,
  id,
  info,
  endpoint,
  refresh,
  onClose,
  onAddFile,
}: {
  action: Action | undefined;
  kind: ComponentKind;
  id: string;
  info: ComponentInfo | undefined;
  endpoint: string;
  refresh: () => Promise<void>;
  onClose: () => void;
  onAddFile: (path: string) => void;
}) {
  const { navigate } = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!action) return;
    setError("");
    setValue(action === "fork" ? `${info?.name ?? "component"}_custom`.replaceAll("-", "_") : "");
  }, [action]);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void work().then(
      () => setBusy(false),
      (cause) => {
        setBusy(false);
        setError(errorText(cause));
      },
    );
  };
  const title = action === "fork" ? "Fork to local" : action === "add" ? "Add text file" : "Delete component";
  const description =
    action === "fork"
      ? "Creates an editable copy. Your agents keep their current selection."
      : action === "add"
        ? "Enter a relative path inside this component. Save publishes the new file."
        : "Detach all current usages first. This removes the owned folder, including its text resources.";
  return (
    <Modal open={!!action} onOpenChange={(open) => !open && onClose()} title={title} description={description}>
      <ErrorMessage>{error}</ErrorMessage>
      {action === "fork" && (
        <Field label="Component folder">
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      {action === "add" && (
        <Field label="Relative file path">
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      <div className="actions">
        {action === "fork" && (
          <button
            className="primary"
            disabled={!value || busy}
            onClick={() =>
              run(async () => {
                await api(`/components/${kind}`, "POST", { id: `local/${value}`, cloneFrom: id });
                await refresh();
                onClose();
                navigate(`/library/${kind}/${encodeURIComponent(`local/${value}`)}`);
              })
            }
          >
            Create fork
          </button>
        )}
        {action === "add" && (
          <button className="primary" disabled={!value || info?.files.includes(value)} onClick={() => onAddFile(value)}>
            Open new file
          </button>
        )}
        {action === "delete" && (
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(endpoint, "DELETE");
                await refresh();
                onClose();
                navigate(`/library/${kind}`);
              })
            }
          >
            Delete component
          </button>
        )}
      </div>
    </Modal>
  );
}
