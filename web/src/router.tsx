import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Modal, ErrorMessage } from "./ui.js";
interface Guard {
  dirty: boolean;
  save: () => Promise<boolean>;
}
const RouterContext = createContext({
  path: "/",
  navigate: (_path: string) => {},
  setGuard: (_guard: Guard | undefined) => {},
});
export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname);
  const current = useRef(path),
    guard = useRef<Guard | undefined>(undefined);
  const index = useRef<number>(Number(history.state?.rawIndex ?? 0));
  const restoring = useRef(false);
  const [restoringHistory, setRestoringHistory] = useState(false);
  const [pending, setPending] = useState<{ path: string; index?: number }>(),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const apply = useCallback((target: string, targetIndex?: number) => {
    if (targetIndex !== undefined) {
      history.go(targetIndex - index.current);
      setPending(undefined);
      setError("");
      return;
    }
    index.current++;
    history.pushState({ rawIndex: index.current }, "", target);
    current.current = target;
    setPath(target);
    setPending(undefined);
    setError("");
  }, []);
  const navigate = useCallback(
    (target: string) => {
      if (target === current.current) return;
      if (guard.current?.dirty) {
        setPending({ path: target });
        return;
      }
      apply(target);
    },
    [apply],
  );
  const setGuard = useCallback((value: Guard | undefined) => {
    guard.current = value;
  }, []);
  useEffect(() => {
    history.replaceState(
      { ...history.state, rawIndex: index.current },
      "",
      location.href,
    );
    const onPop = (event: PopStateEvent) => {
      if (restoring.current) {
        restoring.current = false;
        setRestoringHistory(false);
        return;
      }
      const target = location.pathname;
      const targetIndex =
        typeof event.state?.rawIndex === "number"
          ? (event.state.rawIndex as number)
          : index.current - 1;
      if (guard.current?.dirty && target !== current.current) {
        restoring.current = true;
        setRestoringHistory(true);
        history.go(index.current - targetIndex);
        setPending({ path: target, index: targetIndex });
      } else {
        index.current = targetIndex;
        current.current = target;
        setPath(target);
      }
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (guard.current?.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
  return (
    <RouterContext.Provider value={{ path, navigate, setGuard }}>
      {children}
      <Modal
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !saving && !restoringHistory) setPending(undefined);
        }}
        title="Unsaved changes"
        description="Save your changes or discard this draft before leaving."
      >
        <ErrorMessage>{error}</ErrorMessage>
        <div className="actions">
          <button
            disabled={saving || restoringHistory}
            onClick={() => setPending(undefined)}
          >
            Keep editing
          </button>
          <button
            disabled={saving || restoringHistory}
            onClick={() => {
              guard.current = undefined;
              if (pending) apply(pending.path, pending.index);
            }}
          >
            Discard and leave
          </button>
          <button
            className="primary"
            disabled={saving || restoringHistory}
            onClick={() => {
              setSaving(true);
              void (guard.current?.save() ?? Promise.resolve(true))
                .then((ok) => {
                  if (ok && pending) {
                    guard.current = undefined;
                    apply(pending.path, pending.index);
                  } else
                    setError("Save failed. Keep editing to resolve the error.");
                })
                .finally(() => setSaving(false));
            }}
          >
            Save and leave
          </button>
        </div>
      </Modal>
    </RouterContext.Provider>
  );
}
export const useRouter = () => useContext(RouterContext);
export function Link({
  href,
  onClick,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  const { navigate } = useRouter();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          event.button === 0 &&
          href.startsWith("/")
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    />
  );
}
