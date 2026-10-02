import { useState, type ReactNode } from "react";
import { GitFork, PackagePlus, RefreshCw, Trash2, UserPlus } from "lucide-react";
import type { ConfigView } from "../../../../src/dashboard/management.js";
import type { PackageView } from "../../../../src/dashboard/packages.js";
import { Link, useRouter } from "../../router.js";
import { Empty, ErrorMessage } from "../../ui.js";
import { ActionMenu } from "../../ui/ActionMenu.js";
import { BindDialog, PackageActionDialog, PackagedFiles, PackageExports } from "./PackageDialogs.js";
import { sourceBadge, usageText } from "./PackagesList.js";

type Action = "component" | "update" | "fork" | "remove";

export function PackageDetail({
  alias,
  pkg,
  config,
  status,
  onUpdate,
  onDone,
  reload,
}: {
  alias: string;
  pkg: PackageView | undefined;
  config: ConfigView | undefined;
  status?: ReactNode;
  /** Opens the import dialog to replace this alias. */
  onUpdate: () => void;
  /** Reports a finished binding, fork or removal; `agent` is a newly created agent. */
  onDone: (status: string, agent?: string) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const { navigate } = useRouter();
  const [bind, setBind] = useState<"agent" | "component">();
  const [action, setAction] = useState<"fork" | "remove">();
  if (!pkg)
    return (
      <div className="management-page">
        <Empty title="Package not found" action={<Link href="/library/packages">Open Packages</Link>}>
          No installed package uses the alias “{alias}”.
        </Empty>
      </div>
    );
  const report = pkg.report;
  const hasAgents = !!report?.exports.agents.length;
  const hasComponents = !!report && Object.entries(report.exports).some(([kind, names]) => kind !== "agents" && names.length);
  return (
    <div className="management-page package-detail">
      <header className="detail-header">
        <nav aria-label="Breadcrumb" className="page-breadcrumb">
          <Link href="/library">Library</Link>
          <span aria-hidden="true">/</span>
          <Link href="/library/packages">Packages</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{alias}</span>
        </nav>
        <div className="detail-title">
          <div>
            <h1>{alias}</h1>
            <div className="metadata">
              <span className="badge">{pkg.entry.version}</span>
              <span className="badge">{sourceBadge(pkg)}</span>
              {pkg.diagnostic && <span className="badge warning">Needs attention</span>}
            </div>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={!hasAgents}
              title={hasAgents ? undefined : "This package exports no agents"}
              onClick={() => setBind("agent")}
            >
              <UserPlus size={15} aria-hidden="true" />
              Use agent
            </button>
            <ActionMenu<Action>
              label={`Actions for ${alias}`}
              onSelect={(next) => {
                if (next === "component") setBind("component");
                else if (next === "update") onUpdate();
                else setAction(next);
              }}
              items={[
                { id: "component", label: "Add component", icon: <PackagePlus size={15} aria-hidden="true" />, hidden: !hasComponents },
                { id: "update", label: "Update package", icon: <RefreshCw size={15} aria-hidden="true" /> },
                { id: "fork", label: "Fork package", icon: <GitFork size={15} aria-hidden="true" /> },
                { id: "remove", label: "Remove package", icon: <Trash2 size={15} aria-hidden="true" />, danger: true },
              ]}
            />
          </div>
        </div>
      </header>
      {status}
      <ErrorMessage>{pkg.diagnostic}</ErrorMessage>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Overview</h2>
            <p>Changes affect the next turn of existing sessions.</p>
          </div>
        </div>
        <dl className="details-grid">
          <dt>Package</dt>
          <dd>{pkg.entry.name}</dd>
          <dt>Version</dt>
          <dd>{pkg.entry.version}</dd>
          <dt>{pkg.entry.source.kind === "link" ? "Authored source" : "Digest"}</dt>
          <dd>
            <code>{pkg.entry.digest ?? pkg.entry.source.path}</code>
          </dd>
          <dt>Used by</dt>
          <dd>{pkg.usedBy?.length ? pkg.usedBy.join(", ") : usageText(pkg.usedBy)}</dd>
        </dl>
        <p className="card-footer muted">
          Package agent overrides are complete replacements, edited in <Link href="/agents">Agents</Link>.
        </p>
      </section>
      {report && (
        <>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Exports</h2>
                <p>
                  {report.files.length} packaged files · {report.inputs.length} declared inputs · Static validation only
                </p>
              </div>
            </div>
            <PackageExports report={report} />
            <h3 className="dialog-subheading">Packaged files</h3>
            <PackagedFiles files={report.files} />
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Requirements</h2>
                <p>What the recipient machine must provide.</p>
              </div>
            </div>
            <dl className="details-grid">
              <dt>Raw capabilities</dt>
              <dd>{report.requires.join(", ") || "None declared"}</dd>
              <dt>External executables</dt>
              <dd>{report.prerequisites.join(", ") || "None declared"}</dd>
            </dl>
          </section>
        </>
      )}
      <BindDialog mode={bind} pkg={pkg} config={config} reload={reload} onClose={() => setBind(undefined)} onDone={async (text, agent) => {
        setBind(undefined);
        await onDone(text, agent);
      }} />
      <PackageActionDialog
        action={action}
        alias={alias}
        onClose={() => setAction(undefined)}
        onDone={async (done, text) => {
          setAction(undefined);
          if (done === "remove") navigate("/library/packages");
          await onDone(text);
        }}
      />
    </div>
  );
}
