import type { KeyValueEntry } from "../../../../src/panels/contract.js";
import { Ref, type InsertRef } from "../status.js";

export function KeyValue({ entries, onInsert }: { entries: KeyValueEntry[]; onInsert: InsertRef }) {
  return (
    <dl className="panel-kv">
      {entries.map((entry, index) => (
        <div key={`${entry.key}:${index}`}>
          <dt>{entry.key}</dt>
          <dd>{entry.value}{entry.ref && <> <Ref value={entry.ref} onInsert={onInsert} /></>}</dd>
        </div>
      ))}
    </dl>
  );
}
