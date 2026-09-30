import { sanitizeDiagram } from "./sanitize.js";
import mermaid from "mermaid";
import { MERMAID_MAX_EDGES, MERMAID_SOURCE_BYTES, mermaidSourceError } from "./policy.js";

mermaid.initialize({
  startOnLoad: false, securityLevel: "strict", htmlLabels: false,
  suppressErrorRendering: true, maxTextSize: MERMAID_SOURCE_BYTES, maxEdges: MERMAID_MAX_EDGES,
  // Dagre avoids loading a second layout engine for small diagrams.
  layout: "dagre", fontFamily: "sans-serif", theme: "neutral", look: "classic",
  flowchart: { htmlLabels: false, useMaxWidth: false },
  sequence: { useMaxWidth: false },
  secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering",
    "htmlLabels", "flowchart", "sequence", "layout", "fontFamily", "theme", "themeCSS", "themeVariables", "look"],
});

// Mermaid owns global parser/config state. Serialize layout, and keep the queue alive after errors.
let pending: Promise<unknown> = Promise.resolve();
let serial = 0;
export function renderDiagram(source: string, title: string): Promise<string> {
  const issue = mermaidSourceError(source);
  if (issue) return Promise.reject(new Error(issue));
  const next = pending.then(async () => {
    const stage = document.createElement("div");
    stage.className = "mermaid-staging";
    stage.setAttribute("aria-hidden", "true");
    stage.inert = true;
    document.body.append(stage);
    try {
      const id = `raw-mermaid-${Date.now()}-${++serial}`;
      const rendered = await mermaid.render(id, source, stage);
      // Never invoke bindFunctions: diagram source cannot register handlers or navigation.
      return sanitizeDiagram(rendered.svg, title);
    } finally { stage.remove(); }
  });
  pending = next.catch(() => undefined);
  return next;
}
