import { useEffect, useState } from "react";
import type { ComponentInfo } from "../../../src/management/components.js";
import useSWR from "swr";
import { api, errorText } from "../api.js";
import { useComponents, useConfig } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { Link, useRouter } from "../router.js";
import { ErrorMessage, Field, Modal } from "../ui.js";
import {
  DraftActions,
  SourceEditor,
  useDraft,
  type DraftDocument,
} from "../editors/shared.js";
import { Markdown } from "../markdown.js";
import { ComponentsList, type ComponentKind } from "./library/ComponentsList.js";
export function ComponentsPage({
  kind,
  changed,
}: {
  kind: ComponentKind;
  changed: () => Promise<void>;
}) {
  const { path } = useRouter();
  const id = path.split("/")[3]
    ? decodeURIComponent(path.split("/")[3]!)
    : undefined;
  const {
    data: loaded,
    error: listError,
    mutate: mutateItems,
  } = useComponents(kind);
  const refresh = async () => {
    await mutateItems();
  };
  const gate = usePageGate({ ready: !!loaded, error: listError, onRetry: () => void refresh(), label: "Loading components" });
  if (gate) return gate;
  if (!id)
    return (
      <ComponentsList
        kind={kind}
        items={loaded ?? []}
        {...(listError ? { error: errorText(listError), onRetry: () => void refresh() } : {})}
      />
    );
  return (
    <div className="management-page">
      <span className="scope">Owned component files</span>
      <div className="section-heading">
        <h1>{id}</h1>
      </div>
      <ErrorMessage>{listError ? errorText(listError) : ""}</ErrorMessage>
      <ComponentDetail
        key={id}
        kind={kind}
        id={id}
        changed={changed}
        refresh={refresh}
      />
    </div>
  );
}
function ComponentDetail({
  kind,
  id,
  changed,
  refresh,
}: {
  kind: "tools" | "skills" | "hooks";
  id: string;
  changed: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const { navigate } = useRouter(),
    endpoint = `/components/${kind}/${encodeURIComponent(id)}`;
  const {
    data: info,
    error: infoError,
    mutate: mutateInfo,
  } = useSWR<ComponentInfo>(endpoint);
  const { data: config } = useConfig();
  const [agent, setAgent] = useState("");
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [fork, setFork] = useState(false),
    [folder, setFolder] = useState(""),
    [remove, setRemove] = useState(false);
  const [file, setFile] = useState(kind === "tools" ? "tool.json" : kind === "skills" ? "SKILL.md" : "hook.json"),
    [dirty, setDirty] = useState(false),
    [newFile, setNewFile] = useState("");
  const [adding, setAdding] = useState(false),
    [fileIsNew, setFileIsNew] = useState(false);
  const reload = async () => {
    await mutateInfo();
  };
  useEffect(() => {
    if (config)
      setAgent((old) => old || config.defaultAgent || config.agents[0] || "");
  }, [config]);
  const gate = usePageGate({
    ready: !!info,
    error: infoError,
    onRetry: () => void mutateInfo(),
    label: "Loading details",
    bare: true,
  });
  const attach = async (selected: boolean) => {
    try {
      await api(`${endpoint}/selection`, "POST", {
        revision: config?.revision,
        agent,
        selected,
      });
      await reload();
      await changed();
      setStatus(selected ? "Attached · applies to the next turn" : "Detached");
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  if (gate) return gate;
  return (
    <>
      <ErrorMessage>{error || (infoError ? errorText(infoError) : "") || info?.diagnostic}</ErrorMessage>
      <p className="muted">
        {info?.source} · {info?.readOnly ? "Read-only" : "Editable source"} ·{" "}
        {info?.validation} structure · Not executed
      </p>
      <p>{info?.description}</p>
      {kind === "hooks" && info?.manifest && (
        <dl className="details-grid">
          <dt>Events and filters</dt>
          <dd><code>{JSON.stringify(info.manifest.events)}</code></dd>
          <dt>Command and arguments</dt>
          <dd><code>{String(info.manifest.command)} {JSON.stringify(info.manifest.args ?? [])}</code></dd>
          <dt>Timeout</dt>
          <dd>{String(info.manifest.timeoutMs)} ms</dd>
        </dl>
      )}
      <p>
        Used by:{" "}
        {info?.usageAvailable
          ? info.usedBy.join(", ") || "Not selected"
          : "Unavailable"}
      </p>
      <div className="actions">
        <button
          disabled={dirty}
          onClick={() => {
            setFolder(
              `${info?.name ?? "component"}_custom`.replaceAll("-", "_"),
            );
            setFork(true);
          }}
        >
          Fork to local
        </button>
        {!info?.readOnly && info?.source !== "linked" && (
          <button disabled={dirty} onClick={() => setRemove(true)}>
            Delete component
          </button>
        )}
      </div>
      <div className="actions">
        <Field label="Attach to agent">
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {config?.agents.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </Field>
        <button
          disabled={!agent || dirty}
          onClick={() => {
            void attach(true);
          }}
        >
          Attach
        </button>
        <button
          disabled={!agent || dirty}
          onClick={() => {
            void attach(false);
          }}
        >
          Detach
        </button>
      </div>
      <p role="status">{status}</p>
      <div className="actions">
        <Field
          label="Source file"
          hint={
            dirty
              ? "Save or discard before switching files."
              : "Each file is saved separately."
          }
        >
          <select
            disabled={dirty}
            value={file}
            onChange={(e) => {
              setFile(e.target.value);
              setFileIsNew(false);
            }}
          >
            {[...new Set([...(info?.files ?? []), file])].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </Field>
        {!info?.readOnly && (
          <button disabled={dirty} onClick={() => setAdding(true)}>
            Add text file
          </button>
        )}
      </div>
      {info && (
        <FileEditor
          key={file}
          endpoint={endpoint}
          file={file}
          readOnly={info.readOnly}
          isNew={fileIsNew}
          dirty={setDirty}
          changed={async () => {
            await reload();
            await refresh();
          }}
        />
      )}
      <Modal
        open={fork}
        onOpenChange={setFork}
        title="Fork to local"
        description="Creates an editable copy. Your agents keep their current selection."
      >
        <ErrorMessage>{error}</ErrorMessage>
        <Field label="Component folder">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </Field>
        <button
          className="primary"
          onClick={() => {
            void api(`/components/${kind}`, "POST", {
              id: `local/${folder}`,
              cloneFrom: id,
            }).then(
              () => {
                setFork(false);
                navigate(
                  `/library/${kind}/${encodeURIComponent(`local/${folder}`)}`,
                );
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Create fork
        </button>
      </Modal>
      <Modal
        open={remove}
        onOpenChange={setRemove}
        title="Delete component"
        description="Detach all current usages first. This removes the owned folder, including its text resources."
      >
        <ErrorMessage>{error}</ErrorMessage>
        <button
          className="primary"
          onClick={() => {
            void api(endpoint, "DELETE").then(
              () => navigate(`/library/${kind}`),
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Delete
        </button>
      </Modal>
      <Modal
        open={adding}
        onOpenChange={setAdding}
        title="Add text file"
        description="Enter a relative path inside this component. Save publishes the new file."
      >
        <Field label="Relative file path">
          <input value={newFile} onChange={(e) => setNewFile(e.target.value)} />
        </Field>
        <button
          className="primary"
          disabled={!newFile || info?.files.includes(newFile)}
          onClick={() => {
            setFile(newFile);
            setFileIsNew(true);
            setAdding(false);
          }}
        >
          Open new file
        </button>
      </Modal>
    </>
  );
}
function FileEditor({
  endpoint,
  file,
  readOnly,
  isNew,
  dirty,
  changed,
}: {
  endpoint: string;
  file: string;
  readOnly: boolean;
  isNew: boolean;
  dirty: (value: boolean) => void;
  changed: () => Promise<void>;
}) {
  const url = `${endpoint}/file?path=${encodeURIComponent(file)}`;
  const draft = useDraft(
    url,
    () =>
      isNew
        ? Promise.resolve({ source: "", revision: "missing" })
        : api<DraftDocument>(url),
    (value) => api<DraftDocument>(url, "PUT", value),
    changed,
  );
  useEffect(() => {
    dirty(draft.dirty);
    return () => dirty(false);
  }, [draft.dirty]);
  return (
    <>
      {readOnly ? (
        <p className="notice">Read-only source. Fork to local to edit.</p>
      ) : (
        <DraftActions draft={draft} />
      )}
      {readOnly && <ErrorMessage>{draft.error}</ErrorMessage>}
      <SourceEditor
        label={`Source ${file}`}
        value={draft.source}
        onChange={draft.setSource}
        readOnly={readOnly || draft.busy}
        language={
          file.endsWith(".md")
            ? "markdown"
            : file.endsWith(".json")
              ? "json"
              : "javascript"
        }
      />
      {file.endsWith(".md") && (
        <details>
          <summary>Markdown preview</summary>
          <Markdown>{draft.source}</Markdown>
        </details>
      )}
    </>
  );
}
