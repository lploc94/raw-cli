import { Fragment, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";

export interface ActionMenuItem<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  hidden?: boolean;
}

/** A ⋯ menu; same pattern as the chat header. A separator precedes the first danger item. */
export function ActionMenu<T extends string>({
  label,
  items,
  disabledReason,
  onSelect,
}: {
  /** Accessible name of the trigger, such as "Actions for raw". */
  label: string;
  items: ActionMenuItem<T>[];
  /** When set, every item is disabled and the trigger explains why. */
  disabledReason?: string;
  onSelect: (id: T) => void;
}) {
  const visible = items.filter((item) => !item.hidden);
  const firstDanger = visible.findIndex((item) => item.danger);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="icon-button"
          aria-label={label}
          title={disabledReason ?? "More actions"}
          disabled={!!disabledReason}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={6} collisionPadding={8}>
          {visible.map((item, index) => (
            <Fragment key={item.id}>
              {index === firstDanger && index > 0 && (
                <DropdownMenu.Separator className="workspace-menu-separator" />
              )}
              <DropdownMenu.Item
                className={`workspace-menu-item ${item.danger ? "danger-item" : ""}`}
                disabled={!!disabledReason}
                onSelect={() => onSelect(item.id)}
              >
                {item.icon}
                {item.label}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
