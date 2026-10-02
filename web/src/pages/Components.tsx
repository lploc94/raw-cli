import { errorText } from "../api.js";
import { useComponents } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { useRouter } from "../router.js";
import { ComponentDetail } from "./library/ComponentDetail.js";
import { ComponentsList, type ComponentKind } from "./library/ComponentsList.js";

export function ComponentsPage({
  kind,
  changed,
}: {
  kind: ComponentKind;
  changed: () => Promise<void>;
}) {
  const { path } = useRouter();
  const id = path.split("/")[3]
    ? decodeURIComponent(path.split("/")[3]!)
    : undefined;
  const {
    data: loaded,
    error: listError,
    mutate: mutateItems,
  } = useComponents(kind);
  const refresh = async () => {
    await mutateItems();
  };
  const gate = usePageGate({ ready: !!loaded, error: listError, onRetry: () => void refresh(), label: "Loading components" });
  if (gate) return gate;
  if (!id)
    return (
      <ComponentsList
        kind={kind}
        items={loaded ?? []}
        {...(listError ? { error: errorText(listError), onRetry: () => void refresh() } : {})}
      />
    );
  return <ComponentDetail key={id} kind={kind} id={id} changed={changed} refresh={refresh} />;
}
