import type { StepItem } from "../../../../src/panels/contract.js";
import { stepDuration } from "../panel-state.js";
import { ItemActions, StatusControl } from "../actions.js";
import { StatusGlyph } from "../status.js";

export function Steps({ block, items }: { block: string; items: StepItem[] }) {
  return (
    <ol className="panel-steps">
      {items.map((step) => {
        const took = stepDuration(step);
        return (
          <li key={step.id} aria-current={step.status === "in_progress" ? "step" : undefined}>
            <div className="panel-row">
              <StatusControl block={block} item={step} name={step.label}><StatusGlyph status={step.status} /></StatusControl>
              <span>{step.label}</span>
              {took && <small className="panel-tag" title="Time taken">{took}</small>}
              <ItemActions block={block} item={step} name={step.label} />
            </div>
            {step.detail && <p className="panel-note">{step.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
