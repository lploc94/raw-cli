import { useEffect, useState } from "react";
import type { ConfigView } from "../../../src/dashboard/management.js";
import { api, errorText } from "../api.js";
import { useConfig } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { Link, useRouter } from "../router.js";
import { CopyButton, ErrorMessage, Field, Modal } from "../ui.js";
import {
  configDocument,
  DraftActions,
  object,
  parseObject,
  patch,
  pretty,
  SourceEditor,
  useDraft,
} from "../editors/shared.js";
export const settingGroups = [
  {
    id: "general",
    label: "General",
    keys: "default_agent config path setup initialize repair",
    scope: "Raw config",
  },
  {
    id: "models",
    label: "Models & connections",
    keys: "provider method model_id base_url api_key api_key_env context_window_tokens max_output_tokens vision credentials",
    scope: "Raw config",
  },
  {
    id: "appearance",
    label: "Appearance",
    keys: "theme density font size panel width dark light",
    scope: "This browser",
  },
  {
    id: "chat",
    label: "Chat & keyboard",
    keys: "Enter shortcuts reasoning tool detail follow output",
    scope: "This browser",
  },
  {
    id: "sessions",
    label: "Sessions & storage",
    keys: "sessions.retention_days history storage",
    scope: "Raw config",
  },
  {
    id: "diagnostics",
    label: "Diagnostics & advanced",
    keys: "JSON ui request compact cache timeout diagnostics version port repair",
    scope: "Raw config",
  },
];
export function SettingsSearch() {
  const [search, setSearch] = useState("");
  return (
    <div className="settings-search">
      <Field label="Search settings">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search labels or config keys"
        />
      </Field>
      {search && (
        <div className="search-results">
          {settingGroups
            .filter((g) =>
              `${g.label} ${g.keys}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((g) => (
              <Link
                key={g.id}
                href={`/settings/${g.id}`}
                onClick={() => setSearch("")}
              >
                {g.label}
                <small>
                  {g.scope} · {g.keys}
                </small>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
export function SettingsPage({
  changed,
  createChat,
}: {
  changed: () => Promise<void>;
  createChat: (name?: string) => Promise<void>;
}) {
  const { path } = useRouter(),
    category = path.split("/")[2] || "general";
  const { data: config, error: configError } = useConfig();
  const [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const [generalDirty, setGeneralDirty] = useState(false);
  const [editing, setEditing] = useState(false),
    [diagnostics, setDiagnostics] = useState<unknown>();
  // `changed` revalidates the shared `/config` (and bootstrap), so it is the refresh.
  const refresh = changed;
  // Hooks run before the early return below so their order never depends on the category.
  const gate = usePageGate({ ready: !!config, error: configError, onRetry: () => void changed(), label: "Loading settings" });
  if (category === "models")
    return <ModelsPage changed={changed} createChat={createChat} />;
  if (gate) return gate;
  return (
    <div className="management-page">
      <span className="scope">Raw config</span>
      <h1>
        {settingGroups.find((g) => g.id === category)?.label ?? "Settings"}
      </h1>
      <p className="muted config-path">{config?.path}</p>
      <ErrorMessage>{error || (configError ? errorText(configError) : "")}</ErrorMessage>
      <p role="status">{status}</p>
      {config && !config.exists && (
        <section>
          <h2>Set up Raw</h2>
          <p>
            Create the shared starter agent with seven setup skills, then
            configure a model.
          </p>
          <button
            className="primary"
            onClick={() => {
              void api("/config/initialize", "POST", {}).then(
                async () => {
                  await refresh();
                  setStatus("Config initialized");
                },
                (cause) => setError(errorText(cause)),
              );
            }}
          >
            Initialize Raw
          </button>
        </section>
      )}
      {config?.exists && !config.valid && (
        <ErrorMessage>
          {config.diagnostic} Open the config editor to repair this file.
        </ErrorMessage>
      )}
      {category === "general" && config?.valid && !editing && (
        <GeneralSettings
          key={config.path}
          changed={refresh}
          config={config}
          onDirty={setGeneralDirty}
        />
      )}
      {category === "sessions" && config && (
        <>
          {config.canonical ? (
            <RetentionEditor changed={refresh} />
          ) : (
            <p className="notice">
              Retention is read-only here. It belongs to {config.canonicalPath}.
              Restart without --config to edit the canonical settings; this page
              does not write another file.
            </p>
          )}
          <p>
            Session history and model context share the same store as the CLI.
            Retention follows conversational activity, not page views.
          </p>
          <Link href="/chat">Manage sessions</Link>
        </>
      )}
      {(category === "diagnostics" || category === "sessions") && (
        <section className="editor-section">
          <h2>Local diagnostics</h2>
          <p className="muted">
            Version, config and storage metadata only. No conversation bodies,
            credentials, variable readings or command arguments.
          </p>
          <button
            onClick={() => {
              void api("/diagnostics").then(setDiagnostics, (cause) =>
                setError(errorText(cause)),
              );
            }}
          >
            Refresh diagnostics
          </button>
          {diagnostics !== undefined && (
            <>
              <CopyButton
                value={pretty(diagnostics)}
                label="Copy diagnostics"
              />
              <pre className="source-preview">{pretty(diagnostics)}</pre>
            </>
          )}
          <p>
            Listener and config authority are launch options. Restart with{" "}
            <code>raw dashboard --port PORT --config PATH</code> to change them.
          </p>
        </section>
      )}
      {(category === "diagnostics" ||
        category === "general" ||
        !config?.valid) && (
        <section className="editor-section">
          <h2>Advanced config</h2>
          <p className="muted">
            Explicitly opens the full config, including credentials, into this
            editor's memory. Nothing is saved in browser preferences.
          </p>
          <button disabled={generalDirty} onClick={() => setEditing(true)}>
            Open config editor
          </button>
          {generalDirty && (
            <p>
              Save or discard the default-agent change before opening another
              editor.
            </p>
          )}
          {editing && <ConfigEditor changed={refresh} />}
        </section>
      )}
    </div>
  );
}
function GeneralSettings({
  config,
  changed,
  onDirty,
}: {
  config: ConfigView;
  changed: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const draft = useDraft(
    "default-agent",
    async () => {
      const current = await api<ConfigView>("/config");
      return {
        source: pretty({ default_agent: current.defaultAgent }),
        revision: current.revision,
      };
    },
    (value) =>
      api<ConfigView>("/config", "PATCH", {
        revision: value.revision,
        patch: parseObject(value.source),
      }),
    changed,
  );
  useEffect(() => {
    onDirty(draft.dirty);
    return () => onDirty(false);
  }, [draft.dirty]);
  return (
    <section>
      <Field
        label="Default agent"
        hint="Used by raw and new sessions when no agent is supplied."
      >
        <select
          disabled={!draft.base || draft.busy}
          value={
            draft.source
              ? String(parseObject(draft.source).default_agent ?? "")
              : ""
          }
          onChange={(e) =>
            draft.setSource(pretty({ default_agent: e.target.value }))
          }
        >
          <option value="" disabled>
            Choose an agent
          </option>
          {config.agents.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </Field>
      <DraftActions draft={draft} />
    </section>
  );
}
function RetentionEditor({ changed }: { changed: () => Promise<void> }) {
  const draft = useDraft(
    "retention",
    async () => {
      const config = await api<ConfigView>("/config");
      return {
        source: pretty(config.sessions ?? {}),
        revision: config.revision,
      };
    },
    (value) =>
      api<ConfigView>("/config", "PATCH", {
        revision: value.revision,
        patch: { sessions: parseObject(value.source) },
      }),
    changed,
  );
  return (
    <section>
      <h2>Retention</h2>
      <p className="muted">
        Canonical config only. Empty settings use the existing Raw default.
      </p>
      <Field label="Retention days">
        <input
          type="number"
          min="1"
          value={
            draft.source
              ? String(parseObject(draft.source).retention_days ?? "")
              : ""
          }
          onChange={(e) =>
            draft.setSource(
              pretty(
                e.target.value
                  ? { retention_days: Number(e.target.value) }
                  : {},
              ),
            )
          }
        />
      </Field>
      <DraftActions draft={draft} />
    </section>
  );
}
function ConfigEditor({ changed }: { changed: () => Promise<void> }) {
  const [validation, setValidation] = useState("");
  const draft = useDraft(
    "full-config",
    configDocument,
    (value) => api<ConfigView>("/config/document", "PUT", value),
    changed,
  );
  return (
    <>
      <DraftActions draft={draft} />
      <SourceEditor
        label="Config JSON"
        value={draft.source}
        onChange={draft.setSource}
        readOnly={draft.busy}
      />
      <button
        onClick={() => {
          void api("/config/validate", "POST", { source: draft.source }).then(
            () => setValidation("Valid structure · no runtime executed"),
            (cause) => setValidation(errorText(cause)),
          );
        }}
      >
        Validate JSON
      </button>
      <p role="status">{validation}</p>
    </>
  );
}
function ModelsPage({
  changed,
  createChat,
}: {
  changed: () => Promise<void>;
  createChat: (name?: string) => Promise<void>;
}) {
  const { path, navigate } = useRouter();
  const name = path.split("/")[3]
    ? decodeURIComponent(path.split("/")[3]!)
    : undefined;
  const { data: config, error: configError } = useConfig();
  const [creating, setCreating] = useState(false),
    [alias, setAlias] = useState(""),
    [modelId, setModelId] = useState(""),
    [error, setError] = useState("");
  const refresh = changed;
  const gate = usePageGate({ ready: !!config, error: configError, onRetry: () => void changed(), label: "Loading models" });
  if (gate) return gate;
  return (
    <div className="management-page">
      <span className="scope">Raw config</span>
      <div className="section-heading">
        <h1>{name ?? "Models & connections"}</h1>
        <button onClick={() => setCreating(true)}>Create model</button>
      </div>
      <p className="muted">
        Saving validates configuration. Credentials are tested only when you
        send a message.
      </p>
      <ErrorMessage>{error || (configError ? errorText(configError) : "")}</ErrorMessage>
      {name ? (
        <ModelEditor
          key={name}
          name={name}
          config={config}
          changed={refresh}
          createChat={createChat}
        />
      ) : (
        <div className="resource-list">
          {config?.models.map((alias) => (
            <div className="resource-row" key={alias}>
              <Link href={`/settings/models/${encodeURIComponent(alias)}`}>
                {alias}
              </Link>
              <span className="muted">Not checked</span>
            </div>
          ))}
        </div>
      )}
      {!name && !config?.models.length && (
        <p>No models. Create a connection, then select it in an agent.</p>
      )}
      <Modal
        open={creating}
        onOpenChange={setCreating}
        title="Create model"
        description="Starts with an OpenAI chat connection. Edit service, method and endpoint after creation."
      >
        <ErrorMessage>{error}</ErrorMessage>
        <Field label="Model alias">
          <input value={alias} onChange={(e) => setAlias(e.target.value)} />
        </Field>
        <Field label="Model ID">
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} />
        </Field>
        <button
          className="primary"
          disabled={!alias || !modelId}
          onClick={() => {
            void api("/models", "POST", {
              revision: config?.revision,
              action: "create",
              name: alias,
              value: {
                provider: "openai",
                method: "openai-chat-completions",
                model_id: modelId,
              },
            }).then(
              async () => {
                await refresh();
                setCreating(false);
                navigate(`/settings/models/${encodeURIComponent(alias)}`);
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Create
        </button>
      </Modal>
    </div>
  );
}
function ModelEditor({
  name,
  config,
  changed,
  createChat,
}: {
  name: string;
  config: ConfigView | undefined;
  changed: () => Promise<void>;
  createChat: (name?: string) => Promise<void>;
}) {
  const { navigate } = useRouter();
  const [credential, setCredential] = useState<{
    present: boolean;
    env?: string;
  }>({ present: false });
  const [action, setAction] = useState(""),
    [newName, setNewName] = useState(""),
    [error, setError] = useState(""),
    [testAgent, setTestAgent] = useState(""),
    [agentNames, setAgentNames] = useState<string[]>([]);
  const draft = useDraft(
    `model:${name}`,
    async () => {
      const entry = await api<{
        value: unknown;
        revision: string;
        credential: typeof credential;
      }>(`/models/${encodeURIComponent(name)}`);
      setCredential(entry.credential);
      return {
        source: pretty({
          source: pretty(entry.value),
          credential: { mode: "keep" },
        }),
        revision: entry.revision,
      };
    },
    async (value, before) => {
      const input = parseObject(value.source),
        original = parseObject(before);
      const saved = await api<ConfigView>("/models", "POST", {
        revision: value.revision,
        action: "patch",
        name,
        value: patch(String(original.source), String(input.source)),
        credential: input.credential,
      });
      if (input.credential.mode === "clear") setCredential({ present: false });
      else if (input.credential.mode === "set")
        setCredential(
          input.credential.env !== undefined
            ? { present: false, env: input.credential.env }
            : { present: true },
        );
      return {
        revision: saved.revision,
        source: pretty({ source: input.source, credential: { mode: "keep" } }),
      };
    },
    changed,
  );
  useEffect(() => {
    let alive = true;
    void Promise.all(
      (config?.agents ?? []).map(async (agent) => ({
        agent,
        ...(await api<{ value: { model?: string } }>(
          `/agents/${encodeURIComponent(agent)}`,
        )),
      })),
    ).then(
      (rows) => {
        if (alive)
          setAgentNames(
            rows
              .filter((row) => row.value.model === name)
              .map((row) => row.agent),
          );
      },
      (cause) => {
        if (alive) setError(errorText(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [config?.revision]);
  const wrapper = draft.source ? parseObject(draft.source) : {},
    edit = object(wrapper.credential);
  let value: Record<string, any> = {},
    invalid = "";
  try {
    if (wrapper.source) value = parseObject(wrapper.source);
  } catch (cause) {
    invalid = errorText(cause);
  }
  const set = (fields: Record<string, unknown>) => {
    const next = { ...value, ...fields };
    for (const key of Object.keys(next))
      if (next[key] === undefined) delete next[key];
    draft.setSource(pretty({ ...wrapper, source: pretty(next) }));
  };
  return (
    <>
      <DraftActions draft={draft} />
      <ErrorMessage>{error}</ErrorMessage>
      <fieldset
        disabled={!draft.base || draft.busy || !!invalid}
        className="editor-fields"
      >
        <Field label="Provider">
          <input
            value={String(value.provider ?? "")}
            onChange={(e) => set({ provider: e.target.value })}
          />
        </Field>
        <Field label="API method">
          <select
            value={String(value.method ?? "openai-chat-completions")}
            onChange={(e) => set({ method: e.target.value })}
          >
            {[
              "openai-chat-completions",
              "openai-responses",
              "anthropic-messages",
              "google-generate-content",
            ].map((method) => (
              <option key={method}>{method}</option>
            ))}
          </select>
        </Field>
        <Field label="Model ID">
          <input
            value={String(value.model_id ?? "")}
            onChange={(e) => set({ model_id: e.target.value })}
          />
        </Field>
        <Field label="Base URL">
          <input
            value={String(value.base_url ?? "")}
            onChange={(e) => set({ base_url: e.target.value || undefined })}
          />
        </Field>
        <Field label="Context window tokens">
          <input
            type="number"
            value={String(value.context_window_tokens ?? "")}
            onChange={(e) =>
              set({
                context_window_tokens: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
          />
        </Field>
        <Field label="Max output tokens">
          <input
            type="number"
            value={String(value.max_output_tokens ?? "")}
            onChange={(e) =>
              set({
                max_output_tokens: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
          />
        </Field>
        <label className="check-row">
          <input
            type="checkbox"
            checked={!!value.vision}
            onChange={(e) => set({ vision: e.target.checked })}
          />
          Vision capable
        </label>
        <p>
          {credential.present
            ? "Credential stored"
            : credential.env
              ? `Environment reference: ${credential.env}`
              : "No explicit credential"}
        </p>
        <Field label="Credential action">
          <select
            value={
              edit.mode === "set"
                ? edit.env !== undefined
                  ? "env"
                  : "value"
                : String(edit.mode ?? "keep")
            }
            onChange={(e) =>
              draft.setSource(
                pretty({
                  ...wrapper,
                  credential:
                    e.target.value === "env"
                      ? { mode: "set", env: "" }
                      : e.target.value === "value"
                        ? { mode: "set", value: "" }
                        : { mode: e.target.value },
                }),
              )
            }
          >
            <option value="keep">Keep existing</option>
            <option value="env">Set environment reference</option>
            <option value="value">Set literal key</option>
            <option value="clear">Clear</option>
          </select>
        </Field>
        {edit.mode === "set" && (
          <Field
            label={
              edit.env !== undefined
                ? "Credential environment name"
                : "New API key"
            }
          >
            <input
              type={edit.env !== undefined ? "text" : "password"}
              autoComplete="off"
              value={String(edit.env ?? edit.value ?? "")}
              onChange={(e) =>
                draft.setSource(
                  pretty({
                    ...wrapper,
                    credential: {
                      mode: "set",
                      [edit.env !== undefined ? "env" : "value"]:
                        e.target.value,
                    },
                  }),
                )
              }
            />
          </Field>
        )}
      </fieldset>
      <details className="editor-section">
        <summary>Model JSON · supported connection fields</summary>
        <ErrorMessage>{invalid}</ErrorMessage>
        <SourceEditor
          label="Model JSON"
          readOnly={draft.busy}
          value={String(wrapper.source ?? "")}
          onChange={(source) => draft.setSource(pretty({ ...wrapper, source }))}
        />
      </details>
      <p className="muted">
        Request, cache and compact options belong to each agent.{" "}
        <Link href="/agents">Edit agents</Link>.
      </p>
      <div className="actions">
        {["duplicate", "rename", "delete"].map((item) => (
          <button
            disabled={draft.dirty}
            key={item}
            onClick={() => {
              setAction(item);
              setNewName(`${name}_copy`);
            }}
          >
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      <Field label="Test chat agent">
        <select
          value={testAgent}
          onChange={(e) => setTestAgent(e.target.value)}
        >
          <option value="">Select an agent using this model</option>
          {agentNames.map((agent) => (
            <option key={agent}>{agent}</option>
          ))}
        </select>
      </Field>
      <button
        disabled={!testAgent || draft.dirty}
        onClick={() => {
          void createChat(testAgent);
        }}
      >
        Start test chat
      </button>
      <Modal
        open={!!action}
        onOpenChange={(open) => {
          if (!open) setAction("");
        }}
        title={`${action} model`}
      >
        <ErrorMessage>{error}</ErrorMessage>
        {action !== "delete" && (
          <Field label="New model alias">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
        )}
        <p>
          {action === "delete"
            ? "Models selected by agents cannot be removed. Change those agents first."
            : "Renaming updates agent model references in this config."}
        </p>
        <button
          onClick={() => {
            void api<ConfigView>("/config")
              .then((current) =>
                api("/models", "POST", {
                  revision: current.revision,
                  action,
                  name,
                  newName,
                }),
              )
              .then(
                async () => {
                  setAction("");
                  await changed();
                  navigate(
                    action === "delete"
                      ? "/settings/models"
                      : `/settings/models/${encodeURIComponent(newName)}`,
                  );
                },
                (cause) => setError(errorText(cause)),
              );
          }}
        >
          Confirm
        </button>
      </Modal>
    </>
  );
}
