import type { FileEntry } from "../../../../src/panels/contract.js";
import type { InsertRef } from "../status.js";

const letter = { added: "A", modified: "M", deleted: "D", referenced: "R" } as const;
export function Files({ entries, onInsert }: { entries: FileEntry[]; onInsert: InsertRef }) {
  return (
    <ul className="panel-files">
      {entries.map((entry, index) => (
        <li key={`${entry.path}:${index}`}>
          {entry.status && (
            <small className={`panel-tag file-${entry.status}`} title={entry.status}>
              <span aria-hidden="true">{letter[entry.status]}</span>
              <span className="sr-only">{entry.status}</span>
            </small>
          )}
          <button type="button" className="panel-ref" onClick={() => onInsert(entry.path)} title={`Insert @${entry.path} into the message`}>
            {entry.label ?? entry.path}{entry.line ? `:${entry.line}` : ""}
          </button>
        </li>
      ))}
    </ul>
  );
}
