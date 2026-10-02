import { useEffect, useState } from "react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import type { ComponentInfo } from "../../../../src/management/components.js";
import { api, errorText } from "../../api.js";
import { Link } from "../../router.js";
import { ErrorMessage, Field } from "../../ui.js";

/** Which agents select this component, with per-agent Attach/Detach. */
export function UsedByCard({
  info,
  config,
  endpoint,
  disabledReason,
  configError,
  retryConfig,
  reload,
  changed,
}: {
  info: ComponentInfo;
  config: ConfigView | undefined;
  endpoint: string;
  /** The agent list could not be loaded. */
  configError?: string;
  retryConfig?: () => void;
  /** When set, attach and detach are disabled and explain why. */
  disabledReason?: string;
  /** Re-reads the component; rejects when the fresh state cannot be read. */
  reload: () => Promise<ComponentInfo>;
  changed: () => Promise<void>;
}) {
  const agents = config?.agents ?? [];
  // The selection API rejects package bindings; their complete override lives in the agent's JSON.
  const bound = (name: string) => !!config?.agentSummaries?.[name]?.from;
  const attachable = agents.filter((name) => !bound(name));
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [warning, setWarning] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!attachable.includes(agent))
      setAgent(attachable.includes(config?.defaultAgent ?? "") ? config!.defaultAgent! : (attachable[0] ?? ""));
  }, [attachable.join("\0"), config?.defaultAgent]);
  const select = async (name: string, selected: boolean) => {
    setBusy(true);
    setError("");
    setStatus("");
    setWarning(undefined);
    try {
      await api(`${endpoint}/selection`, "POST", { revision: config?.revision, agent: name, selected });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
      return;
    }
    try {
      await changed();
      const next = await reload();
      // Detach removes exact references only; another reference to the same folder keeps it in use.
      if (!selected && next.usedBy.includes(name)) setWarning(name);
      else setStatus(selected ? "Attached · applies to the next turn" : "Detached");
    } catch (cause) {
      setError(`The config was saved, but its usage could not be checked. ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || !!disabledReason || !config;
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>
            Used by{" "}
            {info.usageAvailable && <span className="badge">{info.usedBy.length}</span>}
          </h2>
          <p>Agents that select this component. Changes apply to their next turn.</p>
        </div>
      </div>
      {!info.usageAvailable && (
        <div className="card notice">
          <p>Usage is unavailable because the config or a package binding could not be read.</p>
        </div>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      {warning && (
        <div className="card notice" role="alert">
          <p>
            {warning} still uses this component through another reference. Remove it in the agent's Capabilities
            tab.
          </p>
          <Link href={`/agents/${encodeURIComponent(warning)}`}>Open {warning}</Link>
        </div>
      )}
      {configError ? (
        <ErrorMessage>
          Could not load agents. {configError}{" "}
          <button className="text-button" onClick={retryConfig}>
            Try again
          </button>
        </ErrorMessage>
      ) : !config ? null : agents.length ? (
        <ul className="used-by-list" aria-label="Agents using this component">
          {agents.map((name) => {
            const attached = info.usedBy.includes(name);
            return (
              <li key={name}>
                <span className="used-by-name">{name}</span>
                {bound(name) ? (
                  <>
                    <span className="badge">Package binding</span>
                    <Link href={`/agents/${encodeURIComponent(name)}`}>Edit in agent</Link>
                  </>
                ) : (
                  <>
                    {info.usageAvailable && (
                      <span className={`badge ${attached ? "success" : ""}`}>{attached ? "Attached" : "Not attached"}</span>
                    )}
                    {info.usageAvailable && <button
                      disabled={blocked}
                      title={disabledReason}
                      aria-label={`${attached ? "Detach from" : "Attach to"} ${name}`}
                      onClick={() => void select(name, !attached)}
                    >
                      {attached ? "Detach" : "Attach"}
                    </button>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="selection-empty">No agents yet.</p>
      )}
      <div className="card-footer actions">
        <Field label="Attach to agent">
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {attachable.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </Field>
        <button disabled={!agent || blocked} title={disabledReason} onClick={() => void select(agent, true)}>
          Attach
        </button>
      </div>
      <p role="status" className="muted">
        {status}
      </p>
    </section>
  );
}
