import { useState } from "react";
import { api, errorText } from "../../api.js";
import { object } from "../../editors/shared.js";
import { Field } from "../../ui.js";

const tone: Record<string, string> = { allow: "success", ask: "warning", deny: "error" };

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
    [result, setResult] = useState<{ effect: string } | { error: string }>();
  const move = (index: number, by: -1 | 1) => {
    const next = [...rules];
    [next[index + by], next[index]] = [next[index], next[index + by]];
    onChange(next);
  };
  return (
    <>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>
              Rules <span className="badge">{rules.length}</span>
            </h2>
            <p>
              The last matching rule wins; no match allows. Only ask rules support
              when.any + RE2.
            </p>
          </div>
        </div>
        {!rules.length && <p className="selection-empty">No rules. Every tool call is allowed.</p>}
        {rules.map((entry, index) => {
          const rule = object(entry);
          const update = (fields: Record<string, unknown>) =>
            onChange(
              rules.map((r, i) => (i === index ? { ...rule, ...fields } : r)),
            );
          return (
            <fieldset key={index} className="policy-row">
              <legend>Rule {index + 1}</legend>
              <div className="policy-fields">
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
                            when: { source: "arguments", ...object(rule.when), any: e.target.value },
                          })
                        }
                      />
                    </Field>
                    <Field label={`Rule ${index + 1} regex`}>
                      <input
                        value={String(object(rule.when).regex ?? "")}
                        onChange={(e) =>
                          update({
                            when: { source: "arguments", ...object(rule.when), regex: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </>
                )}
              </div>
              <div className="actions">
                <button disabled={!index} onClick={() => move(index, -1)}>
                  Move up
                </button>
                <button disabled={index === rules.length - 1} onClick={() => move(index, 1)}>
                  Move down
                </button>
                {rule.effect === "ask" && rule.when && (
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
                <button
                  className="policy-remove"
                  onClick={() => onChange(rules.filter((_, i) => i !== index))}
                >
                  Remove rule
                </button>
              </div>
            </fieldset>
          );
        })}
        <div className="actions">
          <button
            onClick={() =>
              onChange([
                ...rules,
                {
                  match: "builtin/bash",
                  effect: "ask",
                  when: { source: "arguments", any: "commands[*].command", regex: "(^|[;& ]+)rm[ ]" },
                },
              ])
            }
          >
            Add rule
          </button>
        </div>
      </section>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Test a sample</h2>
            <p>Runs the rules above against sample arguments. This never dispatches a tool.</p>
          </div>
        </div>
        <Field label="Sample canonical tool identity">
          <input value={identity} onChange={(e) => setIdentity(e.target.value)} />
        </Field>
        <Field label="Sample arguments JSON">
          <textarea value={sample} onChange={(e) => setSample(e.target.value)} />
        </Field>
        <div className="actions">
          <button
            onClick={() => {
              try {
                void api<{ effect: string }>("/policy/test", "POST", {
                  identity,
                  rules,
                  args: JSON.parse(sample),
                }).then(
                  (value) => setResult({ effect: value.effect }),
                  (cause) => setResult({ error: errorText(cause) }),
                );
              } catch (cause) {
                setResult({ error: errorText(cause) });
              }
            }}
          >
            Test rules
          </button>
          {result && (
            <p role="status" className="policy-result">
              {"effect" in result ? (
                <>
                  Sample result:{" "}
                  <span className={`badge ${tone[result.effect] ?? ""}`}>{result.effect}</span>
                </>
              ) : (
                <span className="error-text">{result.error}</span>
              )}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
