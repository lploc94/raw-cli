import type { TimelineEvent } from "../../../../src/panels/contract.js";
import { relativeTime } from "../panel-state.js";

const levelLabel = { info: "Info", success: "Success", warning: "Warning", error: "Error" } as const;
/** Newest first, with relative time. The document's own order is left untouched. */
export function Timeline({ events, max }: { events: TimelineEvent[]; max?: number | undefined }) {
  const kept = max && max > 0 ? events.slice(-max) : events;
  const shown = [...kept].reverse();
  const now = Date.now();
  return (
    <ol className="panel-timeline">
      {shown.map((event) => (
        <li key={event.id} className={`level-${event.level}`}>
          <time dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>{relativeTime(event.at, now)}</time>
          <span className="sr-only">{levelLabel[event.level]}: </span>
          <span>{event.label}</span>
          {event.detail && <p className="panel-note">{event.detail}</p>}
        </li>
      ))}
    </ol>
  );
}
