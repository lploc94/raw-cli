import type { TableColumn, TableRow } from "../../../../src/panels/contract.js";
import { Ref, StatusGlyph, type InsertRef } from "../status.js";

export function Table({ title, columns, rows, onInsert }: { title: string; columns: TableColumn[]; rows: TableRow[]; onInsert: InsertRef }) {
  return (
    <div className="panel-table-wrap" tabIndex={0} role="region" aria-label={title}>
      <table className="panel-table">
        <thead>
          <tr>
            {rows.some((row) => row.status) && <th scope="col"><span className="sr-only">Status</span></th>}
            {columns.map((column) => <th key={column.id} scope="col" style={{ textAlign: column.align ?? "start" }}>{column.label}</th>)}
            {rows.some((row) => row.ref) && <th scope="col"><span className="sr-only">File</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {rows.some((r) => r.status) && <td>{row.status ? <StatusGlyph status={row.status} /> : null}</td>}
              {columns.map((column) => <td key={column.id} style={{ textAlign: column.align ?? "start" }}>{row.cells[column.id] ?? ""}</td>)}
              {rows.some((r) => r.ref) && <td>{row.ref ? <Ref value={row.ref} onInsert={onInsert} /> : null}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
