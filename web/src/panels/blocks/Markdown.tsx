import { Markdown as Rendered } from "../../markdown.js";

export function PanelMarkdown({ text }: { text: string }) {
  return <div className="panel-markdown"><Rendered>{text}</Rendered></div>;
}
