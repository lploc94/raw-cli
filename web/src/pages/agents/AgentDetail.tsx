import { useState } from "react";
import { Tabs } from "radix-ui";
import { MessageSquarePlus } from "lucide-react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import { api, errorText } from "../../api.js";
import {
  DraftActions,
  object,
  parseObject,
  patch,
  pretty,
  SourceEditor,
  useDraft,
} from "../../editors/shared.js";
import { useComponents } from "../../data/queries.js";
import { Link, useRouter } from "../../router.js";
import { Skeleton, SkeletonRegion } from "../../states.js";
import { ErrorMessage, Field } from "../../ui.js";
import { AgentActionDialog, AgentActionsMenu, type AgentAction } from "./AgentActions.js";
import { PolicyEditor } from "./PolicyEditor.js";
import { Selection } from "./Selection.js";

type Section = "overview" | "capabilities" | "policy" | "json";

export function AgentDetail({
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
  // Local state, not the URL: every navigation while dirty opens the leave guard.
  const [section, setSection] = useState<Section>();
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
  const summary = config.agentSummaries?.[name];
  // The draft is authoritative once it parses; the saved summary covers loading and parse errors.
  const bound = draft.base && !parseError ? !!value.from : !!summary?.from;
  const active: Section = section ?? (bound || parseError ? "json" : "overview");
  const blocked = draft.dirty || !draft.base;
  const panel = (id: Section) => ({
    value: id,
    forceMount: true as const,
    hidden: active !== id,
    className: "detail-panel",
  });
  return (
    <div className="management-page agent-detail">
      <header className="detail-header">
        <nav aria-label="Breadcrumb" className="page-breadcrumb">
          <Link href="/agents">Agents</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{name}</span>
        </nav>
        <div className="detail-title">
          <div>
            <h1>{name}</h1>
            <div className="metadata">
              {summary?.model && <code className="badge">{summary.model}</code>}
              {config.defaultAgent === name && <span className="badge accent">Default</span>}
              {summary?.from && <span className="badge">Package</span>}
            </div>
          </div>
          <div className="actions">
            <button
              disabled={blocked}
              title={draft.dirty ? "Save or discard changes first" : undefined}
              onClick={() => void createChat(name)}
            >
              <MessageSquarePlus size={15} aria-hidden="true" />
              New chat
            </button>
            <AgentActionsMenu
              name={name}
              isDefault={config.defaultAgent === name}
              {...(blocked ? { disabledReason: "Save or discard changes first" } : {})}
              onSelect={setAction}
            />
          </div>
        </div>
      </header>
      {!draft.base ? (
        draft.error ? (
          <ErrorMessage>{draft.error}</ErrorMessage>
        ) : (
          <SkeletonRegion label="Loading agent" className="skeleton-page">
            <Skeleton width={40} className="skeleton-title" />
            {[60, 90, 70].map((width) => (
              <div className="skeleton-card" key={width}>
                <Skeleton width={width as 60 | 90 | 70} />
              </div>
            ))}
          </SkeletonRegion>
        )
      ) : (
        <Tabs.Root value={active} onValueChange={(next) => setSection(next as Section)}>
          <Tabs.List className="tabs page-tabs" aria-label="Agent sections">
            <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
            {!bound && <Tabs.Trigger value="capabilities">Capabilities</Tabs.Trigger>}
            {!bound && <Tabs.Trigger value="policy">Policy</Tabs.Trigger>}
            <Tabs.Trigger value="json">JSON</Tabs.Trigger>
          </Tabs.List>
          <fieldset disabled={draft.busy} className="detail-fields">
            <Tabs.Content {...panel("overview")}>
              {parseError ? (
                <div className="notice">
                  <p>Agent JSON has an error, so the form is unavailable until it parses again.</p>
                  <button onClick={() => setSection("json")}>Open Agent JSON</button>
                </div>
              ) : (
                <>
                  <Field label="Model">
                    <select
                      value={String(value.model ?? "")}
                      onChange={(e) => set({ model: e.target.value })}
                    >
                      {config.models.map((alias) => (
                        <option key={alias}>{alias}</option>
                      ))}
                    </select>
                  </Field>
                  {value.from ? (
                    <div className="notice">
                      <p>
                        Package binding: {value.from}. Edit recipient inputs and complete
                        replacement overrides in Agent JSON. Omitted overrides inherit the
                        package.
                      </p>
                      <button onClick={() => setSection("json")}>Open Agent JSON</button>
                    </div>
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
                        label={promptMode === "file" ? "System prompt file" : "System prompt"}
                        hint={
                          promptMode === "file"
                            ? "Relative to this config file. Read when the next turn attaches."
                            : "Sent as the system prompt on the next turn."
                        }
                      >
                        <textarea
                          rows={4}
                          value={String(value.system_prompt_file ?? value.system_prompt ?? "")}
                          onChange={(e) => changePrompt(promptMode, e.target.value)}
                        />
                      </Field>
                    </>
                  )}
                </>
              )}
            </Tabs.Content>
            {!bound && (
              <Tabs.Content {...panel("capabilities")}>
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
                {!parseError && (
                  <>
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
                      choices={config.vars}
                      setValues={(list) => set({ vars: list })}
                    />
                  </>
                )}
              </Tabs.Content>
            )}
            {!bound && (
              <Tabs.Content {...panel("policy")}>
                {!parseError && (
                  <PolicyEditor
                    rules={object(value.tools).rules ?? []}
                    onChange={(rules) => set({ tools: { ...object(value.tools), rules } })}
                  />
                )}
              </Tabs.Content>
            )}
          </fieldset>
          <Tabs.Content {...panel("json")}>
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
          </Tabs.Content>
        </Tabs.Root>
      )}
      {/* Before the first load the page reports errors itself; a save bar has nothing to save yet. */}
      {draft.base && <DraftActions draft={draft} variant="bar" />}
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
    </div>
  );
}
