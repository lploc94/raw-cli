import { useState, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Copy, MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import { api, errorText } from "../../api.js";
import { ErrorMessage, Field, Modal } from "../../ui.js";

export type AgentAction = "default" | "duplicate" | "rename" | "delete";

const copy: Record<AgentAction, { title: string; confirm: string }> = {
  default: { title: "Set default agent", confirm: "Set as default" },
  duplicate: { title: "Duplicate agent", confirm: "Duplicate" },
  rename: { title: "Rename agent", confirm: "Rename" },
  delete: { title: "Delete agent", confirm: "Delete agent" },
};

/** The ⋯ menu for one agent; same menu pattern as the chat header. */
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
  const item = (action: AgentAction, icon: ReactNode, label: string, danger = false) => (
    <DropdownMenu.Item
      className={`workspace-menu-item ${danger ? "danger-item" : ""}`}
      disabled={!!disabledReason}
      onSelect={() => onSelect(action)}
    >
      {icon}
      {label}
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="icon-button"
          aria-label={`Actions for ${name}`}
          title={disabledReason ?? "More actions"}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={6} collisionPadding={8}>
          {!isDefault && item("default", <Star size={15} aria-hidden="true" />, "Set as default")}
          {item("duplicate", <Copy size={15} aria-hidden="true" />, "Duplicate")}
          {item("rename", <Pencil size={15} aria-hidden="true" />, "Rename")}
          <DropdownMenu.Separator className="workspace-menu-separator" />
          {item("delete", <Trash2 size={15} aria-hidden="true" />, "Delete", true)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
