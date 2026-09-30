import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { createContext, isValidElement, useContext, type ReactNode } from "react";
import { CopyButton } from "./ui.js";
import { MermaidDiagram } from "./diagrams/MermaidDiagram.js";
import { isClosedMermaidFence } from "./diagrams/policy.js";

const highlighter = createLowlight(common);
interface Node {
  type: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}
function render(node: Node, index: number): ReactNode {
  if (node.type === "text") return node.value;
  const classes = node.properties?.className;
  return (
    <span
      key={index}
      className={Array.isArray(classes) ? classes.join(" ") : undefined}
    >
      {node.children?.map(render)}
    </span>
  );
}
export function CodeBlock({
  code,
  language = "text",
}: {
  code: string;
  language?: string;
}) {
  let highlighted: ReactNode = code;
  if (highlighter.registered(language))
    try {
      highlighted = highlighter
        .highlight(language, code)
        .children.map((node, index) => render(node as Node, index));
    } catch {}
  return (
    <div className="code-block">
      <div className="code-label">
        <span>{language}</span>
        <CopyButton value={code} label="Copy code" />
      </div>
      <pre tabIndex={0}>
        <code>{highlighted}</code>
      </pre>
    </div>
  );
}
const MarkdownSource = createContext("");
// Keep component identities stable across stream/metrics updates: inline component
// functions would remount diagrams and lose source-toggle state on every render.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ alt }) => (
    <span className="muted">
      [Image: {alt || "remote image not loaded"}]
    </span>
  ),
  pre: function MarkdownPre({ children: content, node }) {
    const markdown = useContext(MarkdownSource);
    if (
      isValidElement<{ children?: ReactNode; className?: string }>(
        content,
      )
    ) {
      const code = String(content.props.children ?? "").replace(/\n$/, "");
      const language = /language-([\w+-]+)/.exec(content.props.className ?? "")?.[1] ?? "text";
      if (language.toLowerCase() === "mermaid" && isClosedMermaidFence(markdown, node?.position?.start.offset, node?.position?.end.offset)) {
        return <MermaidDiagram source={code} />;
      }
      return (
        <CodeBlock
          code={code}
          language={language}
        />
      );
    }
    return <pre tabIndex={0}>{content}</pre>;
  },
  table: ({ children }) => (
    <div className="table-scroll" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <MarkdownSource.Provider value={children}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
          {children}
        </ReactMarkdown>
      </MarkdownSource.Provider>
    </div>
  );
}
