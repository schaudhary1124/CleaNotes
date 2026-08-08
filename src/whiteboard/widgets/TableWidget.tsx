import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Columns3,
  Eraser,
  Rows3,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  cellFill,
  clearCells,
  colWidth,
  columnAlign,
  columnCount,
  gridWidth,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  rowHeight,
  setCell,
  setCellFill,
  setColWidth,
  setColumnAlign,
  setLineFill,
  setRowHeight,
} from "../tableOps";
import type { BoardCellFill, BoardTextAlign, TableElement } from "../boardTypes";

/** A free-floating table on the board.
 *
 * Deliberately a plain `contentEditable`-free `<table>` of `<input>`-like cells rather than a
 * ProseMirror table: a board table has no surrounding document to participate in, so all the
 * machinery that makes note tables work (schema, cell selection plugin, grips - see
 * milkdown/tableSchemaExtensions.ts) buys nothing here and would drag a second editor instance
 * into every cell. What it does share is the shape of the data - row-major strings - which is what
 * lets `boardDigest` emit it as real Markdown table rows into the note's `.md`, and it now shares
 * the note table's whole *repertoire*: insert and delete at a specific row or column rather than
 * only at the end, per-column alignment, cell fills, and Tab/arrow navigation between cells.
 *
 * The grid is *scrolled* inside the element's box rather than fitted to it. Columns carry their own
 * widths (see tableOps' colWidth), so inserting one makes the table wider - and scrollable - instead
 * of squeezing every column already there down a notch, which is what made a table of any width
 * unreadable on a board where the element's own size is a placement decision, not a statement about
 * the data.
 *
 * Structure is reached the same way it is in a note - through grips. A strip above each column and
 * beside each row opens that line's menu (see milkdown/tableGrips.ts, which does exactly this for a
 * note table), highlights the line it belongs to while that menu is open, and can be dragged by its
 * far edge to resize the line. Both strips are sticky, so scrolling to the far corner of a wide
 * table doesn't scroll away the only handles on its structure. Grips only appear once the element is
 * live, so a table sitting on the canvas reads as a table rather than as a table wearing a control
 * panel.
 *
 * Every structural edit goes through tableOps rather than being written inline, so the invariant
 * that `rows`, `fills`, `align` and the two size arrays stay the same shape can't be broken from a
 * call site. */

/** Thickness of the column-grip strip and the row-grip gutter, in the widget's own px. Wide enough
 * to hold a grip plus the resize target at its edge. */
const GRIP_SIZE = 14;

/** Gap between a grip and the menu it opens. */
const MENU_GAP = 4;

/** How close a menu may come to the edge of the board viewport before it is pushed back in. */
const MENU_MARGIN = 8;

/** Same palette the note table's cell colours offer (components/TableMenu.tsx's CELL_COLORS), so a
 * table filled in on a board and one filled in in a note are the same colours. */
const CELL_COLORS: { label: string; value: string }[] = [
  { label: "Red", value: "rgba(248, 113, 113, 0.35)" },
  { label: "Orange", value: "rgba(251, 146, 60, 0.35)" },
  { label: "Yellow", value: "rgba(250, 204, 21, 0.35)" },
  { label: "Green", value: "rgba(74, 222, 128, 0.3)" },
  { label: "Blue", value: "rgba(96, 165, 250, 0.3)" },
  { label: "Purple", value: "rgba(192, 132, 252, 0.3)" },
  { label: "Gray", value: "rgba(148, 163, 184, 0.3)" },
];

const ALIGNMENTS: { align: BoardTextAlign; label: string; icon: LucideIcon }[] = [
  { align: "left", label: "Align left", icon: AlignLeft },
  { align: "center", label: "Align center", icon: AlignCenter },
  { align: "right", label: "Align right", icon: AlignRight },
];

/** A box in the coordinate space of the surrounding `.board-element` - see `localBox`. */
type Box = { x: number; y: number; w: number; h: number };

/** What a menu is aimed at, and the grip (or cell) it hangs off. */
type OpenMenu = { row: number; col: number; scope: "row" | "column" | "cell"; anchor: Box };

/** A resize drag in progress. `scale` is captured once at pointer-down: the board can't be zoomed
 * mid-drag, and re-measuring it on every pointer sample would be a layout read per frame. */
type Resize = { axis: "column" | "row"; index: number; origin: number; start: number; scale: number };


