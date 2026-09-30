import { useEffect, useState } from "react";
import { CopyButton } from "../ui.js";
import { mermaidSourceError } from "./policy.js";

export function MermaidDiagram({ source, title = "Mermaid diagram", fallback }: { source: string; title?: string | undefined; fallback?: string | undefined }) {
  const [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<{ source: string; title: string; svg?: string; error?: string }>();
  const sourceError = mermaidSourceError(source);
  const current = result?.source === source && result.title === title ? result : undefined;
  useEffect(() => {
    if (sourceError) return;
    let cancelled = false;
    void import("./render.js").then(({ renderDiagram }) => {
      if (cancelled) return undefined;
      return renderDiagram(source, title);
    }).then((svg) => {
      if (!cancelled && svg) setResult({ source, title, svg });
    }).catch((error: unknown) => {
      if (!cancelled) setResult({ source, title, error: error instanceof Error
        ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) : "Rendering failed." });
    });
    return () => { cancelled = true; };
  }, [source, title, sourceError]);
  const issue = sourceError ?? current?.error;
  return <figure className="mermaid-diagram" aria-label={title}>
    <figcaption>{title}</figcaption>
    <div className="mermaid-controls">
      <button type="button" onClick={() => setShowSource((value) => !value)} disabled={!current?.svg}
        aria-pressed={showSource}>{showSource ? "Show diagram" : "Show source"}</button>
      <CopyButton value={source} label="Copy Mermaid source" />
    </div>
    {fallback && <p className="muted small">{fallback}</p>}
    {issue && <p role="status" className="mermaid-error">Diagram unavailable: {issue}</p>}
    {!issue && !current?.svg && <p role="status" className="muted small">Rendering diagram…</p>}
    {current?.svg && !showSource && !issue
      ? <div className="mermaid-viewport" tabIndex={0} role="region" aria-label={`${title} diagram`} dangerouslySetInnerHTML={{ __html: current.svg }} />
      : <pre className="mermaid-source" tabIndex={0}><code>{source}</code></pre>}
  </figure>;
}
