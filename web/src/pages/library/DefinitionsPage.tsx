import { useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import type { CheckView, ConfigView } from "../../../../src/dashboard/management.js";
import { api, errorText } from "../../api.js";
import { configDocument, DraftActions, object, parseObject, pretty, SourceEditor, useDraft } from "../../editors/shared.js";
import { Empty, ErrorMessage, Field } from "../../ui.js";

type Kind = "vars" | "mcp";
type Section = "overview" | "definitions" | "check";

const copy: Record<Kind, { title: string; description: string; empty: string; check: string; run: string; nameLabel: string }> = {
  vars: {
    title: "Vars & providers",
    description: "Literal, environment, file or provider values. Agent selections decide availability; viewing never reads a value.",
    empty: "No variables yet",
    check: "Read a variable",
    run: "Read",
    nameLabel: "Variable name",
  },
  mcp: {
    title: "MCP servers",
    description: "Stdio or HTTP connections. Saving validates structure; Raw connects only when you run Discover.",
    empty: "No MCP servers yet",
    check: "Discover tools",
    run: "Discover",
    nameLabel: "MCP server name",
  },
};
const transportLabel: Record<string, string> = { stdio: "stdio", "streamable-http": "HTTP" };
const usage = (names: string[], noun = "") =>
  names.length ? `Used by ${names.length}${noun ? ` ${noun}${names.length === 1 ? "" : "s"}` : ""}` : "Not selected";

export function DefinitionsPage({
  kind,
  config,
  changed,
  error,
  onRetry,
}: {
  kind: Kind;
  config: ConfigView;
  changed: () => Promise<void>;
  /** A failed refresh while the cached config is still shown. */
  error?: string;
  onRetry?: () => void;
}) {
  const text = copy[kind];
  // Local state, not the URL: every navigation while dirty opens the leave guard.
  const [section, setSection] = useState<Section>("overview");
  const [name, setName] = useState("");
  // Each row action bumps this; the Check panel focuses its run button once it can take focus.
  const [focusRequest, setFocusRequest] = useState(0);
  const names = kind === "vars" ? config.vars : config.mcp;
  const draft = useDefinitionsDraft(kind, changed);
  const editDefinitions = <button onClick={() => setSection("definitions")}>Edit definitions</button>;
  // Prefills the check without running it; running stays an explicit action.
  const prepareCheck = (item: string) => {
    setName(item);
    setSection("check");
    setFocusRequest((value) => value + 1);
  };
  const panel = (value: Section) => ({
    value,
    forceMount: true as const,
    hidden: section !== value,
    className: "detail-panel",
  });
  return (
    <div className="management-page definitions-page">
      <header className="resource-header">
        <div>
          <h1>{text.title}</h1>
          <p className="muted">{text.description}</p>
        </div>
        {(names.length > 0 || (kind === "vars" && config.providers.length > 0)) && section !== "definitions" && editDefinitions}
      </header>
      {error && (
        <ErrorMessage>
          Could not refresh the config. {error}{" "}
          <button className="text-button" onClick={onRetry}>
            Try again
          </button>
        </ErrorMessage>
      )}
      <Tabs.Root value={section} onValueChange={(next) => setSection(next as Section)}>
        <Tabs.List className="tabs page-tabs" aria-label="Definition sections">
          <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
          <Tabs.Trigger value="definitions">
            Definitions
            {draft.dirty && <span className="badge warning tab-badge">Unsaved</span>}
          </Tabs.Trigger>
          <Tabs.Trigger value="check">Check</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content {...panel("overview")}>
          {!names.length && !(kind === "vars" && config.providers.length) ? (
            <Empty title={text.empty} action={editDefinitions}>
              {text.description}
            </Empty>
          ) : kind === "vars" ? (
            <>
              {!names.length && (
                <div className="card notice">
                  <p>No variables yet. Providers below are unused until a variable names them.</p>
                </div>
              )}
              {names.length > 0 && <ul className="data-table" aria-label="Variables">
                {names.map((item) => {
                  const summary = config.varSummaries?.[item];
                  return (
                    <li key={item} className="data-row definition-row">
                      <div className="definition-name-cell">
                        <strong className="definition-name">{item}</strong>
                        {summary?.description && <span className="muted">{summary.description}</span>}
                      </div>
                      <div className="metadata definition-badges">
                        {summary?.source && <span className="badge">{summary.source}</span>}
                        {summary?.access && (
                          <span className={`badge ${summary.access === "use" ? "warning" : ""}`}>
                            {summary.access === "use" ? "use only" : "read"}
                          </span>
                        )}
                        {summary?.type && <code>{summary.type}</code>}
                      </div>
                      <span className="muted definition-usage" title={summary?.usedBy.join(", ")}>
                        {usage(summary?.usedBy ?? [])}
                      </span>
                      <div className="actions">
                        <button aria-label={`Check ${item}`} onClick={() => prepareCheck(item)}>
                          Check
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>}
              {config.providers.length > 0 && (
                <section className="card">
                  <div className="card-header">
                    <div>
                      <h2>Providers</h2>
                      <p>Commands that produce provider values. They run only for an explicit read or a turn.</p>
                    </div>
                  </div>
                  <ul className="used-by-list" aria-label="Providers">
                    {config.providers.map((id) => {
                      const users = config.providerSummaries?.[id]?.usedBy ?? [];
                      return (
                        <li key={id}>
                          <strong className="definition-name used-by-name">{id}</strong>
                          <span className="muted" title={users.join(", ")}>
                            {users.length ? usage(users, "var") : "No vars"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <ul className="data-table" aria-label="MCP servers">
              {names.map((item) => {
                const summary = config.mcpSummaries?.[item];
                return (
                  <li key={item} className="data-row definition-row">
                    <div className="definition-name-cell">
                      <strong className="definition-name">{item}</strong>
                    </div>
                    <div className="metadata definition-badges">
                      {summary?.transport && <span className="badge">{transportLabel[summary.transport] ?? summary.transport}</span>}
                    </div>
                    <span className="muted definition-usage" title={summary?.usedBy.join(", ")}>
                      {usage(summary?.usedBy ?? [])}
                    </span>
                    <div className="actions">
                      <button aria-label={`Discover ${item}`} onClick={() => prepareCheck(item)}>
                        Discover
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Tabs.Content>
        <Tabs.Content {...panel("definitions")}>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Definitions JSON</h2>
                <p>
                  {kind === "vars" ? "The vars and var_providers blocks" : "The mcp block"} of this config. Keep existing
                  definitions when adding new entries.
                </p>
              </div>
            </div>
            {!draft.base && <ErrorMessage>{draft.error}</ErrorMessage>}
            <SourceEditor label="Definitions JSON" value={draft.source} onChange={draft.setSource} readOnly={draft.busy || !draft.base} />
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Schema example</h2>
                <p>Removing a selected definition also requires updating the agents that select it.</p>
              </div>
            </div>
            <pre className="code-sample">{pretty(sample[kind])}</pre>
          </section>
        </Tabs.Content>
        <Tabs.Content {...panel("check")}>
          <CheckPanel
            kind={kind}
            config={config}
            name={name}
            setName={setName}
            active={section === "check"}
            focusRequest={focusRequest}
            changed={changed}
          />
        </Tabs.Content>
      </Tabs.Root>
      {/* The draft survives other tabs; its bar stays with the editor so Check keeps one status and one error. */}
      {draft.base && section === "definitions" && <DraftActions draft={draft} variant="bar" />}
    </div>
  );
}

const sample: Record<Kind, unknown> = {
  vars: {
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
  },
  mcp: { mcp: { servers: { example: { transport: "stdio", command: "node", args: ["/absolute/path/server.mjs"] } } } },
};

function useDefinitionsDraft(kind: Kind, changed: () => Promise<void>) {
  const keys = kind === "vars" ? ["vars", "var_providers"] : ["mcp"];
  return useDraft(
    `definitions:${kind}`,
    async () => {
      const document = await configDocument(),
        data = parseObject(document.source);
      return {
        source: pretty(Object.fromEntries(keys.map((key) => [key, data[key] ?? (key === "mcp" ? { servers: {} } : {})]))),
        revision: document.revision,
      };
    },
    (value) => {
      const data = parseObject(value.source);
      if (Object.keys(data).some((key) => !keys.includes(key))) throw new Error(`This editor accepts only ${keys.join(", ")}`);
      return api<ConfigView>("/config", "PATCH", {
        revision: value.revision,
        patch: Object.fromEntries(keys.map((key) => [key, data[key] ?? null])),
      });
    },
    changed,
  );
}

function CheckPanel({
  kind,
  config,
  name,
  setName,
  active,
  focusRequest,
  changed,
}: {
  kind: Kind;
  config: ConfigView;
  name: string;
  setName: (name: string) => void;
  active: boolean;
  focusRequest: number;
  changed: () => Promise<void>;
}) {
  const runButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(0);
  const text = copy[kind];
  const names = kind === "vars" ? config.vars : config.mcp;
  const [agent, setAgent] = useState(config.defaultAgent || config.agents[0] || "");
  const [check, setCheck] = useState<CheckView>();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState("");
  useEffect(() => {
    if (!config.agents.includes(agent)) setAgent(config.defaultAgent || config.agents[0] || "");
  }, [config.agents.join("\0"), config.defaultAgent]);
  useEffect(() => {
    if (check?.state !== "running") return;
    const timer = setTimeout(() => {
      void api<CheckView>(`/checks/${check.id}`).then(setCheck, (cause) => setError(errorText(cause)));
    }, 400);
    return () => clearTimeout(timer);
  }, [check]);
  // A request stays pending while the button is disabled, such as during a running check.
  useEffect(() => {
    const button = runButton.current;
    if (!active || focused.current === focusRequest || !button || button.disabled) return;
    button.focus();
    focused.current = focusRequest;
  });
  const tools = (object(check?.result).tools ?? []) as Array<{ originalName: string; identity: string; alias: string }>;
  const addSelected = async () => {
    if (!check) return;
    try {
      setError("");
      const entry = await api<{ value: Record<string, any>; revision: string }>(`/agents/${encodeURIComponent(check.agent)}`);
      if (entry.value.from)
        throw new Error("For a package agent, edit its complete tools override in Agents → Agent JSON using the identities above.");
      const current = object(entry.value.tools);
      const ids = selected.map((tool) => `mcp/${check.name}/${tool}`);
      await api("/agents", "POST", {
        revision: entry.revision,
        action: "patch",
        name: check.agent,
        value: { tools: { ...current, use: [...new Set([...(current.use ?? []), ...ids])] } },
      });
      await changed();
      setSelection(`Selected for ${check.agent} · applies to the next turn`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const failure = error || check?.error || "";
  return (
    <>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>{text.check}</h2>
            <p>
              {kind === "vars"
                ? "Uses the selected agent. access=use values cannot be read. Each check uses a fresh resolver."
                : "Starts the configured connection, validates advertised schemas, then closes it. Does not call any tool."}
            </p>
          </div>
        </div>
        <div className="actions check-fields">
          <Field label="Check agent">
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              {config.agents.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </Field>
          <Field label={text.nameLabel}>
            <input list={`check-names-${kind}`} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <datalist id={`check-names-${kind}`}>
            {names.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <button
            ref={runButton}
            className="primary"
            disabled={!agent || !name || check?.state === "running"}
            onClick={() => {
              setError("");
              setSelection("");
              setSelected([]);
              void api<CheckView>("/checks", "POST", {
                kind: kind === "vars" ? "var" : "mcp",
                agent,
                name,
                revision: config.revision,
              }).then(setCheck, (cause) => setError(errorText(cause)));
            }}
          >
            {text.run}
          </button>
          {check?.state === "running" && (
            <button
              onClick={() => {
                void api<CheckView>(`/checks/${check.id}/cancel`, "POST", {}).then(setCheck, (cause) => setError(errorText(cause)));
              }}
            >
              Cancel check
            </button>
          )}
        </div>
      </section>
      {(check || failure) && (
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Result</h2>
            </div>
          </div>
          {check && (
            <p role="status" className="check-status">
              {check.agent} / {check.name} · Check {check.state}
              {check.finishedAt && <span className="badge">{new Date(check.finishedAt).toLocaleTimeString()}</span>}
              {selection && ` · ${selection}`}
            </p>
          )}
          <ErrorMessage>{failure}</ErrorMessage>
          {check?.result !== undefined &&
            (kind === "vars" ? (
              <pre className="source-preview">{pretty(check.result)}</pre>
            ) : (
              <>
                <p className="muted">Original names and canonical policy identities from this discovery:</p>
                {tools.map((tool) => (
                  <label className="check-row" key={tool.alias}>
                    <input
                      type="checkbox"
                      checked={selected.includes(tool.originalName)}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked ? [...old, tool.originalName] : old.filter((n) => n !== tool.originalName),
                        )
                      }
                    />
                    <span>
                      {tool.originalName}
                      <small>{tool.identity}</small>
                    </span>
                  </label>
                ))}
                <div className="actions">
                  <button disabled={!selected.length} onClick={() => void addSelected()}>
                    Add selected tools to agent
                  </button>
                </div>
              </>
            ))}
        </section>
      )}
    </>
  );
}
