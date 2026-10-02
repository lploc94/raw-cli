import { useEffect, useState } from "react";
import { MessageSquarePlus, Plus } from "lucide-react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import { api, errorText } from "../../api.js";
import { Link, useRouter } from "../../router.js";
import { Empty, ErrorMessage, Field, Modal } from "../../ui.js";
import { AgentActionDialog, AgentActionsMenu, type AgentAction } from "./AgentActions.js";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function AgentsList({
  config,
  changed,
  createChat,
}: {
  config: ConfigView;
  changed: () => Promise<void>;
  createChat: (name?: string) => Promise<void>;
}) {
  const { navigate } = useRouter();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ action: AgentAction; name: string }>();
  const create = (
    <button className="primary" onClick={() => setCreating(true)}>
      <Plus size={16} aria-hidden="true" />
      Create agent
    </button>
  );
  return (
    <div className="management-page">
      {config.agents.length ? (
        <>
          <header className="resource-header">
            <div>
              <h1>Agents</h1>
              <p className="muted">Compose tools, skills and rules around a model. Changes apply to the next turn.</p>
            </div>
            {create}
          </header>
          <ul className="data-table" aria-label="Agent list">
            {config.agents.map((name) => {
              const summary = config.agentSummaries?.[name];
              const isDefault = config.defaultAgent === name;
              return (
                <li key={name} className="data-row agent-row">
                  <div className="agent-row-name">
                    <Link href={`/agents/${encodeURIComponent(name)}`}>{name}</Link>
                    {isDefault && <span className="badge accent">Default</span>}
                    {summary?.from && <span className="badge">Package</span>}
                  </div>
                  <code className="agent-row-model">{summary?.model ?? "—"}</code>
                  <span className="muted agent-row-counts">
                    {summary?.from ? (
                      <code title={summary.from}>{summary.from}</code>
                    ) : summary ? (
                      `${plural(summary.tools, "tool")} · ${plural(summary.skills, "skill")}`
                    ) : null}
                  </span>
                  <div className="actions">
                    <button onClick={() => void createChat(name)}>
                      <MessageSquarePlus size={15} aria-hidden="true" />
                      New chat
                    </button>
                    <AgentActionsMenu name={name} isDefault={isDefault} onSelect={(action) => setPending({ action, name })} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : config.models.length ? (
        <Empty title="No agents yet" action={create}>
          An agent pairs a model with the tools, skills and rules it may use.
        </Empty>
      ) : (
        <Empty title="No agents yet" action={<Link href="/settings/models">Configure a model in Settings</Link>}>
          Agents need a model. Add one, then create an agent.
        </Empty>
      )}
      <CreateAgentDialog
        open={creating}
        onOpenChange={setCreating}
        config={config}
        changed={changed}
        onCreated={(name) => navigate(`/agents/${encodeURIComponent(name)}`)}
      />
      <AgentActionDialog
        action={pending?.action}
        name={pending?.name ?? ""}
        agents={config.agents}
        onClose={() => setPending(undefined)}
        changed={changed}
        onDone={(action, newName) => {
          setPending(undefined);
          if (action === "rename" || action === "duplicate") navigate(`/agents/${encodeURIComponent(newName)}`);
        }}
      />
    </div>
  );
}

function CreateAgentDialog({
  open,
  onOpenChange,
  config,
  changed,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: ConfigView;
  changed: () => Promise<void>;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(config.models[0] ?? "");
  const [error, setError] = useState("");
  const taken = config.agents.includes(name);
  useEffect(() => {
    if (!open) return;
    setName("");
    setError("");
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create agent"
      description="A new agent uses a model from this config. It stays independent of the default agent."
    >
      <ErrorMessage>{error}</ErrorMessage>
      <Field label="Agent name" {...(taken ? { hint: "An agent with this name already exists." } : {})}>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Model">
        <select value={model || config.models[0] || ""} onChange={(e) => setModel(e.target.value)}>
          {config.models.map((alias) => (
            <option key={alias}>{alias}</option>
          ))}
        </select>
      </Field>
      <div className="actions">
        <button
          className="primary"
          disabled={!name.trim() || taken || !(model || config.models[0])}
          onClick={() => {
            void api<ConfigView>("/agents", "POST", {
              revision: config.revision,
              action: "create",
              name,
              value: { model: model || config.models[0], tools: { use: [] } },
            }).then(
              async () => {
                await changed();
                onOpenChange(false);
                setError("");
                onCreated(name);
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Create
        </button>
      </div>
    </Modal>
  );
}
