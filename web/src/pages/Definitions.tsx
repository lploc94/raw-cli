import { useConfig } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { errorText } from "../api.js";
import { DefinitionsPage as DefinitionsView } from "./library/DefinitionsPage.js";

export function DefinitionsPage({
  kind,
  changed,
}: {
  kind: "vars" | "mcp";
  changed: () => Promise<void>;
}) {
  const { data: config, error: configError, mutate } = useConfig();
  const gate = usePageGate({ ready: !!config, error: configError, onRetry: () => void mutate(), label: "Loading definitions" });
  if (gate) return gate;
  return (
    <DefinitionsView
      kind={kind}
      config={config!}
      changed={changed}
      {...(configError ? { error: errorText(configError), onRetry: () => void mutate() } : {})}
    />
  );
}
