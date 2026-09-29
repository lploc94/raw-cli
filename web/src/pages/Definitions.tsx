import { useEffect, useState } from "react";
import type {
  CheckView,
  ConfigView,
} from "../../../src/dashboard/management.js";
import { api, errorText } from "../api.js";
import { useConfig } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { ErrorMessage, Field } from "../ui.js";
import {
  configDocument,
  DraftActions,
  object,
  parseObject,
  pretty,
  SourceEditor,
  useDraft,
} from "../editors/shared.js";
export function DefinitionsPage({
  kind,
  changed,
}: {
  kind: "vars" | "mcp";
  changed: () => Promise<void>;
}) {
  const { data: config, error: configError } = useConfig();
  const [editing, setEditing] = useState(false),
    [agent, setAgent] = useState(""),
    [name, setName] = useState("");
  const [error, setError] = useState(""),
    [check, setCheck] = useState<CheckView>(),
    [selected, setSelected] = useState<string[]>([]),
    [status, setStatus] = useState("");
  const refresh = changed;
  useEffect(() => {
    if (config)
      setAgent((old) => old || config.defaultAgent || config.agents[0] || "");
  }, [config]);
  useEffect(() => {
    if (check?.state !== "running") return;
    const timer = setTimeout(() => {
      void api<CheckView>(`/checks/${check.id}`).then(setCheck, (cause) =>
        setError(errorText(cause)),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [check]);
  const names = kind === "vars" ? config?.vars : config?.mcp;
  const tools = (object(check?.result).tools ?? []) as Array<{
    originalName: string;
    identity: string;
    alias: string;
  }>;
  const gate = usePageGate({ ready: !!config, error: configError, onRetry: () => void changed(), label: "Loading definitions" });
  if (gate) return gate;
  return (
    <div className="management-page">
      <span className="scope">Raw config</span>
      <h1>{kind === "vars" ? "Vars & providers" : "MCP servers"}</h1>
      <p className="muted">
        {kind === "vars"
          ? "Define literal, environment, file or provider variables; choose access and cache TTL. Agent selections decide availability."
          : "Define stdio or HTTP connections and package bindings. Save validates structure; discovery connects only after your explicit action."}
      </p>
      <ErrorMessage>{error || (configError ? errorText(configError) : "")}</ErrorMessage>
      <div className="resource-list">
        {names?.map((item) => (
          <div className="resource-row" key={item}>
            <strong>{item}</strong>
            <span className="muted">Not checked</span>
            <button onClick={() => setName(item)}>Select for check</button>
          </div>
        ))}
      </div>
      {!names?.length && (
        <p>
          No {kind === "vars" ? "variables" : "MCP servers"} configured. Open
          definitions to add one.
        </p>
      )}
      <button onClick={() => setEditing(true)}>
        {editing ? "Definitions open" : "Edit definitions"}
      </button>
      {editing && <DefinitionEditor key={kind} kind={kind} changed={refresh} />}
      <section className="editor-section">
        <h2>{kind === "vars" ? "Read a variable" : "Discover tools"}</h2>
        <p className="muted">
          {kind === "vars"
            ? "Uses the selected agent. access=use values cannot be read. Each check uses a fresh resolver."
            : "Starts the configured connection, validates advertised schemas, then closes it. Does not call any tool."}
        </p>
        <div className="actions">
          <Field label="Check agent">
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              {config?.agents.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </Field>
          <Field label={kind === "vars" ? "Variable name" : "MCP server name"}>
            <input
              list="check-names"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <datalist id="check-names">
            {names?.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <button
            disabled={!agent || !name || check?.state === "running"}
            onClick={() => {
              setError("");
              setSelected([]);
              void api<CheckView>("/checks", "POST", {
                kind: kind === "vars" ? "var" : "mcp",
                agent,
                name,
                revision: config?.revision,
              }).then(setCheck, (cause) => setError(errorText(cause)));
            }}
          >
            {kind === "vars" ? "Read" : "Discover"}
          </button>
          {check?.state === "running" && (
            <button
              onClick={() => {
                void api<CheckView>(
                  `/checks/${check.id}/cancel`,
                  "POST",
                  {},
                ).then(setCheck, (cause) => setError(errorText(cause)));
              }}
            >
              Cancel check
            </button>
          )}
        </div>
        {check && (
          <>
            <p role="status">
              {check.agent} / {check.name} · Check {check.state}
              {check.finishedAt
                ? ` · ${new Date(check.finishedAt).toLocaleTimeString()}`
                : ""}
            </p>
            <ErrorMessage>{check.error}</ErrorMessage>
            {check.result !== undefined &&
              (kind === "vars" ? (
                <pre className="source-preview">{pretty(check.result)}</pre>
              ) : (
                <>
                  <p className="muted">
                    Original names and canonical policy identities from this
                    discovery:
                  </p>
                  {tools.map((tool) => (
                    <label className="check-row" key={tool.alias}>
                      <input
                        type="checkbox"
                        checked={selected.includes(tool.originalName)}
                        onChange={(e) =>
                          setSelected((old) =>
                            e.target.checked
                              ? [...old, tool.originalName]
                              : old.filter((n) => n !== tool.originalName),
                          )
                        }
                      />
                      <span>
                        {tool.originalName}
                        <small>{tool.identity}</small>
                      </span>
                    </label>
                  ))}
                  <button
                    disabled={!selected.length}
                    onClick={() => {
                      void (async () => {
                        try {
                          const entry = await api<{
                            value: Record<string, any>;
                            revision: string;
                          }>(`/agents/${encodeURIComponent(check.agent)}`);
                          if (entry.value.from)
                            throw new Error(
                              "For a package agent, edit its complete tools override in Agents → Agent JSON using the identities above.",
                            );
                          const current = object(entry.value.tools);
                          const ids = selected.map(
                            (tool) => `mcp/${check.name}/${tool}`,
                          );
                          await api("/agents", "POST", {
                            revision: entry.revision,
                            action: "patch",
                            name: check.agent,
                            value: {
                              tools: {
                                ...current,
                                use: [
                                  ...new Set([...(current.use ?? []), ...ids]),
                                ],
                              },
                            },
                          });
                          await refresh();
                          setStatus(
                            `Selected for ${check.agent} · applies to the next turn`,
                          );
                        } catch (cause) {
                          setError(errorText(cause));
                        }
                      })();
                    }}
                  >
                    Add selected tools to agent
                  </button>
                </>
              ))}
          </>
        )}
        <p role="status">{status}</p>
      </section>
    </div>
  );
}
function DefinitionEditor({
  kind,
  changed,
}: {
  kind: "vars" | "mcp";
  changed: () => Promise<void>;
}) {
  const keys = kind === "vars" ? ["vars", "var_providers"] : ["mcp"];
  const draft = useDraft(
    `definitions:${kind}`,
    async () => {
      const document = await configDocument(),
        data = parseObject(document.source);
      return {
        source: pretty(
          Object.fromEntries(
            keys.map((key) => [
              key,
              data[key] ?? (key === "mcp" ? { servers: {} } : {}),
            ]),
          ),
        ),
        revision: document.revision,
      };
    },
    (value) => {
      const data = parseObject(value.source);
      if (Object.keys(data).some((key) => !keys.includes(key)))
        throw new Error(`This editor accepts only ${keys.join(", ")}`);
      return api<ConfigView>("/config", "PATCH", {
        revision: value.revision,
        patch: Object.fromEntries(keys.map((key) => [key, data[key] ?? null])),
      });
    },
    changed,
  );
  const sample =
    kind === "vars"
      ? {
          vars: {
            now: {
              description: "Current UTC time",
              type: "string",
              access: "read",
              cache_ttl_ms: 0,
              source: { kind: "provider", name: "system.time" },
            },
          },
          var_providers: {},
        }
      : {
          mcp: {
            servers: {
              example: {
                transport: "stdio",
                command: "node",
                args: ["/absolute/path/server.mjs"],
              },
            },
          },
        };
  return (
    <section className="editor-section">
      <h2>Definitions JSON</h2>
      <DraftActions draft={draft} />
      <SourceEditor
        label="Definitions JSON"
        value={draft.source}
        onChange={draft.setSource}
        readOnly={draft.busy}
      />
      <details>
        <summary>Schema example</summary>
        <pre className="source-preview">{pretty(sample)}</pre>
        <p>
          Keep existing definitions when adding new entries. Removing selected
          definitions requires updating their agent selections in the full
          config editor.
        </p>
      </details>
    </section>
  );
}
