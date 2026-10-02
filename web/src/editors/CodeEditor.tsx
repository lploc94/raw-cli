import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { styleNonce } from "../style-nonce.js";
export default function CodeEditor({
  value,
  onChange,
  label,
  language = "json",
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  language?: string;
  readOnly?: boolean;
}) {
  const readonly = useRef(new Compartment());
  const parent = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | undefined>(undefined),
    change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    const view = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language === "json"
            ? json()
            : language === "markdown"
              ? markdown()
              : javascript(),
          EditorView.cspNonce.of(styleNonce()),
          EditorView.contentAttributes.of({
            "aria-label": label,
            role: "textbox",
            "aria-multiline": "true",
            "aria-readonly": String(readOnly),
            // Keeps long and read-only sources reachable from the keyboard so their scroll region is usable.
            tabindex: "0",
          }),
          readonly.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.lineWrapping,
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: [tags.keyword, tags.typeName], color: "var(--accent)" },
              { tag: tags.string, color: "var(--success)" },
              { tag: tags.comment, color: "var(--muted)" },
              { tag: [tags.number, tags.bool], color: "var(--warning)" },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              background: "var(--panel)",
              color: "var(--text)",
              fontSize: "var(--code-size)",
            },
            ".cm-content": {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              minHeight: "180px",
            },
            ".cm-gutters": {
              background: "var(--canvas)",
              color: "var(--muted)",
              borderColor: "var(--border)",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              background: "var(--panel-hover)",
            },
            ".cm-cursor": { borderLeftColor: "var(--text)" },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = undefined;
      view.destroy();
    };
  }, [label, language]);
  useEffect(() => {
    const view = editor.current;
    if (view) {
      view.dispatch({
        effects: readonly.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
      view.contentDOM.setAttribute("aria-readonly", String(readOnly));
    }
  }, [readOnly]);
  useEffect(() => {
    const view = editor.current;
    if (view && value !== view.state.doc.toString())
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  return <div className="code-editor" ref={parent} />;
}
