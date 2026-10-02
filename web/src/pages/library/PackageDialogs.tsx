import { useEffect, useRef, useState } from "react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import type { PackageStageView, PackageView } from "../../../../src/dashboard/packages.js";
import type { PackageReport } from "../../../../src/packages/inspect.js";
import { api, downloadPackage, errorText, uploadPackage } from "../../api.js";
import { object, pretty } from "../../editors/shared.js";
import { ErrorMessage, Field, Modal } from "../../ui.js";

/** Busy and error state owned by one dialog, so its failures stay inside it. */
function useDialogWork(open: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) setError("");
  }, [open]);
  const work = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, work };
}

export function ImportDialog({
  open,
  replacing,
  onClose,
  onStaged,
}: {
  open: boolean;
  /** Alias being updated; the reviewed artifact replaces it. */
  replacing?: string;
  onClose: () => void;
  onStaged: (stage: PackageStageView) => Promise<void>;
}) {
  const { busy, error, work } = useDialogWork(open);
  const [path, setPath] = useState("");
  const upload = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (open) setPath("");
  }, [open]);
  useEffect(() => () => upload.current?.abort(), []);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={replacing ? `Replacement for ${replacing}` : "Import package"}
      description="Inspect a package before installing it. Nothing runs and your config is unchanged until you install."
    >
      <ErrorMessage>{error}</ErrorMessage>
      <Field
        label="Local package path"
        hint="A source directory or .rawpkg file on this machine; relative paths use the dashboard workspace."
      >
        <input value={path} onChange={(e) => setPath(e.target.value)} />
      </Field>
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !path}
          onClick={() =>
            void work(async () => onStaged(await api<PackageStageView>("/packages/inspect", "POST", { path })))
          }
        >
          Inspect path
        </button>
        {replacing && (
          <button disabled={busy} onClick={onClose}>
            Cancel update
          </button>
        )}
      </div>
      <Field label="Upload package archive" hint=".rawpkg · maximum 128 MiB">
        <input
          type="file"
          accept=".rawpkg,application/octet-stream"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            upload.current = new AbortController();
            void work(async () => {
              try {
                await onStaged(await uploadPackage(file, upload.current!.signal));
              } finally {
                upload.current = undefined;
              }
            });
          }}
        />
      </Field>
      {busy && (
        <div className="actions">
          <span className="muted" role="status">
            Working with package files…
          </span>
          {upload.current && <button onClick={() => upload.current?.abort()}>Cancel upload</button>}
        </div>
      )}
    </Modal>
  );
}

export function ReviewDialog({
  stage,
  replacing,
  onClose,
  onDone,
}: {
  stage: PackageStageView | undefined;
  replacing?: string;
  onClose: () => void;
  onDone: (status: string) => Promise<void>;
}) {
  const { busy, error, work } = useDialogWork(!!stage);
  const [alias, setAlias] = useState("");
  useEffect(() => {
    if (stage) setAlias(replacing ?? stage.report.name.split("/").at(-1) ?? "package");
  }, [stage?.id]);
  return (
    <Modal
      open={!!stage}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Review package"
      description="Review exports, inputs and prerequisites before installation. Activation is a separate step."
    >
      <ErrorMessage>{error}</ErrorMessage>
      {stage && (
        <>
          <PackageReportView report={stage.report} />
          <p className="muted">
            {stage.bytes.toLocaleString()} bytes · SHA-256 <code className="wrap-anywhere">{stage.sha256}</code>
          </p>
          <h3 className="dialog-subheading">Recipient input schema</h3>
          <pre className="code-sample">{pretty(stage.inputs)}</pre>
          <Field label="Install alias">
            <input value={alias} disabled={!!replacing || busy} onChange={(e) => setAlias(e.target.value)} />
          </Field>
          <div className="actions">
            <button
              className="primary"
              disabled={!alias || busy}
              onClick={() =>
                void work(async () => {
                  const target = replacing ?? alias;
                  await api("/packages/install", "POST", {
                    stageId: stage.id,
                    alias: target,
                    action: replacing ? "update" : "install",
                  });
                  await onDone(`${replacing ? "Updated" : "Installed"} ${target}`);
                })
              }
            >
              {replacing ? `Update ${replacing}` : "Install"}
            </button>
            {stage.canLink && !replacing && (
              <button
                disabled={!alias || busy}
                onClick={() =>
                  void work(async () => {
                    await api("/packages/install", "POST", { stageId: stage.id, alias, action: "link" });
                    await onDone(`Linked ${alias}`);
                  })
                }
              >
                Link authored source
              </button>
            )}
            <button disabled={busy} onClick={() => void work(() => downloadPackage(stage.id))}>
              Download archive
            </button>
          </div>
          {stage.canLink && (
            <p className="muted">Link follows changes to the inspected source directory. Install uses the reviewed snapshot.</p>
          )}
        </>
      )}
    </Modal>
  );
}