/** `node`'s box in the coordinate space of the surrounding `.board-element`, which is where menus
 * render so they can overhang the table's own clipped bounds instead of being cut off by them.
 *
 * Measured from client rects rather than from `offsetLeft`/`offsetTop`: inside a `<table>` those are
 * relative to the enclosing cell, not to the nearest positioned ancestor (`offsetParent` stops at
 * any `td`/`th`/`table`), which would put every menu at the top-left of the cell whose grip opened
 * it. Client rects are in *screen* px and the whole board sits inside a `transform: scale()` layer,
 * so the delta is divided back down by the scale the element is actually painted at - derived from
 * the element's own rect against its layout width, so this needs no knowledge of the viewport. */
function localBox(node: HTMLElement): Box | null {
  const host = node.closest<HTMLElement>(".board-element");
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  const scale = elementScale(host);
  const rect = node.getBoundingClientRect();
  return {
    x: (rect.left - hostRect.left) / scale,
    y: (rect.top - hostRect.top) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  };
}

/** The zoom a `.board-element` is currently painted at, read from its own geometry. */
function elementScale(host: HTMLElement): number {
  const rect = host.getBoundingClientRect();
  return host.offsetWidth > 0 && rect.width > 0 ? rect.width / host.offsetWidth : 1;
}

