import { useState } from "react";
import { object } from "../../editors/shared.js";
import { Field } from "../../ui.js";

export function Selection({
  label,
  values,
  choices,
  setValues,
}: {
  label: string;
  values: unknown[];
  choices: string[];
  setValues: (values: unknown[]) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const ref = (v: unknown) =>
    typeof v === "string" ? v : String(object(v).ref ?? "");
  return (
    <section className="editor-section">
      <h2>{label[0]!.toUpperCase() + label.slice(1)}</h2>
      <ol className="selection-list" aria-label={`Selected ${label}`}>
        {values.map((item, index) => (
          <li key={index}>
            <code>
              {ref(item)}
              {object(item).as ? ` as ${object(item).as}` : ""}
            </code>
            <div className="actions">
              <button
                aria-label={`Move ${ref(item)} up`}
                disabled={!index}
                onClick={() => {
                  const next = [...values];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  setValues(next);
                }}
              >
                ↑
              </button>
              <button
                aria-label={`Move ${ref(item)} down`}
                disabled={index === values.length - 1}
                onClick={() => {
                  const next = [...values];
                  [next[index + 1], next[index]] = [
                    next[index],
                    next[index + 1],
                  ];
                  setValues(next);
                }}
              >
                ↓
              </button>
              <button
                onClick={() => setValues(values.filter((_, i) => i !== index))}
                aria-label={`Remove ${ref(item)}`}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="actions">
        <Field label={`Add ${label}`}>
          <select
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
          >
            <option value="">Choose a component</option>
            {choices
              .filter((c) => !values.some((v) => ref(v) === c))
              .map((c) => (
                <option key={c}>{c}</option>
              ))}
          </select>
        </Field>
        <button
          disabled={!candidate}
          onClick={() => {
            setValues([...values, candidate]);
            setCandidate("");
          }}
        >
          Add
        </button>
      </div>
      {label === "tools" && (
        <p className="muted">
          Discover MCP tools in Library → MCP. Edit package aliases with{" "}
          {"{ref, as, inputs}"} in Agent JSON; local names belong to tool.json.
        </p>
      )}
    </section>
  );
}
