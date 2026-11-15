import type { UiTableBlock } from "../../../lib/ui-blocks";

export function UiTable({ block }: { block: UiTableBlock }) {
  return <section className="ui-block ui-table" aria-label={block.title ?? "Таблица"}>
    {block.title && <header className="ui-block-head"><strong>{block.title}</strong></header>}
    <div className="ui-table-scroll">
      <table>
        <thead><tr>{block.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {block.rows.map((row, index) => <tr key={index}>
            {row.map((cell, cellIndex) => cellIndex === 0
              ? <th key={cellIndex} scope="row">{String(cell)}</th>
              : <td key={cellIndex}>{String(cell)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}
