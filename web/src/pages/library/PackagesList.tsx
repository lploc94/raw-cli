import { useState, type ReactNode } from "react";
import { Download, Upload } from "lucide-react";
import type { PackageStageView, PackageView } from "../../../../src/dashboard/packages.js";
import { Link } from "../../router.js";
import { Empty, ErrorMessage, Field } from "../../ui.js";

export const sourceBadge = (item: PackageView) => (item.entry.source.kind === "link" ? "Linked" : "Artifact");
export const usageText = (usedBy: string[] | undefined) =>
  usedBy === undefined ? "Usage unavailable" : usedBy.length ? `Used by ${usedBy.length}` : "Not used";

export function PackagesList({
  packages,
  stages,
  status,
  stagesError,
  discardError,
  busyStage,
  onImport,
  onExport,
  onReview,
  onDiscard,
  onRetryStages,
}: {
  packages: PackageView[];
  stages: PackageStageView[];
  /** Outcome of the last install, link or binding, with any follow-up action. */
  status?: ReactNode;
  stagesError?: string;
  /** A failed discard, reported inside the artifacts card. */
  discardError?: string;
  /** An artifact being discarded; every artifact action waits for it. */
  busyStage?: string;
  onImport: () => void;
  onExport: () => void;
  onReview: (stage: PackageStageView) => void;
  onDiscard: (stage: PackageStageView) => void;
  onRetryStages: () => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const visible = packages.filter((item) => `${item.alias} ${item.entry.name}`.toLowerCase().includes(query));
  const importButton = (
    <button className="primary" onClick={onImport}>
      <Upload size={16} aria-hidden="true" />
      Import package
    </button>
  );
  const exportButton = (
    <button onClick={onExport}>
      <Download size={16} aria-hidden="true" />
      Export agent
    </button>
  );
  return (
    <div className="management-page">
      {status}
      {packages.length ? (
        <>
          <header className="resource-header">
            <div>
              <h1>Packages</h1>
              <p className="muted">Portable agents and components. Inspect, install, then bind what you need.</p>
            </div>
            <div className="actions">
              {exportButton}
              {importButton}
            </div>
          </header>
          <Field label="Search packages">
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </Field>
          {visible.length ? (
            <ul className="data-table" aria-label="Installed packages">
              {visible.map((item) => (
                <li key={item.alias} className="data-row package-row">
                  <div className="component-row-name">
                    <Link href={`/library/packages/${encodeURIComponent(item.alias)}`}>{item.alias}</Link>
                    <span className="muted component-row-description">{item.entry.name}</span>
                  </div>
                  <div className="metadata component-row-badges">
                    <span className="badge">{item.entry.version}</span>
                    <span className="badge">{sourceBadge(item)}</span>
                    {item.diagnostic && (
                      <span className="badge warning" title={item.diagnostic}>
                        Needs attention
                      </span>
                    )}
                  </div>
                  <span className="muted component-row-usage" title={item.usedBy?.join(", ")}>
                    {usageText(item.usedBy)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted catalog-no-results">
              No packages match “{filter.trim()}”.{" "}
              <button className="text-button" onClick={() => setFilter("")}>
                Clear search
              </button>
            </p>
          )}
        </>
      ) : (
        <Empty
          title="No packages yet"
          action={
            <div className="actions">
              {importButton}
              {exportButton}
            </div>
          }
        >
          Import a package from a folder or .rawpkg archive, or export one of your agents.
        </Empty>
      )}
      {(stages.length > 0 || stagesError) && (
        <section className="card artifacts-card">
          <div className="card-header">
            <div>
              <h2>Temporary artifacts</h2>
              <p>Up to four, kept for 30 minutes. Downloads remain yours after the server stops.</p>
            </div>
          </div>
          {stagesError && (
            <div className="error-banner" role="alert">
              Could not load staged packages. {stagesError}{" "}
              <button className="text-button" onClick={onRetryStages}>
                Try again
              </button>
            </div>
          )}
          <ErrorMessage>{discardError}</ErrorMessage>
          <ul className="used-by-list" aria-label="Temporary artifacts">
            {stages.map((stage) => (
              <li key={stage.id}>
                <span className="used-by-name">
                  {stage.report.name} <span className="badge">{stage.report.version}</span>
                </span>
                <span className="muted">
                  Expires {new Date(stage.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <button disabled={!!busyStage} onClick={() => onReview(stage)}>
                  Review
                </button>
                <button disabled={!!busyStage} onClick={() => onDiscard(stage)}>
                  Discard artifact
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
