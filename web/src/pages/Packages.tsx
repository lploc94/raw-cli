import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { PackageStageView } from "../../../src/dashboard/packages.js";
import { api, errorText } from "../api.js";
import { useConfig, usePackages, usePackageStages } from "../data/queries.js";
import { usePageGate } from "../states.js";
import { useRouter } from "../router.js";
import { ErrorMessage } from "../ui.js";
import { PackageDetail } from "./library/PackageDetail.js";
import { ExportDialog, ImportDialog, ReviewDialog } from "./library/PackageDialogs.js";
import { PackagesList } from "./library/PackagesList.js";

export function PackagesPage({
  changed,
  createChat,
}: {
  changed: () => Promise<void>;
  createChat: (agent?: string) => Promise<void>;
}) {
  const { path } = useRouter();
  const alias = path.split("/")[3] ? decodeURIComponent(path.split("/")[3]!) : undefined;
  const { data: packages, error: packagesError, mutate: mutatePackages } = usePackages();
  const { data: stages = [], error: stagesError, mutate: mutateStages } = usePackageStages();
  const { data: config } = useConfig();
  const [importing, setImporting] = useState<{ replacing?: string }>();
  const [review, setReview] = useState<{ stage: PackageStageView; replacing?: string }>();
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<{ text: string; agent?: string }>();
  const [discard, setDiscard] = useState<{ busy?: string; error?: string }>({});
  // `changed` revalidates bootstrap and the shared `/config`; packages are local to this page.
  const refresh = async () => {
    await Promise.all([mutatePackages(), mutateStages(), changed()]);
  };
  const staged = async (stage: PackageStageView, replacing?: string) => {
    setImporting(undefined);
    setExporting(false);
    setReview({ stage, ...(replacing ? { replacing } : {}) });
    await refresh();
  };
  const done = async (text: string, agent?: string) => {
    setStatus({ text, ...(agent ? { agent } : {}) });
    await refresh();
  };
  const gate = usePageGate({ ready: !!packages, error: packagesError, onRetry: () => void refresh(), label: "Loading packages" });
  if (gate) return gate;
  const statusView = status && (
    <div className="card notice package-status" role="status">
      <p>{status.text}</p>
      {status.agent && (
        <button className="primary" onClick={() => void createChat(status.agent)}>
          <MessageSquarePlus size={15} aria-hidden="true" />
          Chat with {status.agent}
        </button>
      )}
    </div>
  );
  return (
    <>
      {packagesError && (
        <ErrorMessage>
          Could not refresh packages. {errorText(packagesError)}{" "}
          <button className="text-button" onClick={() => void mutatePackages()}>
            Try again
          </button>
        </ErrorMessage>
      )}
      {alias ? (
        <PackageDetail
          alias={alias}
          pkg={packages!.find((item) => item.alias === alias)}
          config={config}
          status={statusView}
          onUpdate={() => setImporting({ replacing: alias })}
          onDone={done}
          reload={refresh}
        />
      ) : (
        <PackagesList
          packages={packages!}
          stages={stages}
          status={statusView}
          {...(stagesError ? { stagesError: errorText(stagesError) } : {})}
          {...(discard.error ? { discardError: discard.error } : {})}
          {...(discard.busy ? { busyStage: discard.busy } : {})}
          onImport={() => setImporting({})}
          onExport={() => setExporting(true)}
          onReview={(stage) => setReview({ stage })}
          onDiscard={(stage) => {
            setDiscard({ busy: stage.id });
            void api(`/packages/stages/${stage.id}`, "DELETE")
              .then(refresh)
              .then(
                () => setDiscard({}),
                (cause) => setDiscard({ error: errorText(cause) }),
              );
          }}
          onRetryStages={() => void mutateStages()}
        />
      )}
      <ImportDialog
        open={!!importing}
        {...(importing?.replacing ? { replacing: importing.replacing } : {})}
        onClose={() => setImporting(undefined)}
        onStaged={(stage) => staged(stage, importing?.replacing)}
      />
      <ReviewDialog
        stage={review?.stage}
        {...(review?.replacing ? { replacing: review.replacing } : {})}
        onClose={() => setReview(undefined)}
        onDone={async (text) => {
          setReview(undefined);
          await done(text);
        }}
      />
      <ExportDialog
        open={exporting}
        config={config}
        onClose={() => setExporting(false)}
        onStaged={(stage) => staged(stage)}
        reload={refresh}
      />
    </>
  );
}
