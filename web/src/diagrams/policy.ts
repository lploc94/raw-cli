export const MERMAID_SOURCE_BYTES = 16 * 1024;
export const MERMAID_MAX_EDGES = 100;

/** Run before loading Mermaid: its layout work touches live DOM before output sanitization. */
export function mermaidSourceError(source: string): string | undefined {
  if (!source.trim()) return "Diagram source is empty.";
  if (new TextEncoder().encode(source).byteLength > MERMAID_SOURCE_BYTES) return "Diagram source exceeds 16 KiB.";
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(source)) return "Diagram source contains unsupported control characters.";
  if (/%%\s*\{|^\s*---(?:\s|$)/m.test(source)) return "Diagram configuration directives and frontmatter are disabled.";
  if (/<\s*[a-z!/]|@\s*\{|\$\$|(?:https?|data|javascript|vbscript|file|blob):|\/\/|url\s*\(/i.test(source)) {
    return "Diagram HTML, resource URLs, images, icons and math markup are disabled.";
  }
  // Mermaid can recognize adjacent statements without a newline. Conservatively reserve
  // these directive words even inside labels rather than let an inline statement bypass us.
  if (/\b(?:click|link|links|style|linkStyle|classDef)\s/i.test(source)) {
    return "Diagram links, actions and custom styles are disabled.";
  }
  if (source.split(/[;\n]/).length > 300 || (source.match(/(?:--+|==+|\.\.+|->|<-)/g)?.length ?? 0) > MERMAID_MAX_EDGES) {
    return "Diagram complexity exceeds 300 statements or 100 edges.";
  }
  return undefined;
}

/** react-markdown accepts incomplete fences; use original source positions before promoting a block. */
export function isClosedMermaidFence(markdown: string, start?: number, end?: number): boolean {
  if (start === undefined || end === undefined) return false;
  const lines = markdown.slice(start, end).split(/\r?\n/);
  if (lines.length < 2) return false;
  const opening = /^\s*(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i.exec(lines[0]!);
  if (!opening) return false;
  const closing = lines.at(-1)!.replace(/^[ \t]*(?:>[ \t]*)*/, "");
  return new RegExp(`^[ \\t]*${opening[1]![0]}{${opening[1]!.length},}[ \\t]*$`).test(closing);
}
