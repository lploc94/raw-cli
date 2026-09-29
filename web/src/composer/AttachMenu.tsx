import { DropdownMenu } from "radix-ui";
import { AtSign, ImagePlus, Plus, Slash } from "lucide-react";

export function AttachMenu({
  onUpload,
  onReference,
  onCommands,
  onClosed,
}: {
  onUpload: () => void;
  onReference: () => void;
  onCommands: () => void;
  /** Radix returns focus to the trigger on close; the composer wants it back in the textarea. */
  onClosed: (event: Event) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="icon-button"
          aria-label="Add attachment"
          title="Add attachment"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu"
          side="top"
          align="start"
          sideOffset={8}
          onCloseAutoFocus={onClosed}
        >
          <DropdownMenu.Item className="menu-item" onSelect={onUpload}>
            <ImagePlus size={15} aria-hidden="true" /> Upload image…
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={onReference}>
            <AtSign size={15} aria-hidden="true" /> Reference workspace file…
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={onCommands}>
            <Slash size={15} aria-hidden="true" /> Commands
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
