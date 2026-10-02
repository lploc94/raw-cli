import { useState } from "react";
import { api, errorText } from "../../api.js";
import { object } from "../../editors/shared.js";
import { Field } from "../../ui.js";

export function PolicyEditor({
  rules,
  onChange,
}: {
  rules: unknown[];
  onChange: (rules: unknown[]) => void;
}) {
  const [identity, setIdentity] = useState("builtin/bash"),
    [sample, setSample] = useState(
      '{"commands":[{"command":"rm example.txt"}]}',
    ),
    [result, setResult] = useState("");
  return (
    <details className="editor-section">
      <summary>Tool policy · ordered rules and sample test</summary>
      <p className="muted">
        The last matching rule wins; no match allows. Only ask rules support
        when.any + RE2. This test never dispatches a tool.
      </p>
      {rules.map((entry, index) => {
        const rule = object(entry);
        const update = (fields: Record<string, unknown>) =>
          onChange(
            rules.map((r, i) => (i === index ? { ...rule, ...fields } : r)),
          );
        return (
          <fieldset key={index} className="policy-row">
            <legend>Rule {index + 1}</legend>
            <Field label={`Rule ${index + 1} match`}>
              <input
                value={String(rule.match ?? "")}
                onChange={(e) => update({ match: e.target.value })}
              />
            </Field>
            <Field label={`Rule ${index + 1} effect`}>
              <select
                value={String(rule.effect ?? "allow")}
                onChange={(e) => {
                  const next: Record<string, unknown> = {
                    ...rule,
                    effect: e.target.value,
                  };
                  if (e.target.value !== "ask") delete next.when;
                  onChange(rules.map((r, i) => (i === index ? next : r)));
                }}
              >
                {["allow", "ask", "deny"].map((effect) => (
                  <option key={effect}>{effect}</option>
                ))}
              </select>
            </Field>
            {rule.effect === "ask" && (
              <>
                <Field label={`Rule ${index + 1} when.any`}>
                  <input
                    value={String(object(rule.when).any ?? "")}
                    onChange={(e) =>
                      update({
                        when: { ...object(rule.when), any: e.target.value },
                      })
                    }
                  />
                </Field>
                <Field label={`Rule ${index + 1} regex`}>
                  <input
                    value={String(object(rule.when).regex ?? "")}
                    onChange={(e) =>
                      update({
                        when: { ...object(rule.when), regex: e.target.value },
                      })
                    }
                  />
                </Field>
                {rule.when && (
                  <button
                    onClick={() => {
                      const next = { ...rule };
                      delete next.when;
                      onChange(rules.map((r, i) => (i === index ? next : r)));
                    }}
                  >
                    Remove condition
                  </button>
                )}
              </>
            )}
            <div className="actions">
              <button
                disabled={!index}
                onClick={() => {
                  const next = [...rules];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  onChange(next);
                }}
              >
                Move up
              </button>
              <button
                onClick={() => onChange(rules.filter((_, i) => i !== index))}
              >
                Remove rule
              </button>
            </div>
          </fieldset>
        );
      })}
      <button
        onClick={() =>
          onChange([
            ...rules,
            {
              match: "builtin/bash",
              effect: "ask",
              when: { any: "commands[*].command", regex: "(^|[;& ]+)rm[ ]" },
            },
          ])
        }
      >
        Add rule
      </button>
      <Field label="Sample canonical tool identity">
        <input value={identity} onChange={(e) => setIdentity(e.target.value)} />
      </Field>
      <Field label="Sample arguments JSON">
        <textarea value={sample} onChange={(e) => setSample(e.target.value)} />
      </Field>
      <button
        onClick={() => {
          try {
            void api<{ effect: string }>("/policy/test", "POST", {
              identity,
              rules,
              args: JSON.parse(sample),
            }).then(
              (value) => setResult(`Sample result: ${value.effect}`),
              (cause) => setResult(errorText(cause)),
            );
          } catch (cause) {
            setResult(errorText(cause));
          }
        }}
      >
        Test rules
      </button>
      <p role="status">{result}</p>
    </details>
  );
}
