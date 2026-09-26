import { common, createLowlight } from "lowlight";
import { paint } from "./theme.js";
import type { PaletteRole, TerminalCapabilities, UiOptions } from "./options.js";

const grammar = createLowlight(common);
const aliases: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", sh: "bash", shell: "bash", zsh: "bash", jsonc: "json",
  yml: "yaml", html: "xml", htm: "xml", svg: "xml", md: "markdown",
  rs: "rust", cc: "cpp", cxx: "cpp", hpp: "cpp", h: "c", patch: "diff",
};
const roleForScope: Record<string, PaletteRole> = {
  keyword: "syntax_keyword", literal: "syntax_keyword", selector_tag: "syntax_keyword", tag: "syntax_keyword",
  string: "syntax_string", regexp: "syntax_string", template_tag: "syntax_string", attr: "syntax_type",
  number: "syntax_number", comment: "syntax_comment", meta: "syntax_comment", built_in: "syntax_type",
  title: "syntax_type", type: "syntax_type", class: "syntax_type", punctuation: "syntax_punctuation",
  addition: "success", deletion: "error",
};

export function languageForPath(path: string): string | undefined {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  return extension ? normalizeLanguage(extension) : undefined;
}

export function normalizeLanguage(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const candidate = label.toLowerCase().replace(/^[^a-z0-9+#.-]+|[^a-z0-9+#.-]+$/g, "");
  const name = aliases[candidate] ?? (candidate === "c++" ? "cpp" : candidate);
  return grammar.registered(name) ? name : undefined;
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

function renderNode(node: HastNode, inherited: PaletteRole | undefined, ui: UiOptions, caps: TerminalCapabilities): string {
  if (node.type === "text") return inherited ? paint(inherited, node.value ?? "", ui, caps) : node.value ?? "";
  const className = node.properties?.className?.find((name) => name.startsWith("hljs-"));
  const role = className ? roleForScope[className.slice(5)] ?? inherited : inherited;
  return (node.children ?? []).map((child) => renderNode(child, role, ui, caps)).join("");
}

export function highlightCode(source: string, label: string | undefined, ui: UiOptions, caps: TerminalCapabilities): string {
  const language = normalizeLanguage(label);
  if (!caps.ansi || !language) return source;
  if (language === "diff") {
    return source.split("\n").map((line) => line.startsWith("+") && !line.startsWith("+++")
      ? paint("success", line, ui, caps) : line.startsWith("-") && !line.startsWith("---")
        ? paint("error", line, ui, caps) : line.startsWith("@@") ? paint("syntax_comment", line, ui, caps) : line).join("\n");
  }
  try { return renderNode(grammar.highlight(language, source) as HastNode, undefined, ui, caps); }
  catch { return source; }
}
