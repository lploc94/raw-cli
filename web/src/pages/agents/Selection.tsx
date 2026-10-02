import { useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { object } from "../../editors/shared.js";
import { Field } from "../../ui.js";

const sections: Record<string, { title: string; description: string; empty: string }> = {
  tools: { title: "Tools", description: "Functions the model may call, in this order.", empty: "No tools selected" },
  skills: { title: "Skills", description: "Instructions the model can load when it needs them.", empty: "No skills selected" },
  hooks: { title: "Hooks", description: "Checks that run around tool calls.", empty: "No hooks selected" },
  vars: { title: "Variables", description: "Values this agent may read.", empty: "No vars selected" },
};

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
  const section = sections[label] ?? { title: label, description: "", empty: `No ${label} selected` };
  const move = (index: number, by: -1 | 1) => {
    const next = [...values];
    [next[index + by], next[index]] = [next[index], next[index + by]];
    setValues(next);
  };
  return (
    <section className="card selection-card">
      <div className="card-header">
        <div>
          <h2>
            {section.title} <span className="badge">{values.length}</span>
          </h2>
          <p>{section.description}</p>
        </div>
      </div>
      {values.length ? (
        <ol className="selection-list" aria-label={`Selected ${label}`}>
          {values.map((item, index) => (
            <li key={index}>
              <span className="selection-index" aria-hidden="true">
                {index + 1}
              </span>
              <code>
                {ref(item)}
                {object(item).as ? ` as ${object(item).as}` : ""}
              </code>
              <div className="selection-controls">
                <button
                  className="icon-button"
                  aria-label={`Move ${ref(item)} up`}
                  title="Move up"
                  disabled={!index}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={15} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move ${ref(item)} down`}
                  title="Move down"
                  disabled={index === values.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={15} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove ${ref(item)}`}
                  title="Remove"
                  onClick={() => setValues(values.filter((_, i) => i !== index))}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="selection-empty">{section.empty}</p>
      )}
      <div className="actions selection-add">
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
        <p className="card-footer">
          Discover MCP tools in Library → MCP. Edit package aliases with{" "}
          {"{ref, as, inputs}"} in Agent JSON; local names belong to tool.json.
        </p>
      )}
    </section>
  );
}
