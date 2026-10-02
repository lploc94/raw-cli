import { useState } from "react";
import type { ConfigView } from "../../../src/dashboard/management.js";
import { api, errorText } from "../api.js";
import { useComponents, useConfig } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { useRouter } from "../router.js";
import { ErrorMessage, Field } from "../ui.js";
import { AgentActionDialog, AgentActionsMenu, type AgentAction } from "./agents/AgentActions.js";
import { AgentsList } from "./agents/AgentsList.js";
import {
  DraftActions,
  object,
  parseObject,
  patch,
  pretty,
  SourceEditor,
  useDraft,
} from "../editors/shared.js";
export function AgentsPage({
  changed,
  createChat,
}: {
  changed: () => Promise<void>;
  createChat: (name?: string) => Promise<void>;
}) {
  const { path } = useRouter();
  const name = path.split("/")[2]
    ? decodeURIComponent(path.split("/")[2]!)
    : undefined;
  const { data: config, error: configError } = useConfig();
  const gate = usePageGate({ ready: !!config, error: configError, onRetry: () => void changed(), label: "Loading agents" });
  if (gate || !config) return gate;
  if (!name) return <AgentsList config={config} changed={changed} createChat={createChat} />;
  return (
    <div className="management-page">
      <span className="scope">This agent</span>
      <div className="section-heading">
        <h1>{name}</h1>
      </div>
      <AgentEditor
        key={name}
        name={name}
        config={config}
        changed={changed}
        createChat={createChat}
      />
    </div>
  );
}
function AgentEditor({
  name,
  config,
  changed,
  createChat,
}: {
  name: string;
  config: ConfigView;
  changed: () => Promise<void>;
  createChat: (name?: string) => Promise<void>;
}) {
  const { navigate } = useRouter();
  const toolList = useComponents("tools"),
    skillList = useComponents("skills"),
    hookList = useComponents("hooks");
  const catalog = {
    tools: toolList.data ?? [],
    skills: skillList.data ?? [],
    hooks: hookList.data ?? [],
  };
  const catalogError = toolList.error ?? skillList.error ?? hookList.error;
  const [action, setAction] = useState<AgentAction>();
  const draft = useDraft(
    `agent:${name}`,
    async () => {
      const entry = await api<{ value: unknown; revision: string }>(
        `/agents/${encodeURIComponent(name)}`,
      );
      return { source: pretty(entry.value), revision: entry.revision };
    },
    (value, before) =>
      api<ConfigView>("/agents", "POST", {
        revision: value.revision,
        action: "patch",
        name,
        value: patch(before, value.source),
      }),
    changed,
  );
  let value: Record<string, any> = {},
    parseError = "";
  try {
    if (draft.base) value = parseObject(draft.source);
  } catch (cause) {
    parseError = errorText(cause);
  }
  const set = (fields: Record<string, unknown>) =>
    draft.setSource(pretty({ ...value, ...fields }));
  const promptMode = value.system_prompt_file !== undefined ? "file" : "text";
  const changePrompt = (mode: string, text: string) => {
    const copy = { ...value };
    delete copy.system_prompt;
    delete copy.system_prompt_file;
    copy[mode === "file" ? "system_prompt_file" : "system_prompt"] = text;
    draft.setSource(pretty(copy));
  };
  const use = (kind: "tools" | "skills" | "hooks", list: unknown[]) => {
    const next = { ...value, [kind]: { ...object(value[kind]), use: list } };
    if (kind === "skills" && list.length) {
      const tools = object(next.tools);
      next.tools = {
        ...tools,
        use: [
          ...new Set([
            ...(tools.use ?? []),
            "builtin/list_skills",
            "builtin/load_skill",
          ]),
        ],
      };
    }
    draft.setSource(pretty(next));
  };
  return (
    <>
      <DraftActions draft={draft} />
      {!!catalogError && (
        <ErrorMessage>
          Could not load the tool, skill and hook lists. {errorText(catalogError)}{" "}
          <button
            className="text-button"
            onClick={() => void Promise.all([toolList.mutate(), skillList.mutate(), hookList.mutate()])}
          >
            Try again
          </button>
        </ErrorMessage>
      )}
      <div className="actions">
        <button
          disabled={draft.dirty || !draft.base}
          onClick={() => {
            void createChat(name);
          }}
        >
          New chat
        </button>
        <AgentActionsMenu
          name={name}
          isDefault={config.defaultAgent === name}
          {...(draft.dirty || !draft.base ? { disabledReason: "Save or discard changes first" } : {})}
          onSelect={setAction}
        />
      </div>
      {draft.base && !parseError && (
        <fieldset disabled={draft.busy} className="editor-fields">
          <Field label="Model">
            <select
              value={String(value.model ?? "")}
              onChange={(e) => set({ model: e.target.value })}
            >
              {config?.models.map((alias) => (
                <option key={alias}>{alias}</option>
              ))}
            </select>
          </Field>
          {value.from ? (
            <p className="notice">
              Package binding: {value.from}. Edit recipient inputs and complete
              replacement overrides in Agent JSON below. Omitted overrides
              inherit the package.
            </p>
          ) : (
            <>
              <Field label="Prompt source">
                <select
                  value={promptMode}
                  onChange={(e) => changePrompt(e.target.value, "")}
                >
                  <option value="text">Literal text</option>
                  <option value="file">Markdown file path</option>
                </select>
              </Field>
              <Field
                label={
                  promptMode === "file" ? "System prompt file" : "System prompt"
                }
                hint={
                  promptMode === "file"
                    ? "Relative to this config file. Read when the next turn attaches."
                    : "Sent as the system prompt on the next turn."
                }
              >
                <textarea
                  rows={4}
                  value={String(
                    value.system_prompt_file ?? value.system_prompt ?? "",
                  )}
                  onChange={(e) => changePrompt(promptMode, e.target.value)}
                />
              </Field>
              <Selection
                label="tools"
                values={object(value.tools).use ?? []}
                choices={catalog.tools.map((c) => c.id)}
                setValues={(list) => use("tools", list)}
              />
              <Selection
                label="skills"
                values={object(value.skills).use ?? []}
                choices={catalog.skills.map((c) => c.id)}
                setValues={(list) => use("skills", list)}
              />
              <Selection
                label="hooks"
                values={object(value.hooks).use ?? []}
                choices={catalog.hooks.map((c) => c.id)}
                setValues={(list) => use("hooks", list)}
              />
              <Selection
                label="vars"
                values={value.vars ?? []}
                choices={config?.vars ?? []}
                setValues={(list) => set({ vars: list })}
              />
              <PolicyEditor
                rules={object(value.tools).rules ?? []}
                onChange={(rules) =>
                  set({ tools: { ...object(value.tools), rules } })
                }
              />
            </>
          )}
        </fieldset>
      )}
      <details className="editor-section" open={!!value.from || !!parseError}>
        <summary>Agent JSON · all supported fields</summary>
        <p className="muted">
          Request options, cache, compact, limits, ordered rules and package
          selection aliases use the ordinary Raw schema. Removing a field
          restores its runtime default.
        </p>
        <ErrorMessage>{parseError}</ErrorMessage>
        <SourceEditor
          label="Agent JSON"
          value={draft.source}
          onChange={draft.setSource}
          readOnly={draft.busy}
        />
      </details>
      <AgentActionDialog
        action={action}
        name={name}
        agents={config.agents}
        onClose={() => setAction(undefined)}
        changed={changed}
        onDone={(done, newName) => {
          setAction(undefined);
          if (done === "delete") navigate("/agents");
          else if (done === "rename" || done === "duplicate") navigate(`/agents/${encodeURIComponent(newName)}`);
        }}
      />
    </>
  );
}
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
function PolicyEditor({
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
