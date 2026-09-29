import type { StepItem } from "../../../../src/panels/contract.js";
import { stepDuration } from "../panel-state.js";
import { StatusGlyph } from "../status.js";

export function Steps({ items }: { items: StepItem[] }) {
  return (
    <ol className="panel-steps">
      {items.map((step) => {
        const took = stepDuration(step);
        return (
          <li key={step.id} aria-current={step.status === "in_progress" ? "step" : undefined}>
            <div className="panel-row">
              <StatusGlyph status={step.status} />
              <span>{step.label}</span>
              {took && <small className="panel-tag" title="Time taken">{took}</small>}
            </div>
            {step.detail && <p className="panel-note">{step.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
