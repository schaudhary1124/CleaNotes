import type { BoardCellFill, BoardTextAlign, TableElement } from "./boardTypes";

/** Structural edits to a board table.
 *
 * A TableElement is three parallel structures - `rows` (row-major text), `fills` (row-major cell
 * tints) and `align` (per column) - and every one of them has to stay in step with a row or column
 * that appears, disappears, or moves. Doing that inline at the call sites is how a table ends up
 * with a fill array one column short of its text, so the widget calls nothing but these: each one
 * takes the whole element and returns the `Partial<TableElement>` patch that keeps all three
 * consistent, which is exactly the shape `patchElement` wants.
 *
 * Two invariants hold on the way out of every function here:
 *
 *   - every row has the same length, and `align`/`colWidths` (when present) are exactly that long;
 *   - `fills` is either absent entirely or the same shape as `rows`, and `rowHeights` (when
 *     present) is exactly as long as `rows`. Each is dropped back to absent the moment nothing in
 *     it differs from the default, so the overwhelmingly common untouched table stores nothing for
 *     any of them - and a board written before a field existed stays byte-identical after an edit
 *     that doesn't use it.
 */

/** Sizes a row or column that has never been dragged, in the widget's own px. The column default is
 * a third of the table element's default width, so a new 3x3 table fills the box it is created in
 * exactly; the row default is one line of 12px text plus its padding. */
export const DEFAULT_COL_WIDTH = 120;
export const DEFAULT_ROW_HEIGHT = 28;

/** Floors for a resize drag. Small enough for a checkbox-width column or a tight row, large enough
 * that a line can never be dragged down to something with no grip left to grab it by. */
export const MIN_COL_WIDTH = 32;
export const MIN_ROW_HEIGHT = 18;

export function columnCount(el: TableElement): number {
  return el.rows[0]?.length ?? 0;
}

/** A column's width, tolerating an absent, short, or garbage `colWidths` array. */
export function colWidth(el: TableElement, col: number): number {
  const width = el.colWidths?.[col];
  return typeof width === "number" && Number.isFinite(width)
    ? Math.max(MIN_COL_WIDTH, width)
    : DEFAULT_COL_WIDTH;
}

/** A row's height, on the same terms as colWidth. */
export function rowHeight(el: TableElement, row: number): number {
  const height = el.rowHeights?.[row];
  return typeof height === "number" && Number.isFinite(height)
    ? Math.max(MIN_ROW_HEIGHT, height)
    : DEFAULT_ROW_HEIGHT;
}

/** Total width of the grid itself, grips excluded - what the `<table>` is sized to, and so what
 * decides whether it scrolls horizontally inside the element's box. */
export function gridWidth(el: TableElement): number {
  let total = 0;
  for (let c = 0; c < columnCount(el); c++) total += colWidth(el, c);
  return total;
}

/** A column's alignment, tolerating an absent or short `align` array (see TableElement). */
export function columnAlign(el: TableElement, col: number): BoardTextAlign {
  return el.align?.[col] ?? "left";
}

/** A cell's fill, tolerating an absent or ragged `fills` array (see TableElement). */
export function cellFill(el: TableElement, row: number, col: number): BoardCellFill {
  return el.fills?.[row]?.[col] ?? null;
}

/** `el.fills` as a dense grid the size of `rows`, so a caller can edit one cell without first
 * working out whether the array exists, is short, or is ragged. */
function denseFills(el: TableElement): BoardCellFill[][] {
  return el.rows.map((cells, r) => cells.map((_, c) => cellFill(el, r, c)));
}

/** Normalizes a fill grid back into what gets stored: `undefined` when nothing is filled. Returned
 * as a patch fragment rather than a value so `undefined` genuinely deletes the key. */
function fillsPatch(fills: BoardCellFill[][]): Pick<TableElement, "fills"> {
  return { fills: fills.some((row) => row.some((fill) => fill !== null)) ? fills : undefined };
}

/** `el.align` as a dense array, or undefined if every column is left-aligned (the default), so an
 * untouched table stores no alignment at all. */
function alignPatch(align: BoardTextAlign[]): Pick<TableElement, "align"> {
  return { align: align.some((a) => a !== "left") ? align : undefined };
}

/** The same normalization for the two size arrays: stored only once something in them has actually
 * been dragged away from its default. */
function widthsPatch(widths: number[]): Pick<TableElement, "colWidths"> {
  return { colWidths: widths.some((w) => w !== DEFAULT_COL_WIDTH) ? widths : undefined };
}

function heightsPatch(heights: number[]): Pick<TableElement, "rowHeights"> {
  return { rowHeights: heights.some((h) => h !== DEFAULT_ROW_HEIGHT) ? heights : undefined };
}

export function setCell(el: TableElement, row: number, col: number, value: string): Partial<TableElement> {
  return {
    rows: el.rows.map((cells, r) => (r === row ? cells.map((cell, c) => (c === col ? value : cell)) : cells)),
  };
}

/** Inserts a blank row at `index` (0..rows.length, so `rows.length` appends). */
export function insertRow(el: TableElement, index: number): Partial<TableElement> {
  const cols = columnCount(el);
  const at = clamp(index, el.rows.length);
  const rows = [...el.rows];
  rows.splice(at, 0, Array.from({ length: cols }, () => ""));
  const heights = heightArray(el, el.rows.length);
  heights.splice(at, 0, DEFAULT_ROW_HEIGHT);
  const patch: Partial<TableElement> = { rows, ...heightsPatch(heights) };
  if (!el.fills) return patch;
  const fills = denseFills(el);
  fills.splice(at, 0, Array.from({ length: cols }, () => null));
  return { ...patch, ...fillsPatch(fills) };
}

