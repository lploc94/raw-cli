import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, ApiError, errorText } from "../api.js";
import { useRouter } from "../router.js";
import { ErrorMessage, Modal } from "../ui.js";
const CodeEditor = lazy(() => import("./CodeEditor.js"));
export function SourceEditor(props: Parameters<typeof CodeEditor>[0]) {
  return (
    <Suspense fallback={<p role="status">Loading editor…</p>}>
      <CodeEditor {...props} />
    </Suspense>
  );
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
export function parseObject(source: string): Record<string, any> {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, any>;
}
export function patch(original: string, source: string) {
  const before = parseObject(original),
    after = parseObject(source);
  return {
    ...Object.fromEntries(
      Object.keys(before)
        .filter((key) => !Object.hasOwn(after, key))
        .map((key) => [key, null]),
    ),
    ...after,
  };
}
export interface DraftDocument {
  source: string;
  revision: string;
}
export function useDraft(
  id: string,
  load: () => Promise<DraftDocument>,
  persist: (
    draft: DraftDocument,
    original: string,
  ) => Promise<{ revision: string; source?: string }>,
  onSaved?: () => void | Promise<void>,
) {
  const [source, setSource] = useState(""),
    [base, setBase] = useState<DraftDocument>(),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState<DraftDocument>();
  const funcs = useRef({ load, persist, onSaved });
  funcs.current = { load, persist, onSaved };
  const { setGuard } = useRouter();
  const dirty = base !== undefined && source !== base.source;
  useEffect(() => {
    let alive = true;
    setBase(undefined);
    setError("");
    setStatus("");
    setConflict(false);
    void funcs.current.load().then(
      (value) => {
        if (alive) {
          setBase(value);
          setSource(value.source);
        }
      },
      (cause) => {
        if (alive) setError(errorText(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [id]);
  const save = useCallback(async () => {
    if (!base || busy) return false;
    if (!dirty) return true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await funcs.current.persist(
        { source, revision: base.revision },
        base.source,
      );
      const savedSource = result.source ?? source;
      setBase({ source: savedSource, revision: result.revision });
      setSource((current) => (current === source ? savedSource : current));
      setConflict(false);
      setLatest(undefined);
      setStatus("Saved · applies to the next turn");
      await funcs.current.onSaved?.();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      setConflict(
        cause instanceof ApiError &&
          cause.code === "conflict" &&
          !!object(cause.details).revision,
      );
      return false;
    } finally {
      setBusy(false);
    }
  }, [base, source, busy, dirty]);
  useEffect(() => {
    setGuard({ dirty, save });
    return () => setGuard(undefined);
  }, [dirty, save, setGuard]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [save]);
  const reload = async () => {
    try {
      const value = await funcs.current.load();
      setBase(value);
      setSource(value.source);
      setConflict(false);
      setLatest(undefined);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return {
    source,
    setSource: (value: string) => {
      setSource(value);
      setStatus("");
    },
    base,
    busy,
    error,
    status,
    dirty,
    conflict,
    latest,
    save,
    reload,
    discard: () => {
      if (base) setSource(base.source);
      setError("");
      setStatus("");
      setConflict(false);
    },
    review: async () => {
      try {
        setLatest(await funcs.current.load());
      } catch (cause) {
        setError(errorText(cause));
      }
    },
    reapply: () => {
      if (latest) {
        setBase(latest);
        setLatest(undefined);
        setConflict(false);
        setError("");
        setStatus(
          "Draft retained against the latest revision. Review it, then Save.",
        );
      }
    },
    closeReview: () => setLatest(undefined),
  };
}
export function DraftActions({
  draft,
}: {
  draft: ReturnType<typeof useDraft>;
}) {
  return (
    <>
      <div className="editor-actions">
        <span className="muted">
          {draft.dirty ? "Unsaved changes" : "Up to date"}
        </span>
        <button disabled={!draft.dirty || draft.busy} onClick={draft.discard}>
          Discard
        </button>
        <button
          className="primary"
          disabled={!draft.dirty || draft.busy}
          onClick={() => {
            void draft.save();
          }}
        >
          {draft.busy ? "Saving…" : "Save"}
        </button>
      </div>
      <ErrorMessage>{draft.error}</ErrorMessage>
      <p role="status" className="muted">
        {draft.status}
      </p>
      {draft.conflict && (
        <div className="actions">
          <button
            onClick={() => {
              void draft.review();
            }}
          >
            Review latest revision
          </button>
          <button
            onClick={() => {
              void draft.reload();
            }}
          >
            Reload and discard draft
          </button>
        </div>
      )}
      <Modal
        open={!!draft.latest}
        onOpenChange={(open) => {
          if (!open) draft.closeReview();
        }}
        title="Review external changes"
        description="The draft is still in memory. Reapply keeps your text and uses the revision shown below; review before saving over it."
      >
        <pre aria-label="Latest on disk" className="source-preview">
          {draft.latest?.source}
        </pre>
        <button className="primary" onClick={draft.reapply}>
          Reapply draft
        </button>
      </Modal>
    </>
  );
}
export async function configDocument() {
  return api<DraftDocument>("/config/document");
}