export function ExportDialog({
  open,
  config,
  onClose,
  onStaged,
  reload,
}: {
  open: boolean;
  config: ConfigView | undefined;
  onClose: () => void;
  onStaged: (stage: PackageStageView) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const { busy, error, setError, work } = useDialogWork(open);
  const [agent, setAgent] = useState(""),
    [name, setName] = useState(""),
    [version, setVersion] = useState("1.0.0"),
    [literals, setLiterals] = useState(false),
    [files, setFiles] = useState("");
  useEffect(() => {
    if (config) setAgent((old) => (old && config.agents.includes(old) ? old : config.defaultAgent || config.agents[0] || ""));
  }, [config]);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="Export agent"
      description="Build a portable archive with recipient-owned model and input decisions."
    >
      <ErrorMessage>{error}</ErrorMessage>
      <Field label="Export agent name">
        <select value={agent} onChange={(e) => setAgent(e.target.value)}>
          {config?.agents.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </Field>
      <Field label="Package name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="@you/agent-kit" />
      </Field>
      <Field label="Version">
        <input value={version} onChange={(e) => setVersion(e.target.value)} />
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={literals} onChange={(e) => setLiterals(e.target.checked)} />
        Include literal variable values
      </label>
      <Field
        label="External files to include"
        hint="One explicitly chosen file per line. Leave empty to keep external files as recipient inputs."
      >
        <textarea value={files} onChange={(e) => setFiles(e.target.value)} />
      </Field>
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !name || !agent}
          onClick={() =>
            void work(async () => {
              const stage = await api<PackageStageView>("/packages/export", "POST", {
                revision: config?.revision,
                agent,
                name,
                version,
                includeLiterals: literals,
                includeFiles: files
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
              await onStaged(stage);
            })
          }
        >
          Build archive
        </button>
        {error && (
          <button onClick={() => void reload().catch((cause) => setError(errorText(cause)))}>Reload config, keep form</button>
        )}
      </div>
    </Modal>
  );
}

export function BindDialog({
  mode,
  pkg,
  config,
  onClose,
  onDone,
  reload,
}: {
  mode: "agent" | "component" | undefined;
  pkg: PackageView;
  config: ConfigView | undefined;
  onClose: () => void;
  onDone: (status: string, agent?: string) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const { busy, error, setError, work } = useDialogWork(!!mode);
  const exports = pkg.report?.exports;
  const [exportName, setExportName] = useState(""),
    [kind, setKind] = useState("tools"),
    [name, setName] = useState(""),
    [model, setModel] = useState(""),
    // undefined until the config supplies a default; "" is an explicit "Keep unselected".
    [agent, setAgent] = useState<string>(),
    [as, setAs] = useState(""),
    [inputs, setInputs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!mode) return;
    setInputs({});
    setName("");
    setAs("");
    if (mode === "agent") setExportName(exports?.agents[0] ?? "");
    else {
      const first = Object.entries(exports ?? {}).find(([type, names]) => type !== "agents" && names.length)?.[0] ?? "tools";
      setKind(first);
      setExportName(exports?.[first as keyof PackageReport["exports"]]?.[0] ?? "");
    }
  }, [mode]);
  // Defaults follow the config, which may arrive after the dialog opens; chosen values stay.
  useEffect(() => {
    if (!config) return;
    setModel((old) => (old && config.models.includes(old) ? old : config.models[0] || ""));
    setAgent((old) =>
      old === "" || (old !== undefined && config.agents.includes(old)) ? old : config.defaultAgent || config.agents[0] || "",
    );
  }, [config]);
  return (
    <Modal
      open={!!mode}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={mode === "agent" ? "Use agent" : "Add component"}
      description="Save an explicit recipient binding. Existing default and sessions stay available."
    >
      <ErrorMessage>{error}</ErrorMessage>
      {mode === "component" && (
        <Field label="Component kind">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setExportName(exports?.[e.target.value as keyof PackageReport["exports"]]?.[0] ?? "");
            }}
          >
            {Object.entries(exports ?? {})
              .filter(([k, values]) => k !== "agents" && values.length)
              .map(([k]) => (
                <option key={k}>{k}</option>
              ))}
          </select>
        </Field>
      )}
      <Field label="Export name">
        <select value={exportName} onChange={(e) => setExportName(e.target.value)}>
          {exports?.[(mode === "agent" ? "agents" : kind) as keyof PackageReport["exports"]]?.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </Field>
      {mode === "agent" ? (
        <>
          <Field label="Local agent name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Recipient model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {config?.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          {["tools", "skills", "hooks", "vars"].includes(kind) && (
            <Field label="Recipient agent">
              <select value={agent ?? ""} onChange={(e) => setAgent(e.target.value)}>
                {kind === "vars" && <option value="">Keep unselected</option>}
                {config?.agents.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </Field>
          )}
          {["tools", "skills"].includes(kind) ? (
            <Field label="Visible alias (optional)">
              <input value={as} onChange={(e) => setAs(e.target.value)} />
            </Field>
          ) : (
            <Field label="Name in config">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={exportName} />
            </Field>
          )}
        </>
      )}
      <TypedInputs schema={pkg.inputs ?? {}} value={inputs} onChange={setInputs} />
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !exportName || (mode === "agent" && (!name || !model))}
          onClick={() =>
            void work(async () => {
              const values = inputValues(pkg.inputs ?? {}, inputs);
              await api(`/packages/${encodeURIComponent(pkg.alias)}/${mode}`, "POST", {
                revision: config?.revision,
                exportName,
                inputs: values,
                ...(mode === "agent"
                  ? { name, model }
                  : {
                      kind,
                      name: name || exportName,
                      ...(agent && ["tools", "skills", "hooks", "vars"].includes(kind) ? { agent } : {}),
                      ...(as ? { as } : {}),
                    }),
              });
              if (mode === "agent") await onDone(`Agent ${name} created`, name);
              else await onDone("Component binding saved · applies to the next turn");
            })
          }
        >
          {mode === "agent" ? "Create agent binding" : "Save component binding"}
        </button>
        {error && (
          <button onClick={() => void reload().catch((cause) => setError(errorText(cause)))}>Reload config, keep form</button>
        )}
      </div>
    </Modal>
  );
}

