import { Columns3, Minus, Rows3 } from "lucide-react";
import type { TableElement } from "../boardTypes";

/** A free-floating table on the board.
 *
 * Deliberately a plain `contentEditable`-free `<table>` of `<input>`-like cells rather than a
 * ProseMirror table: a board table has no surrounding document to participate in, so all the
 * machinery that makes note tables work (schema, cell selection plugin, grips - see
 * milkdown/tableSchemaExtensions.ts) buys nothing here and would drag a second editor instance
 * into every cell. What it does share is the shape of the data - row-major strings - which is what
 * lets `boardDigest` emit it as real Markdown table rows into the note's `.md`.
 *
 * Every structural edit goes through the helpers below rather than being written inline, so the
 * invariant that every row has the same length can't be broken from a call site. */
export function TableWidget({
  element,
  editable,
  onChange,
}: {
  element: TableElement;
  editable: boolean;
  onChange: (patch: Partial<TableElement>) => void;
}) {
  const cols = element.rows[0]?.length ?? 0;

  function setCell(row: number, col: number, value: string) {
    onChange({
      rows: element.rows.map((cells, r) =>
        r === row ? cells.map((cell, c) => (c === col ? value : cell)) : cells,
      ),
    });
  }

  function addRow() {
    onChange({ rows: [...element.rows, Array.from({ length: cols }, () => "")] });
  }

  function addColumn() {
    onChange({ rows: element.rows.map((cells) => [...cells, ""]) });
  }

  /** Drops the last row/column, but never the final one of either - an empty table has no cells to
   * click and would be unrecoverable without deleting the whole element. */
  function removeLast() {
    if (element.rows.length > 1) {
      onChange({ rows: element.rows.slice(0, -1) });
    } else if (cols > 1) {
      onChange({ rows: element.rows.map((cells) => cells.slice(0, -1)) });
    }
  }

  return (
    <div className="board-table-widget">
      <div className="board-widget-bar">
        <button type="button" className="board-widget-icon" onClick={addRow} disabled={!editable} title="Add row">
          <Rows3 size={13} />
        </button>
        <button type="button" className="board-widget-icon" onClick={addColumn} disabled={!editable} title="Add column">
          <Columns3 size={13} />
        </button>
        <button type="button" className="board-widget-icon" onClick={removeLast} disabled={!editable} title="Remove last row/column">
          <Minus size={13} />
        </button>
        <button
          type="button"
          className={`board-widget-chip ${element.headerRow ? "is-on" : ""}`}
          onClick={() => onChange({ headerRow: !element.headerRow })}
          disabled={!editable}
          title="Toggle header row"
        >
          Header
        </button>
      </div>
      <div className="board-table-scroll" style={{ pointerEvents: editable ? "auto" : "none" }}>
        <table className="board-table">
          <tbody>
            {element.rows.map((cells, r) => (
              <tr key={r} className={element.headerRow && r === 0 ? "is-header" : ""}>
                {cells.map((cell, c) => (
                  <td key={c}>
                    <input
                      value={cell}
                      readOnly={!editable}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      // Without this the pointerdown bubbles to the board, which treats it as the
                      // start of an element drag and steals focus back out of the cell.
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
