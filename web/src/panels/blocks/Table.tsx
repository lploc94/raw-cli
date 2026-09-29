import type { TableColumn, TableRow } from "../../../../src/panels/contract.js";
import { ItemActions, StatusControl, useOfferer } from "../actions.js";
import { Ref, StatusGlyph, type InsertRef } from "../status.js";

export function Table({ block, title, columns, rows, onInsert }: { block: string; title: string; columns: TableColumn[]; rows: TableRow[]; onInsert: InsertRef }) {
  const offer = useOfferer();
  const actionable = rows.some((row) => offer("item", block, row).length > 0);
  return (
    <div className="panel-table-wrap" tabIndex={0} role="region" aria-label={title}>
      <table className="panel-table">
        <thead>
          <tr>
            {rows.some((row) => row.status) && <th scope="col"><span className="sr-only">Status</span></th>}
            {columns.map((column) => <th key={column.id} scope="col" style={{ textAlign: column.align ?? "start" }}>{column.label}</th>)}
            {rows.some((row) => row.ref) && <th scope="col"><span className="sr-only">File</span></th>}
            {actionable && <th scope="col"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {rows.some((r) => r.status) && <td>{row.status ? <StatusControl block={block} item={row} name={row.cells[columns[0]?.id ?? ""] ?? row.id}><StatusGlyph status={row.status} /></StatusControl> : null}</td>}
              {columns.map((column) => <td key={column.id} style={{ textAlign: column.align ?? "start" }}>{row.cells[column.id] ?? ""}</td>)}
              {rows.some((r) => r.ref) && <td>{row.ref ? <Ref value={row.ref} onInsert={onInsert} /> : null}</td>}
              {actionable && <td><ItemActions block={block} item={row} name={row.cells[columns[0]?.id ?? ""] ?? row.id} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