export function PackageActionDialog({
  action,
  alias,
  onClose,
  onDone,
}: {
  action: "fork" | "remove" | undefined;
  alias: string;
  onClose: () => void;
  onDone: (action: "fork" | "remove", status: string) => Promise<void>;
}) {
  const { busy, error, work } = useDialogWork(!!action);
  const [out, setOut] = useState("");
  return (
    <Modal
      open={!!action}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={action === "fork" ? "Fork package" : "Remove package"}
      description={
        action === "fork"
          ? "Copy to a new or empty authored directory. Link the copy separately to follow its edits."
          : "Remove this alias after detaching its current bindings. Stored artifacts and sessions are retained."
      }
    >
      <ErrorMessage>{error}</ErrorMessage>
      {action === "fork" && (
        <Field label="Destination directory">
          <input value={out} onChange={(e) => setOut(e.target.value)} />
        </Field>
      )}
      <div className="actions">
        <button
          className={action === "remove" ? "danger" : "primary"}
          disabled={busy || (action === "fork" && !out)}
          onClick={() =>
            void work(async () => {
              if (action === "fork") {
                await api(`/packages/${encodeURIComponent(alias)}/fork`, "POST", { out });
                await onDone("fork", `Forked to ${out}`);
              } else {
                await api(`/packages/${encodeURIComponent(alias)}`, "DELETE");
                await onDone("remove", `Removed ${alias}`);
              }
            })
          }
        >
          {action === "fork" ? "Create fork" : "Remove alias"}
        </button>
      </div>
    </Modal>
  );
}

