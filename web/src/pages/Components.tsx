import { useEffect, useState } from "react";
import type { ComponentInfo } from "../../../src/management/components.js";
import type { ConfigView } from "../../../src/dashboard/management.js";
import { api, errorText } from "../api.js";
import { Link, useRouter } from "../router.js";
import { ErrorMessage, Field, Modal } from "../ui.js";
import {
  DraftActions,
  SourceEditor,
  useDraft,
  type DraftDocument,
} from "../editors/shared.js";
import { Markdown } from "../markdown.js";
export function ComponentsPage({
  kind,
  changed,
}: {
  kind: "tools" | "skills";
  changed: () => Promise<void>;
}) {
  const { path, navigate } = useRouter();
  const id = path.split("/")[3]
    ? decodeURIComponent(path.split("/")[3]!)
    : undefined;
  const [items, setItems] = useState<ComponentInfo[]>([]),
    [filter, setFilter] = useState(""),
    [error, setError] = useState("");
  const [create, setCreate] = useState(false),
    [folder, setFolder] = useState(""),
    [template, setTemplate] = useState(
      kind === "tools" ? "builtin/read_file" : "builtin/create_skill",
    );
  const refresh = async () =>
    setItems(await api<ComponentInfo[]>(`/components/${kind}`));
  useEffect(() => {
    void refresh().catch((cause) => setError(errorText(cause)));
  }, [kind, id]);
  return (
    <div className="management-page">
      <span className="scope">Owned component files</span>
      <div className="section-heading">
        <h1>{id ?? (kind === "tools" ? "Tools" : "Skills")}</h1>
        <button
          onClick={() => {
            setCreate(true);
            setFolder("");
          }}
        >
          Create {kind === "tools" ? "tool" : "skill"}
        </button>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      {id ? (
        <ComponentDetail
          key={id}
          kind={kind}
          id={id}
          changed={changed}
          refresh={refresh}
        />
      ) : (
        <>
          <p className="muted">
            Static inspection only. Builtins and installed packages are
            read-only; fork them to customize.
          </p>
          <Field label={`Search ${kind}`}>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </Field>
          <div className="catalog" role="table" aria-label={`${kind} catalog`}>
            <div role="row" className="catalog-row catalog-heading">
              <span role="columnheader">Name</span>
              <span role="columnheader">Source</span>
              <span role="columnheader">Used by</span>
              <span role="columnheader">Validation</span>
            </div>
            {items
              .filter((item) =>
                `${item.id} ${item.description}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((item) => (
                <div role="row" className="catalog-row" key={item.id}>
                  <span role="cell">
                    <Link
                      href={`/library/${kind}/${encodeURIComponent(item.id)}`}
                    >
                      {item.id}
                    </Link>
                    <small>{item.description.slice(0, 180)}</small>
                  </span>
                  <span role="cell">{item.source}</span>
                  <span role="cell">
                    {item.usageAvailable
                      ? item.usedBy.join(", ") || "Not selected"
                      : "Usage unavailable"}
                  </span>
                  <span role="cell">
                    {item.validation === "valid"
                      ? "Valid structure · not run"
                      : "Invalid"}
                  </span>
                </div>
              ))}
          </div>
          {!items.some((item) =>
            `${item.id} ${item.description}`
              .toLowerCase()
              .includes(filter.toLowerCase()),
          ) && (
            <p>
              No results.{" "}
              <button onClick={() => setFilter("")}>Clear filters</button>
            </p>
          )}
        </>
      )}
      <Modal
        open={create}
        onOpenChange={setCreate}
        title={`Create ${kind === "tools" ? "tool" : "skill"}`}
        description="Start from a shipped example. The new component stays unselected until you attach it."
      >
        <ErrorMessage>{error}</ErrorMessage>
        <Field label="Component folder">
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="my_component"
          />
        </Field>
        <Field label="Example">
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            {items
              .filter((i) => i.source === "builtin")
              .map((i) => (
                <option key={i.id}>{i.id}</option>
              ))}
          </select>
        </Field>
        <button
          className="primary"
          disabled={!folder || !template}
          onClick={() => {
            void api(`/components/${kind}`, "POST", {
              id: `local/${folder}`,
              cloneFrom: template,
            }).then(
              () => {
                setCreate(false);
                setError("");
                navigate(
                  `/library/${kind}/${encodeURIComponent(`local/${folder}`)}`,
                );
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Create from example
        </button>
      </Modal>
    </div>
  );
}
function ComponentDetail({
  kind,
  id,
  changed,
  refresh,
}: {
  kind: "tools" | "skills";
  id: string;
  changed: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const { navigate } = useRouter(),
    endpoint = `/components/${kind}/${encodeURIComponent(id)}`;
  const [info, setInfo] = useState<ComponentInfo>(),
    [config, setConfig] = useState<ConfigView>(),
    [agent, setAgent] = useState("");
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [fork, setFork] = useState(false),
    [folder, setFolder] = useState(""),
    [remove, setRemove] = useState(false);
  const [file, setFile] = useState(kind === "tools" ? "tool.json" : "SKILL.md"),
    [dirty, setDirty] = useState(false),
    [newFile, setNewFile] = useState("");
  const [adding, setAdding] = useState(false),
    [fileIsNew, setFileIsNew] = useState(false);
  const reload = async () => {
    setInfo(await api<ComponentInfo>(endpoint));
    const next = await api<ConfigView>("/config");
    setConfig(next);
    setAgent((old) => old || next.defaultAgent || next.agents[0] || "");
  };
  useEffect(() => {
    void reload().catch((cause) => setError(errorText(cause)));
  }, [endpoint]);
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
  return (
    <>
      <ErrorMessage>{error || info?.diagnostic}</ErrorMessage>
      <p className="muted">
        {info?.source} · {info?.readOnly ? "Read-only" : "Editable source"} ·{" "}
        {info?.validation} structure · Not executed
      </p>
      <p>{info?.description}</p>
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