/** Deletes row `index`. The last remaining row is never deleted - an empty table has no cell to
 * click and no way back short of deleting the element, so the floor is enforced here rather than
 * being left to each call site to remember. */
export function removeRow(el: TableElement, index: number): Partial<TableElement> | null {
  if (el.rows.length <= 1 || index < 0 || index >= el.rows.length) return null;
  const rows = el.rows.filter((_, r) => r !== index);
  const patch: Partial<TableElement> = {
    rows,
    ...heightsPatch(heightArray(el, el.rows.length).filter((_, r) => r !== index)),
  };
  if (!el.fills) return patch;
  return { ...patch, ...fillsPatch(denseFills(el).filter((_, r) => r !== index)) };
}

/** Inserts a blank column at `index` (0..columnCount, so `columnCount` appends). */
export function insertColumn(el: TableElement, index: number): Partial<TableElement> {
  const cols = columnCount(el);
  const at = clamp(index, cols);
  const rows = el.rows.map((cells) => {
    const next = [...cells];
    next.splice(at, 0, "");
    return next;
  });
  const align = alignArray(el, cols);
  align.splice(at, 0, "left");
  const widths = widthArray(el, cols);
  widths.splice(at, 0, DEFAULT_COL_WIDTH);
  const patch: Partial<TableElement> = { rows, ...alignPatch(align), ...widthsPatch(widths) };
  if (!el.fills) return patch;
  const fills = denseFills(el).map((row) => {
    const next = [...row];
    next.splice(at, 0, null);
    return next;
  });
  return { ...patch, ...fillsPatch(fills) };
}

/** Deletes column `index`, subject to the same one-column floor `removeRow` applies to rows. */
export function removeColumn(el: TableElement, index: number): Partial<TableElement> | null {
  const cols = columnCount(el);
  if (cols <= 1 || index < 0 || index >= cols) return null;
  const rows = el.rows.map((cells) => cells.filter((_, c) => c !== index));
  const patch: Partial<TableElement> = {
    rows,
    ...alignPatch(alignArray(el, cols).filter((_, c) => c !== index)),
    ...widthsPatch(widthArray(el, cols).filter((_, c) => c !== index)),
  };
  if (!el.fills) return patch;
  return { ...patch, ...fillsPatch(denseFills(el).map((row) => row.filter((_, c) => c !== index))) };
}

export function setColumnAlign(el: TableElement, col: number, align: BoardTextAlign): Partial<TableElement> {
  const next = alignArray(el, columnCount(el));
  if (col < 0 || col >= next.length) return {};
  next[col] = align;
  return alignPatch(next);
}

/** Sets one column's width, clamped to MIN_COL_WIDTH. Takes the raw dragged value (fractional, and
 * possibly negative once the pointer crosses the column's own left edge) and does the rounding
 * here, so a drag handler is nothing but "start plus travel". */
export function setColWidth(el: TableElement, col: number, width: number): Partial<TableElement> {
  const widths = widthArray(el, columnCount(el));
  if (col < 0 || col >= widths.length || !Number.isFinite(width)) return {};
  widths[col] = Math.max(MIN_COL_WIDTH, Math.round(width));
  return widthsPatch(widths);
}

/** Sets one row's height, on the same terms as setColWidth. */
export function setRowHeight(el: TableElement, row: number, height: number): Partial<TableElement> {
  const heights = heightArray(el, el.rows.length);
  if (row < 0 || row >= heights.length || !Number.isFinite(height)) return {};
  heights[row] = Math.max(MIN_ROW_HEIGHT, Math.round(height));
  return heightsPatch(heights);
}

export function setCellFill(el: TableElement, row: number, col: number, fill: BoardCellFill): Partial<TableElement> {
  const fills = denseFills(el);
  if (!fills[row] || col < 0 || col >= fills[row].length) return {};
  fills[row][col] = fill;
  return fillsPatch(fills);
}

/** Fills (or clears) every cell in one row or column at once - the "colour this header" gesture,
 * which is otherwise a cell-by-cell chore. */
export function setLineFill(
  el: TableElement,
  line: { kind: "row" | "column"; index: number },
  fill: BoardCellFill,
): Partial<TableElement> {
  const fills = denseFills(el);
  if (line.kind === "row") {
    if (!fills[line.index]) return {};
    fills[line.index] = fills[line.index].map(() => fill);
  } else {
    for (const row of fills) {
      if (line.index < 0 || line.index >= row.length) return {};
      row[line.index] = fill;
    }
  }
  return fillsPatch(fills);
}

/** Clears every cell's text, keeping the table's shape, fills and alignment - the fastest way back
 * to a blank grid of the size already laid out. */
export function clearCells(el: TableElement): Partial<TableElement> {
  return { rows: el.rows.map((cells) => cells.map(() => "")) };
}

function alignArray(el: TableElement, cols: number): BoardTextAlign[] {
  return Array.from({ length: cols }, (_, c) => columnAlign(el, c));
}

function widthArray(el: TableElement, cols: number): number[] {
  return Array.from({ length: cols }, (_, c) => colWidth(el, c));
}

function heightArray(el: TableElement, rows: number): number[] {
  return Array.from({ length: rows }, (_, r) => rowHeight(el, r));
}

function clamp(index: number, max: number): number {
  return Math.min(max, Math.max(0, index));
}
