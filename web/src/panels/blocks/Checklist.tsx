import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChecklistItem } from "../../../../src/panels/contract.js";
import { ItemActions, StatusControl } from "../actions.js";
import { Ref, StatusGlyph, type InsertRef } from "../status.js";

const finished = (item: ChecklistItem): boolean => (item.status === "done" || item.status === "skipped") && (item.children ?? []).every(finished);

function Items({ block, items, onInsert, hideCompleted }: { block: string; items: ChecklistItem[]; onInsert: InsertRef; hideCompleted: boolean }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const shown = hideCompleted ? items.filter((item) => !finished(item)) : items;
  return (
    <ul className="panel-checklist">
      {shown.map((item) => {
        const nested = !!item.children?.length;
        const closed = collapsed.has(item.id);
        return (
          <li key={item.id}>
            <div className="panel-row">
              {nested ? (
                <button
                  type="button"
                  className="panel-disclosure"
                  aria-expanded={!closed}
                  aria-label={`${closed ? "Expand" : "Collapse"} ${item.label}`}
                  onClick={() => setCollapsed((old) => { const next = new Set(old); if (!next.delete(item.id)) next.add(item.id); return next; })}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              ) : <span className="panel-disclosure-space" aria-hidden="true" />}
              <StatusControl block={block} item={item} name={item.label}><StatusGlyph status={item.status} /></StatusControl>
              <span className={item.status === "done" || item.status === "skipped" ? "panel-done" : undefined}>{item.label}</span>
              {item.priority && <small className="panel-tag">{item.priority}</small>}
              {item.ref && <Ref value={item.ref} onInsert={onInsert} />}
              <ItemActions block={block} item={item} name={item.label} />
            </div>
            {item.note && <p className="panel-note">{item.note}</p>}
            {nested && !closed ? <Items block={block} items={item.children!} onInsert={onInsert} hideCompleted={hideCompleted} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
export const Checklist = Items;
