import { useEffect, useRef, useState } from "react";
import type {
  PackageStageView,
  PackageView,
} from "../../../src/dashboard/packages.js";
import type { ConfigView } from "../../../src/dashboard/management.js";
import type { PackageReport } from "../../../src/packages/inspect.js";
import { api, downloadPackage, errorText, uploadPackage } from "../api.js";
import { object, pretty } from "../editors/shared.js";
import { Link, useRouter } from "../router.js";
import { ErrorMessage, Field, Modal } from "../ui.js";
export function PackagesPage({
  changed,
  createChat,
}: {
  changed: () => Promise<void>;
  createChat: (agent?: string) => Promise<void>;
}) {
  const { path, navigate } = useRouter();
  const alias = path.split("/")[3]
    ? decodeURIComponent(path.split("/")[3]!)
    : undefined;
  const [packages, setPackages] = useState<PackageView[]>([]),
    [stages, setStages] = useState<PackageStageView[]>([]),
    [config, setConfig] = useState<ConfigView>();
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("");
  const [localPath, setLocalPath] = useState(""),
    [review, setReview] = useState<PackageStageView>(),
    [installAlias, setInstallAlias] = useState(""),
    [updating, setUpdating] = useState<string>();
  const [exporting, setExporting] = useState(false),
    [exportAgent, setExportAgent] = useState(""),
    [packageName, setPackageName] = useState(""),
    [version, setVersion] = useState("1.0.0"),
    [literals, setLiterals] = useState(false),
    [files, setFiles] = useState("");
  const [bind, setBind] = useState<"agent" | "component">(),
    [exportName, setExportName] = useState(""),
    [kind, setKind] = useState("tools"),
    [name, setName] = useState(""),
    [model, setModel] = useState(""),
    [agent, setAgent] = useState(""),
    [as, setAs] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({}),
    [createdAgent, setCreatedAgent] = useState("");
  const [action, setAction] = useState<"fork" | "remove">(),
    [out, setOut] = useState("");
  const upload = useRef<AbortController | undefined>(undefined);
  const selected = packages.find((item) => item.alias === alias);
  const refresh = async () => {
    const [items, temporary, current] = await Promise.all([
      api<PackageView[]>("/packages"),
      api<PackageStageView[]>("/packages/stages"),
      api<ConfigView>("/config"),
    ]);
    setPackages(items);
    setStages(temporary);
    setConfig(current);
    setExportAgent(
      (old) => old || current.defaultAgent || current.agents[0] || "",
    );
    setModel((old) => old || current.models[0] || "");
    setAgent((old) => old || current.defaultAgent || current.agents[0] || "");
    await changed();
  };
  useEffect(() => {
    void refresh().catch((cause) => setError(errorText(cause)));
  }, [path]);
  useEffect(() => () => upload.current?.abort(), []);
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
  const reviewed = async (stage: PackageStageView) => {
    setReview(stage);
    setInstallAlias(
      updating ?? stage.report.name.split("/").at(-1) ?? "package",
    );
    await refresh();
  };
  const beginBinding = (mode: "agent" | "component") => {
    setError("");
    setInputs({});
    setBind(mode);
    setName("");
    setAs("");
    if (mode === "agent")
      setExportName(selected?.report?.exports.agents[0] ?? "");
    else {
      const first =
        Object.entries(selected?.report?.exports ?? {}).find(
          ([type, names]) => type !== "agents" && names.length,
        )?.[0] ?? "tools";
      setKind(first);
      setExportName(
        selected?.report?.exports[
          first as keyof PackageReport["exports"]
        ]?.[0] ?? "",
      );
    }
  };
  return (
    <div className="management-page">
      <span className="scope">
        Raw config · package lock and artifact store
      </span>
      <div className="section-heading">
        <h1>{alias ?? "Packages"}</h1>
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            setExporting(true);
          }}
        >
          Export agent
        </button>
      </div>
      <p className="muted">
        Inspect → install → activate. Your current default agent is{" "}
        {config?.defaultAgent ?? "not configured"}.
      </p>
      <ErrorMessage>{error}</ErrorMessage>
      <p role="status">{busy ? "Working with package files…" : status}</p>
      {createdAgent && (
        <button
          className="primary"
          onClick={() => {
            void createChat(createdAgent);
          }}
        >
          Chat with {createdAgent}
        </button>
      )}
      {(!alias || updating) && (
        <section className="editor-section">
          <h2>
            {updating ? `Replacement for ${updating}` : "Import a package"}
          </h2>
          <Field
            label="Local package path"
            hint="A source directory or .rawpkg file on this machine; relative paths use the dashboard workspace."
          >
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
            />
          </Field>
          <div className="actions">
            <button
              disabled={busy || !localPath}
              onClick={() => {
                void work(async () =>
                  reviewed(
                    await api<PackageStageView>("/packages/inspect", "POST", {
                      path: localPath,
                    }),
                  ),
                );
              }}
            >
              Inspect path
            </button>
            {updating && (
              <button onClick={() => setUpdating(undefined)}>
                Cancel update
              </button>
            )}
          </div>
          <Field
            label="Upload package archive"
            hint=".rawpkg · maximum 128 MiB"
          >
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
                    await reviewed(
                      await uploadPackage(file, upload.current!.signal),
                    );
                  } finally {
                    upload.current = undefined;
                  }
                });
              }}
            />
          </Field>
          {busy && upload.current && (
            <button onClick={() => upload.current?.abort()}>
              Cancel upload
            </button>
          )}
        </section>
      )}
      {!alias ? (
        <>
          <Field label="Search packages">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </Field>
          <div className="resource-list">
            {packages
              .filter((item) =>
                `${item.alias} ${item.entry.name}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((item) => (
                <div key={item.alias} className="resource-row">
                  <Link
                    href={`/library/packages/${encodeURIComponent(item.alias)}`}
                  >
                    {item.alias}
                  </Link>
                  <span>
                    {item.entry.name} · {item.entry.version}
                  </span>
                  <span className="muted">
                    {item.entry.source.kind === "link"
                      ? "Linked source"
                      : "Immutable artifact"}
                    {item.diagnostic ? " · Needs attention" : ""}
                  </span>
                </div>
              ))}
          </div>
          {!packages.length && (
            <p>
              No packages installed. Inspect a source or upload an archive to
              begin.
            </p>
          )}
        </>
      ) : (
        selected && (
          <>
            <p className="muted">
              {selected.entry.name} · {selected.entry.version} ·{" "}
              {selected.entry.source.kind === "link"
                ? "Linked authored source"
                : "Immutable artifact"}
            </p>
            <p className="config-path">
              {selected.entry.digest ?? selected.entry.source.path}
            </p>
            <ErrorMessage>{selected.diagnostic}</ErrorMessage>
            {selected.report && <PackageReportView report={selected.report} />}
            <p>
              Used by: {selected.usedBy?.join(", ") || "No current bindings"}
            </p>
            <div className="actions">
              <button
                disabled={!selected.report?.exports.agents.length || busy}
                onClick={() => beginBinding("agent")}
              >
                Use agent
              </button>
              <button
                disabled={!selected.report || busy}
                onClick={() => beginBinding("component")}
              >
                Add component
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setError("");
                  setUpdating(alias);
                  setLocalPath("");
                }}
              >
                Update package
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setError("");
                  setAction("fork");
                }}
              >
                Fork package
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setError("");
                  setAction("remove");
                }}
              >
                Remove package
              </button>
            </div>
            <p className="muted">
              Changes affect the next turn of existing sessions. Package agent
              overrides remain complete replacements in{" "}
              <Link href="/agents">Agents</Link>.
            </p>
          </>
        )
      )}
      {stages.length > 0 && (
        <section className="editor-section">
          <h2>Temporary artifacts</h2>
          <p className="muted">
            Up to four for 30 minutes. Downloads remain yours after the server
            stops.
          </p>
          {stages.map((stage) => (
            <div className="resource-row" key={stage.id}>
              <span>
                {stage.report.name} · {stage.report.version}
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  setReview(stage);
                  setInstallAlias(
                    stage.report.name.split("/").at(-1) ?? "package",
                  );
                  setUpdating(undefined);
                }}
              >
                Review
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void work(async () => {
                    await api(`/packages/stages/${stage.id}`, "DELETE");
                    await refresh();
                  });
                }}
              >
                Discard artifact
              </button>
            </div>
          ))}
        </section>
      )}
      <Modal
        open={!!review}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(undefined);
        }}
        title="Review package"
        description="Review exports, inputs and prerequisites before installation. Activation is a separate step."
      >
        <ErrorMessage>{error}</ErrorMessage>
        {review && (
          <>
            <PackageReportView report={review.report} />
            <p className="muted">
              {review.bytes.toLocaleString()} bytes · SHA-256{" "}
              <code className="wrap-anywhere">{review.sha256}</code>
            </p>
            <details>
              <summary>Recipient input schema</summary>
              <pre className="source-preview">{pretty(review.inputs)}</pre>
            </details>
            <Field label="Install alias">
              <input
                value={installAlias}
                disabled={!!updating || busy}
                onChange={(e) => setInstallAlias(e.target.value)}
              />
            </Field>
            <div className="actions">
              <button
                className="primary"
                disabled={!installAlias || busy}
                onClick={() => {
                  void work(async () => {
                    await api("/packages/install", "POST", {
                      stageId: review.id,
                      alias: updating ?? installAlias,
                      action: updating ? "update" : "install",
                    });
                    setStatus(
                      `${updating ? "Updated" : "Installed"} ${updating ?? installAlias}`,
                    );
                    setReview(undefined);
                    setUpdating(undefined);
                    await refresh();
                  });
                }}
              >
                {updating ? `Update ${updating}` : "Install"}
              </button>
              {review.canLink && !updating && (
                <button
                  disabled={!installAlias || busy}
                  onClick={() => {
                    void work(async () => {
                      await api("/packages/install", "POST", {
                        stageId: review.id,
                        alias: installAlias,
                        action: "link",
                      });
                      setStatus(`Linked ${installAlias}`);
                      setReview(undefined);
                      await refresh();
                    });
                  }}
                >
                  Link authored source
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => {
                  void work(() => downloadPackage(review.id));
                }}
              >
                Download archive
              </button>
            </div>
            {review.canLink && (
              <p className="muted">
                Link follows changes to the inspected source directory. Install
                uses the reviewed snapshot.
              </p>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={exporting}
        onOpenChange={(open) => {
          if (!busy) setExporting(open);
        }}
        title="Export agent"
        description="Build a portable archive with recipient-owned model and input decisions."
      >
        <ErrorMessage>{error}</ErrorMessage>
        <Field label="Export agent name">
          <select
            value={exportAgent}
            onChange={(e) => setExportAgent(e.target.value)}
          >
            {config?.agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </Field>
        <Field label="Package name">
          <input
            value={packageName}
            onChange={(e) => setPackageName(e.target.value)}
            placeholder="@you/agent-kit"
          />
        </Field>
        <Field label="Version">
          <input value={version} onChange={(e) => setVersion(e.target.value)} />
        </Field>
        <label className="check-row">
          <input
            type="checkbox"
            checked={literals}
            onChange={(e) => setLiterals(e.target.checked)}
          />
          Include literal variable values
        </label>
        <Field
          label="External files to include"
          hint="One explicitly chosen file per line. Leave empty to keep external files as recipient inputs."
        >
          <textarea value={files} onChange={(e) => setFiles(e.target.value)} />
        </Field>
        <button
          className="primary"
          disabled={busy || !packageName || !exportAgent}
          onClick={() => {
            void work(async () => {
              const stage = await api<PackageStageView>(
                "/packages/export",
                "POST",
                {
                  revision: config?.revision,
                  agent: exportAgent,
                  name: packageName,
                  version,
                  includeLiterals: literals,
                  includeFiles: files
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              );
              setExporting(false);
              setUpdating(undefined);
              await reviewed(stage);
            });
          }}
        >
          Build archive
        </button>
        {error && (
          <button
            onClick={() => {
              void refresh().catch((cause) => setError(errorText(cause)));
            }}
          >
            Reload config, keep form
          </button>
        )}
      </Modal>
      <Modal
        open={!!bind}
        onOpenChange={(open) => {
          if (!open && !busy) setBind(undefined);
        }}
        title={bind === "agent" ? "Use agent" : "Add component"}
        description="Save an explicit recipient binding. Existing default and sessions stay available."
      >
        <ErrorMessage>{error}</ErrorMessage>
        {bind === "component" && (
          <Field label="Component kind">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setExportName(
                  selected?.report?.exports[
                    e.target.value as keyof PackageReport["exports"]
                  ]?.[0] ?? "",
                );
              }}
            >
              {Object.entries(selected?.report?.exports ?? {})
                .filter(([k, values]) => k !== "agents" && values.length)
                .map(([k]) => (
                  <option key={k}>{k}</option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Export name">
          <select
            value={exportName}
            onChange={(e) => setExportName(e.target.value)}
          >
            {selected?.report?.exports[
              (bind === "agent"
                ? "agents"
                : kind) as keyof PackageReport["exports"]
            ]?.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </Field>
        {bind === "agent" ? (
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
            {["tools", "skills", "vars"].includes(kind) && (
              <Field label="Recipient agent">
                <select
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                >
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
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={exportName}
                />
              </Field>
            )}
          </>
        )}
        <TypedInputs
          schema={selected?.inputs ?? {}}
          value={inputs}
          onChange={setInputs}
        />
        <button
          className="primary"
          disabled={
            busy || !exportName || (bind === "agent" && (!name || !model))
          }
          onClick={() => {
            void work(async () => {
              const values = inputValues(selected?.inputs ?? {}, inputs);
              await api(
                `/packages/${encodeURIComponent(alias!)}/${bind}`,
                "POST",
                {
                  revision: config?.revision,
                  exportName,
                  inputs: values,
                  ...(bind === "agent"
                    ? { name, model }
                    : {
                        kind,
                        name: name || exportName,
                        ...(agent && ["tools", "skills", "vars"].includes(kind)
                          ? { agent }
                          : {}),
                        ...(as ? { as } : {}),
                      }),
                },
              );
              setStatus(
                bind === "agent"
                  ? `Agent ${name} created`
                  : "Component binding saved · applies to the next turn",
              );
              if (bind === "agent") setCreatedAgent(name);
              setBind(undefined);
              await refresh();
            });
          }}
        >
          {bind === "agent" ? "Create agent binding" : "Save component binding"}
        </button>
        {error && (
          <button
            onClick={() => {
              void refresh().catch((cause) => setError(errorText(cause)));
            }}
          >
            Reload config, keep form
          </button>
        )}
      </Modal>
      <Modal
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(undefined);
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
        <button
          className="primary"
          disabled={busy || (action === "fork" && !out)}
          onClick={() => {
            void work(async () => {
              if (action === "fork") {
                await api(
                  `/packages/${encodeURIComponent(alias!)}/fork`,
                  "POST",
                  { out },
                );
                setStatus(`Forked to ${out}`);
              } else {
                await api(`/packages/${encodeURIComponent(alias!)}`, "DELETE");
                navigate("/library/packages");
              }
              setAction(undefined);
              await refresh();
            });
          }}
        >
          {action === "fork" ? "Create fork" : "Remove alias"}
        </button>
      </Modal>
    </div>
  );
}
function PackageReportView({ report }: { report: PackageReport }) {
  return (
    <section className="package-report">
      <h2>
        {report.name} <small>{report.version}</small>
      </h2>
      <dl>
        {Object.entries(report.exports)
          .filter(([, values]) => values.length)
          .map(([kind, values]) => (
            <div key={kind}>
              <dt>{kind}</dt>
              <dd>{values.join(", ")}</dd>
            </div>
          ))}
      </dl>
      <p>Raw capabilities: {report.requires.join(", ") || "None declared"}</p>
      <p>
        External executables:{" "}
        {report.prerequisites.join(", ") || "None declared"}
      </p>
      <p className="muted">
        {report.files.length} packaged files · {report.inputs.length} declared
        inputs · Static validation only
      </p>
      <details>
        <summary>Packaged files</summary>
        <ul>
          {report.files.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      </details>
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
        Defaults are applied by Raw. Required fields are checked for the
        selected export; unused package inputs can be left unset.
      </p>
      {Object.entries(object(schema.properties)).map(([name, raw]) => {
        const spec = object(raw),
          set = (v: string) => onChange({ ...value, [name]: v });
        const hint = `${String(spec.type)}${spec["x-raw-kind"] ? ` · ${spec["x-raw-kind"]}` : ""}${required.includes(name) ? " · Required when used" : ""}${spec.description ? ` · ${spec.description}` : ""}${spec.default !== undefined ? ` · Default: ${JSON.stringify(spec.default)}` : ""}`;
        return (
          <div key={name}>
            <Field label={`Input ${name}`} hint={hint}>
              {Array.isArray(spec.enum) ? (
                <select
                  value={value[name] ?? ""}
                  onChange={(e) => set(e.target.value)}
                >
                  <option value="">Unset</option>
                  {spec.enum.map((v: unknown, i: number) => (
                    <option value={JSON.stringify(v)} key={i}>
                      {String(v)}
                    </option>
                  ))}
                </select>
              ) : spec.type === "boolean" || spec.type === "null" ? (
                <select
                  value={value[name] ?? ""}
                  onChange={(e) => set(e.target.value)}
                >
                  <option value="">Unset</option>
                  {(spec.type === "null" ? ["null"] : ["true", "false"]).map(
                    (v) => (
                      <option key={v}>{v}</option>
                    ),
                  )}
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
              <button
                onClick={() =>
                  onChange(
                    Object.fromEntries(
                      Object.entries(value).filter(([key]) => key !== name),
                    ),
                  )
                }
              >
                Unset {name}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
function inputValues(
  schema: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        ([key, value]) =>
          value !== "" ||
          object(object(schema.properties)[key]).type === "string",
      )
      .map(([key, value]) => {
        const spec = object(object(schema.properties)[key]);
        try {
          return [
            key,
            spec.type === "string" && !spec.enum
              ? value
              : (JSON.parse(value) as unknown),
          ];
        } catch {
          throw new Error(
            `Input ${key} must be a valid ${String(spec.type)} value`,
          );
        }
      }),
  );
}
