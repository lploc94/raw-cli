import { useState } from "react";
import { Copy, Pencil, Star, Trash2 } from "lucide-react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import { api, errorText } from "../../api.js";
import { ErrorMessage, Field, Modal } from "../../ui.js";
import { ActionMenu } from "../../ui/ActionMenu.js";

export type AgentAction = "default" | "duplicate" | "rename" | "delete";

const copy: Record<AgentAction, { title: string; confirm: string }> = {
  default: { title: "Set default agent", confirm: "Set as default" },
  duplicate: { title: "Duplicate agent", confirm: "Duplicate" },
  rename: { title: "Rename agent", confirm: "Rename" },
  delete: { title: "Delete agent", confirm: "Delete agent" },
};

/** The ⋯ menu for one agent. */
export function AgentActionsMenu({
  name,
  isDefault,
  disabledReason,
  onSelect,
}: {
  name: string;
  isDefault: boolean;
  /** When set, every item is disabled and the trigger explains why. */
  disabledReason?: string;
  onSelect: (action: AgentAction) => void;
}) {
  return (
    <ActionMenu<AgentAction>
      label={`Actions for ${name}`}
      {...(disabledReason ? { disabledReason } : {})}
      onSelect={onSelect}
      items={[
        { id: "default", label: "Set as default", icon: <Star size={15} aria-hidden="true" />, hidden: isDefault },
        { id: "duplicate", label: "Duplicate", icon: <Copy size={15} aria-hidden="true" /> },
        { id: "rename", label: "Rename", icon: <Pencil size={15} aria-hidden="true" /> },
        { id: "delete", label: "Delete", icon: <Trash2 size={15} aria-hidden="true" />, danger: true },
      ]}
    />
  );
}

/** Confirms one lifecycle action. Its errors stay inside the dialog. */
export function AgentActionDialog({
  action,
  name,
  agents,
  onClose,
  changed,
  onDone,
}: {
  action: AgentAction | undefined;
  name: string;
  agents: string[];
  onClose: () => void;
  changed: () => Promise<void>;
  onDone: (action: AgentAction, newName: string) => void;
}) {
  return (
    <Modal
      open={!!action}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={action ? copy[action].title : ""}
    >
      {action && (
        // Keyed so each opening starts from fresh defaults.
        <ActionForm key={`${action}:${name}`} action={action} name={name} agents={agents} changed={changed} onDone={onDone} />
      )}
    </Modal>
  );
}

function ActionForm({
  action,
  name,
  agents,
  changed,
  onDone,
}: {
  action: AgentAction;
  name: string;
  agents: string[];
  changed: () => Promise<void>;
  onDone: (action: AgentAction, newName: string) => void;
}) {
  const named = action === "rename" || action === "duplicate";
  const [newName, setNewName] = useState(action === "duplicate" ? `${name}_copy` : name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const taken = named && newName !== name && agents.includes(newName);
  const invalid = named && (!newName.trim() || newName === name || taken);
  const run = async () => {
    setBusy(true);
    try {
      const current = await api<ConfigView>("/config");
      await api("/agents", "POST", { revision: current.revision, action, name, newName });
      await changed();
      onDone(action, newName);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ErrorMessage>{error}</ErrorMessage>
      {named ? (
        <Field label="New agent name" {...(taken ? { hint: "An agent with this name already exists." } : {})}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} />
        </Field>
      ) : (
        <p>
          {action === "delete"
            ? `Remove ${name} from this config? Its sessions remain available.`
            : `Use ${name} for new sessions without an explicit agent?`}
        </p>
      )}
      <div className="actions">
        <button
          className={action === "delete" ? "danger" : "primary"}
          disabled={invalid || busy}
          onClick={() => void run()}
        >
          {copy[action].confirm}
        </button>
      </div>
    </>
  );
}