export function TableWidget({
  element,
  editable,
  onChange,
  onDelete,
}: {
  element: TableElement;
  editable: boolean;
  onChange: (patch: Partial<TableElement>) => void;
  /** Removes the whole element. Every other widget's chrome can only edit what it holds; a table
   * with a column left in it can't be emptied down to nothing (see tableOps' one-row/one-column
   * floor), so without this the only way out was to click off it and find the board's own delete. */
  onDelete: () => void;
}) {
  const cols = columnCount(element);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  /** The cell the caret is in, so its row and column grips can say so. */
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLTableSectionElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resize = useRef<Resize | null>(null);

  // A widget that stops being live drops its menu and its highlight with it - otherwise they hang
  // over a click-through element, visible but unreachable.
  useEffect(() => {
    if (!editable) {
      setMenu(null);
      setFocus(null);
    }
  }, [editable]);

  // The caret's cell is remembered as a row/column pair, which a structural edit can silently
  // repoint: delete row 2 and the input that had focus is gone (React unmounts it without a blur),
  // while row 3 has slid into its index and would light up in its place. Forgetting on any change
  // of shape is enough - the one case that re-focuses afterwards, Tab off the last cell, sets it
  // again when the new input takes focus.
  useEffect(() => {
    setFocus(null);
  }, [element.rows.length, cols]);

  // Which line the open menu is acting on, and so which one is tinted. A cell-scoped menu tints
  // nothing: the cell it came from already shows a focus ring, and lighting up its whole row *and*
  // column would say the menu does more than it does.
  const litRow = menu?.scope === "row" ? menu.row : null;
  const litCol = menu?.scope === "column" ? menu.col : null;

  /** Opens a menu against `anchor`; the placement itself is TableMenu's job, since only it knows how
   * big the menu turned out to be. */
  function openMenu(anchor: HTMLElement, next: Omit<OpenMenu, "anchor">) {
    const box = localBox(anchor);
    if (box) setMenu({ ...next, anchor: box });
  }

  /** A second click on the grip that opened a menu closes it again. */
  function toggleMenu(anchor: HTMLElement, next: Omit<OpenMenu, "anchor">) {
    const alreadyOpen =
      menu?.scope === next.scope && menu.row === next.row && menu.col === next.col;
    if (alreadyOpen) setMenu(null);
    else openMenu(anchor, next);
  }

  /** Focuses the nth cell input in document order. Bounds-checked against the DOM rather than
   * against `element`, so it stays correct when called right after a structural change that the
   * props in this closure predate - Tab off the last cell being exactly that case. */
  function focusFlat(flat: number) {
    if (flat < 0) return;
    const input = gridRef.current?.querySelectorAll<HTMLInputElement>("input")[flat];
    input?.focus();
    input?.select();
  }

  /** Scrolls a just-inserted row or column into view.
   *
   * Inserting one no longer narrows the lines already there - that is the whole point of the stored
   * widths - so on a table that already fills its frame the new line lands outside it. Unseen, an
   * insert reads as nothing having happened at all.
   *
   * The offsets come from the pre-insert element in this closure, which is exactly right: a line
   * inserted at `index` takes the position the line at `index` had, and everything before it is
   * untouched. The scroll itself waits a frame, because until React has painted the wider table
   * there is no overflow to scroll into. */
  function reveal(axis: "row" | "column", index: number) {
    const pane = scrollRef.current;
    if (!pane) return;
    let start = GRIP_SIZE;
    for (let i = 0; i < index; i++) {
      start += axis === "column" ? colWidth(element, i) : rowHeight(element, i);
    }
    const size = axis === "column" ? DEFAULT_COL_WIDTH : DEFAULT_ROW_HEIGHT;
    requestAnimationFrame(() => {
      const offset = axis === "column" ? pane.scrollLeft : pane.scrollTop;
      const view = axis === "column" ? pane.clientWidth : pane.clientHeight;
      // The sticky grip strip covers the leading edge of the pane, so "in view" starts one grip in -
      // otherwise a line scrolled to the very edge sits underneath its own grips.
      const next =
        start - GRIP_SIZE < offset
          ? start - GRIP_SIZE
          : start + size > offset + view
            ? start + size - view
            : offset;
      if (axis === "column") pane.scrollLeft = next;
      else pane.scrollTop = next;
    });
  }

  function addRow(at: number) {
    onChange(insertRow(element, at));
    reveal("row", at);
  }

  function addColumn(at: number) {
    onChange(insertColumn(element, at));
    reveal("column", at);
  }

  /** Starts a column-width or row-height drag from the far edge of a grip. */
  function beginResize(e: React.PointerEvent<HTMLElement>, axis: "column" | "row", index: number) {
    if (!editable) return;
    // Without both of these the board takes the pointer as the start of an element drag, and the
    // browser starts selecting text across the grid behind it.
    e.preventDefault();
    e.stopPropagation();
    const host = e.currentTarget.closest<HTMLElement>(".board-element");
    resize.current = {
      axis,
      index,
      scale: host ? elementScale(host) : 1,
      origin: axis === "column" ? e.clientX : e.clientY,
      start: axis === "column" ? colWidth(element, index) : rowHeight(element, index),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    // The menu was anchored to a grip that is about to move out from under it.
    setMenu(null);
  }

  function continueResize(e: React.PointerEvent<HTMLElement>) {
    const drag = resize.current;
    if (!drag) return;
    // Screen px back into the element's own units - the same conversion localBox does, for the same
    // reason: the whole board is inside a scaled layer.
    const travel = ((drag.axis === "column" ? e.clientX : e.clientY) - drag.origin) / drag.scale;
    onChange(
      drag.axis === "column"
        ? setColWidth(element, drag.index, drag.start + travel)
        : setRowHeight(element, drag.index, drag.start + travel),
    );
  }

  function endResize(e: React.PointerEvent<HTMLElement>) {
    if (!resize.current) return;
    resize.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handleCellKeyDown(e: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    // Board shortcuts must never fire from inside a cell - a bare "e" is the eraser tool otherwise.
    e.stopPropagation();
    const input = e.currentTarget;
    switch (e.key) {
      case "Tab": {
        e.preventDefault();
        const flat = row * cols + col + (e.shiftKey ? -1 : 1);
        // Tabbing off the last cell adds a row, which is how a table gets longer without reaching
        // for a menu - the single most common structural edit there is.
        if (flat >= element.rows.length * cols) {
          onChange(insertRow(element, element.rows.length));
          // The new row's inputs don't exist until React has painted them.
          requestAnimationFrame(() => focusFlat(flat));
          return;
        }
        focusFlat(flat);
        return;
      }
      case "Enter":
        e.preventDefault();
        focusFlat((row + (e.shiftKey ? -1 : 1)) * cols + col);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusFlat((row - 1) * cols + col);
        return;
      case "ArrowDown":
        e.preventDefault();
        focusFlat((row + 1) * cols + col);
        return;
      case "ArrowLeft":
        // Only steps out of the cell from its very start, so arrowing through text still works.
        if (input.selectionStart === 0 && input.selectionEnd === 0) {
          e.preventDefault();
          focusFlat(row * cols + col - 1);
        }
        return;
      case "ArrowRight":
        if (input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
          e.preventDefault();
          focusFlat(row * cols + col + 1);
        }
        return;
      case "Escape":
        input.blur();
        return;
    }
  }

  return (
    <>
      <div className="board-table-widget">
        <div className="board-widget-bar">
          <button
            type="button"
            className="board-widget-icon"
            onClick={() => addRow(element.rows.length)}
            disabled={!editable}
            title="Add row"
          >
            <Rows3 size={13} />
          </button>
          <button
            type="button"
            className="board-widget-icon"
            onClick={() => addColumn(cols)}
            disabled={!editable}
            title="Add column"
          >
            <Columns3 size={13} />
          </button>
          <div className="board-widget-bar-end">
            <button
              type="button"
              className="board-widget-icon"
              onClick={() => onChange(clearCells(element))}
              disabled={!editable}
              title="Clear every cell's text"
            >
              <Eraser size={13} />
            </button>
            <button
              type="button"
              className="board-widget-icon is-danger"
              onClick={onDelete}
              disabled={!editable}
              title="Delete table"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        <div
          className="board-table-scroll"
          ref={scrollRef}
          style={{ pointerEvents: editable ? "auto" : "none" }}
          // A menu is placed against where its grip was when it opened. Sticky grips mean scrolling
          // moves half of them and not the other half, so rather than chase the anchor the menu
          // closes - which is also what a menu pointing at a line scrolled out from under it should
          // do.
          onScroll={() => setMenu(null)}
        >
          <table
            className="board-table"
            // Sized from the columns rather than stretched to the frame: `table-layout: fixed`
            // hands each column exactly the width stored for it, and the total is what overflows
            // (and so scrolls) once there are more columns than the element's box can show.
            style={{ width: gridWidth(element) + (editable ? GRIP_SIZE : 0) }}
          >
            <colgroup>
              {editable && <col style={{ width: GRIP_SIZE }} />}
              {Array.from({ length: cols }, (_, c) => (
                <col key={c} style={{ width: colWidth(element, c) }} />
              ))}
            </colgroup>
            <tbody ref={gridRef}>
              {editable && (
                // The column grip strip. A `<tr>` of its own rather than a `<thead>`, so it shares
                // the body's column widths automatically - a separate table head would need them
                // measured and mirrored.
                <tr style={{ height: GRIP_SIZE }}>
                  <td className="board-table-corner" />
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} className="board-table-grip-cell is-col">
                      <button
                        type="button"
                        className={`board-table-grip${menu?.scope === "column" && menu.col === c ? " is-on" : ""}${
                          focus?.col === c ? " is-active" : ""
                        }`}
                        data-board-menu-toggle
                        title="Column options"
                        aria-label={`Column ${c + 1} options`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => toggleMenu(e.currentTarget, { scope: "column", row: 0, col: c })}
                      />
                      {c > 0 && (
                        <ResizeHandle axis="column" index={c - 1} onBegin={beginResize} onMove={continueResize} onEnd={endResize} />
                      )}
                      {c === cols - 1 && (
                        <ResizeHandle axis="column" index={c} trailing onBegin={beginResize} onMove={continueResize} onEnd={endResize} />
                      )}
                    </td>
                  ))}
                </tr>
              )}
              {element.rows.map((cells, r) => (
                <tr
                  key={r}
                  className={element.headerRow && r === 0 ? "is-header" : ""}
                  style={{ height: rowHeight(element, r) }}
                >
                  {editable && (
                    <td className="board-table-grip-cell is-row">
                      <button
                        type="button"
                        className={`board-table-grip${menu?.scope === "row" && menu.row === r ? " is-on" : ""}${
                          focus?.row === r ? " is-active" : ""
                        }`}
                        data-board-menu-toggle
                        title="Row options"
                        aria-label={`Row ${r + 1} options`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => toggleMenu(e.currentTarget, { scope: "row", row: r, col: 0 })}
                      />
                      {r > 0 && (
                        <ResizeHandle axis="row" index={r - 1} onBegin={beginResize} onMove={continueResize} onEnd={endResize} />
                      )}
                      {r === element.rows.length - 1 && (
                        <ResizeHandle axis="row" index={r} trailing onBegin={beginResize} onMove={continueResize} onEnd={endResize} />
                      )}
                    </td>
                  )}
                  {cells.map((cell, c) => (
                    <td
                      key={c}
                      className={`board-table-cell${c === 0 ? " is-left" : ""}${r === 0 ? " is-top" : ""}${
                        r === litRow || c === litCol ? " is-lit" : ""
                      }`}
                      // `backgroundColor`, not `background`: the line highlight is painted as a
                      // background *image* over this, and the shorthand would erase it.
                      style={{ backgroundColor: cellFill(element, r, c) ?? undefined }}
                    >
                      <input
                        value={cell}
                        readOnly={!editable}
                        style={{ textAlign: columnAlign(element, c) }}
                        onChange={(e) => onChange(setCell(element, r, c, e.target.value))}
                        onKeyDown={(e) => handleCellKeyDown(e, r, c)}
                        onFocus={() => setFocus({ row: r, col: c })}
                        // Guarded, because focus moving to the next cell fires that cell's `focus`
                        // before this one's `blur` - an unconditional clear would drop the new one.
                        onBlur={() =>
                          setFocus((at) => (at && at.row === r && at.col === c ? null : at))
                        }
                        // Without this the pointerdown bubbles to the board, which treats it as the
                        // start of an element drag and steals focus back out of the cell.
                        onPointerDown={(e) => e.stopPropagation()}
                        // Right-click is the other way into the menu, for anyone who reaches for a
                        // context menu before noticing the grips - and it's the only route to a
                        // *cell's* own fill, which is what the note table colours.
                        onContextMenu={(e) => {
                          if (!editable) return;
                          e.preventDefault();
                          openMenu(e.currentTarget, { scope: "cell", row: r, col: c });
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Outside `.board-table-widget` on purpose: that box clips its own overflow so a long table
          scrolls inside it, and a menu rendered within it would be cut off at the same edge. */}
      {menu && editable && (
        <TableMenu
          element={element}
          menu={menu}
          onChange={onChange}
          onInsertRow={addRow}
          onInsertColumn={addColumn}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Everything that can be done to one row, column, or cell: insert either side of it, delete the
 * line itself, tint it, and set the alignment of the column it sits in.
 *
 * One menu for all three scopes rather than three nearly-identical ones - the operations are the
 * same, and the scope only decides what "delete" and "fill" are pointed at. Deleting is offered to
 * the two *line* scopes only: a cell's menu is opened by right-clicking the cell, where "delete
 * row" is a click away from an edit that throws away data the pointer was never over. Reaching for
 * a row or column's grip says which line is meant, and lights it up to confirm it.
 *
 * A cell-scoped menu is otherwise the closest thing to what a note table offers (see
 * components/TableMenu.tsx), and is deliberately the one right-click opens. */
function TableMenu({
  element,
  menu,
  onChange,
  onInsertRow,
  onInsertColumn,
  onClose,
}: {
  element: TableElement;
  menu: OpenMenu;
  onChange: (patch: Partial<TableElement>) => void;
  onInsertRow: (at: number) => void;
  onInsertColumn: (at: number) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const rowScope = menu.scope === "row";
  const columnScope = menu.scope === "column";
  // The last row or column can't be deleted - an empty table has no cell to click and no way back
  // short of deleting the whole element (see tableOps' removeRow/removeColumn, which enforce it).
  const canDelete = rowScope ? element.rows.length > 1 : columnCount(element) > 1;

  // Runs before paint, so the fallback position below is never the one the user sees. Measuring
  // rather than estimating is the point: the menu's height depends on which scope opened it, and
  // that height is what decides whether it can open downwards at all.
  useLayoutEffect(() => {
    if (hostRef.current) setPlaced(placeMenu(hostRef.current, menu));
  }, [menu]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      // The grip that opened this toggles on *click*, which lands after this pointerdown - closing
      // on it here would let that toggle immediately reopen the menu.
      if (hostRef.current?.contains(target) || target?.closest("[data-board-menu-toggle]")) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  /** Applies a patch and closes. Structural commands are one-shot; the align and colour rows below
   * call `onChange` directly instead, staying open so a column can be tried in each alignment. */
  function apply(patch: Partial<TableElement> | null) {
    if (patch) onChange(patch);
    onClose();
  }

  /** Inserts are routed back through the widget, which owns the scroll pane the new line has to be
   * revealed in. */
  function insert(axis: "row" | "column", at: number) {
    (axis === "row" ? onInsertRow : onInsertColumn)(at);
    onClose();
  }

  function fill(value: BoardCellFill) {
    onChange(
      menu.scope === "cell"
        ? setCellFill(element, menu.row, menu.col, value)
        : setLineFill(element, { kind: menu.scope, index: rowScope ? menu.row : menu.col }, value),
    );
  }

  return (
    <div
      className="board-table-menu"
      ref={hostRef}
      style={placed ?? fallbackPlacement(menu)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* One labelled strip of icons rather than a sentence per command - the shape the alignment and
          fill controls below already use. A cell's menu offers all four inserts and so names both
          axes; a row or column menu shows only its own pair, and says so. Each icon keeps the
          sentence it replaced as its tooltip and its accessible name. */}
      <div className="board-table-menu-label">
        {menu.scope === "cell" ? "Insert row/column" : rowScope ? "Insert row" : "Insert column"}
      </div>
      <div className="board-table-menu-row">
        {!columnScope && (
          <>
            <MenuIcon icon={ArrowUpToLine} label="Insert row above" onClick={() => insert("row", menu.row)} />
            <MenuIcon
              icon={ArrowDownToLine}
              label="Insert row below"
              onClick={() => insert("row", menu.row + 1)}
            />
          </>
        )}
        {!rowScope && (
          <>
            <MenuIcon
              icon={ArrowLeftToLine}
              label="Insert column left"
              onClick={() => insert("column", menu.col)}
            />
            <MenuIcon
              icon={ArrowRightToLine}
              label="Insert column right"
              onClick={() => insert("column", menu.col + 1)}
            />
          </>
        )}
      </div>

      {menu.scope !== "cell" && (
        <>
          <div className="board-table-menu-divider" />
          <MenuItem
            icon={Trash2}
            danger
            disabled={!canDelete}
            onClick={() =>
              apply(rowScope ? removeRow(element, menu.row) : removeColumn(element, menu.col))
            }
          >
            {rowScope ? "Delete row" : "Delete column"}
          </MenuItem>
        </>
      )}

      {!rowScope && (
        <>
          <div className="board-table-menu-divider" />
          <div className="board-table-menu-label">Column align</div>
          <div className="board-table-menu-row">
            {ALIGNMENTS.map(({ align, label, icon }) => (
              <MenuIcon
                key={align}
                icon={icon}
                label={label}
                active={columnAlign(element, menu.col) === align}
                onClick={() => onChange(setColumnAlign(element, menu.col, align))}
              />
            ))}
          </div>
        </>
      )}

      <div className="board-table-menu-divider" />
      <div className="board-table-menu-label">
        {menu.scope === "cell" ? "Cell fill" : rowScope ? "Row fill" : "Column fill"}
      </div>
      <div className="board-table-menu-row is-wrap">
        {CELL_COLORS.map((color) => (
          <button
            key={color.label}
            type="button"
            title={color.label}
            aria-label={color.label}
            className="board-table-swatch"
            style={{ background: color.value }}
            onClick={() => fill(color.value)}
          />
        ))}
        <button
          type="button"
          title="Clear fill"
          aria-label="Clear fill"
          className="board-table-swatch is-clear"
          onClick={() => fill(null)}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** Where a menu opens before it has been measured: its preferred side, unchecked. Only ever painted
 * if the layout effect can't find the board around it. */
function fallbackPlacement(menu: OpenMenu): { left: number; top: number } {
  return preferredPlacements(menu, 0, 0)[0];
}

/** The two placements a menu will accept, best first.
 *
 * A menu never opens on top of the line it acts on: a column's options go beside the column, a
 * row's above or below the row. The tinted line then stays in sight next to the commands acting on
 * it - a menu covering the row it is about to delete makes the user confirm the target from memory.
 * The second entry is the same placement mirrored, which is what a table near the right or bottom
 * edge of the viewport falls back to.
 *
 * A cell's menu takes the row's axis: it is opened by right-clicking, and dropping below the
 * pointer is what a context menu is expected to do. */
function preferredPlacements(menu: OpenMenu, w: number, h: number): { left: number; top: number }[] {
  const a = menu.anchor;
  return menu.scope === "column"
    ? [
        { left: a.x + a.w + MENU_GAP, top: a.y },
        { left: a.x - w - MENU_GAP, top: a.y },
      ]
    : [
        { left: a.x, top: a.y + a.h + MENU_GAP },
        { left: a.x, top: a.y - h - MENU_GAP },
      ];
}

/** Resolves a menu's final position in the element's own coordinate space: the first preferred
 * placement that lands fully inside the board viewport, clamped back into it if neither does. */
function placeMenu(host: HTMLElement, menu: OpenMenu): { left: number; top: number } {
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  const options = preferredPlacements(menu, w, h);
  const limit = viewportBounds(host);
  if (!limit) return options[0];
  const fits = options.find(
    (at) =>
      at.left >= limit.left &&
      at.left + w <= limit.right &&
      at.top >= limit.top &&
      at.top + h <= limit.bottom,
  );
  const chosen = fits ?? options[0];
  return {
    left: clamp(chosen.left, limit.left, limit.right - w),
    top: clamp(chosen.top, limit.top, limit.bottom - h),
  };
}

/** The visible board, expressed in the coordinate space menus are positioned in - i.e. offsets from
 * the `.board-element`'s top-left, divided back down by the zoom it is painted at. Everything a
 * placement decision needs is then in one space, with no viewport maths of its own. */
function viewportBounds(
  host: HTMLElement,
): { left: number; right: number; top: number; bottom: number } | null {
  const element = host.closest<HTMLElement>(".board-element");
  const canvas = host.closest<HTMLElement>(".board-canvas");
  if (!element || !canvas) return null;
  const scale = elementScale(element);
  const origin = element.getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  return {
    left: (rect.left - origin.left) / scale + MENU_MARGIN,
    right: (rect.right - origin.left) / scale - MENU_MARGIN,
    top: (rect.top - origin.top) / scale + MENU_MARGIN,
    bottom: (rect.bottom - origin.top) / scale - MENU_MARGIN,
  };
}

/** Clamps into [min, max], surviving a max below the min - which is what a menu taller than the
 * board itself produces, and which would otherwise pin it to the bottom edge and cut off its top. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** The drag target on the boundary between two lines.
 *
 * Rendered on the *leading* edge of the grip that follows the boundary and resizing the line before
 * it - the spreadsheet convention, and also what lets the target sit on the line rather than beside
 * it. Straddling means hanging a few px into a neighbouring grip, and each grip is a sticky cell
 * and so its own stacking context; reaching backwards means the overhang lands on an *earlier*
 * sibling, which already paints below. Reaching forwards would need every grip ranked above the
 * next one along, and a rank that climbs with the column count is a rank that eventually climbs
 * over the menus.
 *
 * The last line on each axis has no following grip to host its handle, so it carries a `trailing`
 * one of its own. That one has nothing to overhang, and sits inside the table rather than past its
 * edge - 3px of overhang there is 3px of phantom overflow for the scroll pane to claim the wheel
 * over. */
function ResizeHandle({
  axis,
  index,
  trailing,
  onBegin,
  onMove,
  onEnd,
}: {
  axis: "column" | "row";
  index: number;
  trailing?: boolean;
  onBegin: (e: React.PointerEvent<HTMLElement>, axis: "column" | "row", index: number) => void;
  onMove: (e: React.PointerEvent<HTMLElement>) => void;
  onEnd: (e: React.PointerEvent<HTMLElement>) => void;
}) {
  return (
    <span
      className={`board-table-resize ${axis === "column" ? "is-col" : "is-row"}${trailing ? " is-trailing" : ""}`}
      role="separator"
      aria-orientation={axis === "column" ? "vertical" : "horizontal"}
      aria-label={`Resize ${axis} ${index + 1}`}
      title={`Drag to resize ${axis}`}
      onPointerDown={(e) => onBegin(e, axis, index)}
      onPointerMove={onMove}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
    />
  );
}

/** One icon in a labelled strip of them. The sentence the icon replaced survives as its tooltip and
 * its accessible name, so the meaning is a hover (or a screen reader) away rather than gone. */
function MenuIcon({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** Set only for the controls that show a current value - alignment. Left undefined elsewhere, so
   * a one-shot command isn't announced as an unpressed toggle. */
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`board-widget-icon ${active ? "is-on" : ""}`}
      onClick={onClick}
    >
      <Icon size={12} />
    </button>
  );
}

/** A full-width command with its name spelled out - kept for deleting a line, where an icon alone
 * would be a destructive edit behind a guess. */
function MenuItem({
  icon: Icon,
  danger,
  disabled,
  onClick,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`board-widget-menu-item ${danger ? "is-danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={12} />
      {children}
    </button>
  );
}
