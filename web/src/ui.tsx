import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Dialog } from "radix-ui";
import { Check, Copy, X } from "lucide-react";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = "",
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const previous = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog ${className}`}
          onOpenAutoFocus={(event) => {
            previous.current = document.activeElement as HTMLElement | null;
            const input = (
              event.target as HTMLElement
            ).querySelector<HTMLInputElement>(
              "input:not([type=hidden]),textarea",
            );
            if (input) {
              event.preventDefault();
              input.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (previous.current?.isConnected) {
              event.preventDefault();
              previous.current.focus();
            }
          }}
        >
          <div className="section-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className={description ? "muted" : "sr-only"}>
            {description ?? title}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        className={`icon-button ${className}`}
        aria-label={label}
        title={label}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setError("");
            },
            () => setError("Copy unavailable; select the text to copy it."),
          );
        }}
      >
        {copied ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
        <span className="sr-only" role="status">
          {copied ? "Copied" : ""}
        </span>
      </button>
      {error && <span className="error-text">{error}</span>}
    </>
  );
}
export function ErrorMessage({ children }: { children: ReactNode }) {
  return children ? (
    <div className="error-banner" role="alert">
      {children}
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="brand-mark" aria-hidden="true">
        r.
      </div>
      <h1>{title}</h1>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(
            children as ReactElement<{
              id?: string;
              "aria-describedby"?: string;
            }>,
            { id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) },
          )
        : children}
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
    </div>
  );
}
