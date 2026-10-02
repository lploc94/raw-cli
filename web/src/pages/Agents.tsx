import { useConfig } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { useRouter } from "../router.js";
import { AgentDetail } from "./agents/AgentDetail.js";
import { AgentsList } from "./agents/AgentsList.js";

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
  return <AgentDetail key={name} name={name} config={config} changed={changed} createChat={createChat} />;
}