const exportLabel: Record<string, string> = {
  agents: "Agents",
  tools: "Tools",
  skills: "Skills",
  hooks: "Hooks",
  vars: "Vars",
  mcp: "MCP servers",
};

/** Exports as a definition list; used by the Review dialog and the Exports card. */
export function PackageExports({ report }: { report: PackageReport }) {
  const entries = Object.entries(report.exports).filter(([, values]) => values.length);
  return entries.length ? (
    <dl className="details-grid">
      {entries.map(([kind, values]) => (
        <div key={kind} style={{ display: "contents" }}>
          <dt>{exportLabel[kind] ?? kind}</dt>
          <dd>{values.join(", ")}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="muted">No exports.</p>
  );
}

export function PackagedFiles({ files, limit = 8 }: { files: readonly string[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, limit);
  return (
    <>
      <ul className="file-list" aria-label="Packaged files">
        {shown.map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
      {files.length > limit && !all && (
        <button className="text-button" onClick={() => setAll(true)}>
          Show all {files.length}
        </button>
      )}
    </>
  );
}

function PackageReportView({ report }: { report: PackageReport }) {
  return (
    <section className="package-report">
      <h3 className="dialog-subheading">
        {report.name} <small>{report.version}</small>
      </h3>
      <PackageExports report={report} />
      <p>Raw capabilities: {report.requires.join(", ") || "None declared"}</p>
      <p>External executables: {report.prerequisites.join(", ") || "None declared"}</p>
      <p className="muted">
        {report.files.length} packaged files · {report.inputs.length} declared inputs · Static validation only
      </p>
      <PackagedFiles files={report.files} />
    </section>
  );
}

function TypedInputs({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, unknown>;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  return (
    <section className="editor-section">
      <h2>Recipient inputs</h2>
      <p className="muted">
        Defaults are applied by Raw. Required fields are checked for the selected export; unused package inputs can be left
        unset.
      </p>
      {Object.entries(object(schema.properties)).map(([name, raw]) => {
        const spec = object(raw),
          set = (v: string) => onChange({ ...value, [name]: v });
        const hint = `${String(spec.type)}${spec["x-raw-kind"] ? ` · ${spec["x-raw-kind"]}` : ""}${required.includes(name) ? " · Required when used" : ""}${spec.description ? ` · ${spec.description}` : ""}${spec.default !== undefined ? ` · Default: ${JSON.stringify(spec.default)}` : ""}`;
        return (
          <div key={name}>
            <Field label={`Input ${name}`} hint={hint}>
              {Array.isArray(spec.enum) ? (
                <select value={value[name] ?? ""} onChange={(e) => set(e.target.value)}>
                  <option value="">Unset</option>
                  {spec.enum.map((v: unknown, i: number) => (
                    <option value={JSON.stringify(v)} key={i}>
                      {String(v)}
                    </option>
                  ))}
                </select>
              ) : spec.type === "boolean" || spec.type === "null" ? (
                <select value={value[name] ?? ""} onChange={(e) => set(e.target.value)}>
                  <option value="">Unset</option>
                  {(spec.type === "null" ? ["null"] : ["true", "false"]).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : spec.type === "object" || spec.type === "array" ? (
                <textarea
                  value={value[name] ?? ""}
                  onChange={(e) => set(e.target.value)}
                  placeholder={spec.type === "object" ? "{}" : "[]"}
                />
              ) : (
                <input
                  type={spec.type === "string" ? "text" : "number"}
                  value={value[name] ?? ""}
                  onChange={(e) => set(e.target.value)}
                />
              )}
            </Field>
            {Object.hasOwn(value, name) && (
              <button onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([key]) => key !== name)))}>
                Unset {name}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function inputValues(schema: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => value !== "" || object(object(schema.properties)[key]).type === "string")
      .map(([key, value]) => {
        const spec = object(object(schema.properties)[key]);
        try {
          return [key, spec.type === "string" && !spec.enum ? value : (JSON.parse(value) as unknown)];
        } catch {
          throw new Error(`Input ${key} must be a valid ${String(spec.type)} value`);
        }
      }),
  );
}
