import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { isValidElement, type ReactNode } from "react";
import { CopyButton } from "./ui.js";

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
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
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
          pre: ({ children }) => {
            if (
              isValidElement<{ children?: ReactNode; className?: string }>(
                children,
              )
            )
              return (
                <CodeBlock
                  code={String(children.props.children ?? "").replace(
                    /\n$/,
                    "",
                  )}
                  language={
                    /language-([\w+-]+)/.exec(
                      children.props.className ?? "",
                    )?.[1] ?? "text"
                  }
                />
              );
            return <pre tabIndex={0}>{children}</pre>;
          },
          table: ({ children }) => (
            <div className="table-scroll" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
