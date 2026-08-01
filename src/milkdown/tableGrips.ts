import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { PluginView } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { isInlineOnlyChange } from "./docChangeScope";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
} from "@milkdown/kit/prose/tables";

const MIN_ROW_HEIGHT = 28;
const BAR_THICKNESS = 14;
const BAR_GAP = 3;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

type MenuItem = { label: string; danger?: boolean; onClick: () => void };

let closeActiveMenu: (() => void) | null = null;

/** Small vanilla-DOM dropdown, portaled to `document.body` the same way
 * Editor.tsx's React `ToolbarPopover` escapes the toolbar's scroll clipping -
 * this file has no React tree to render into, so it's hand-rolled. */
function openGripMenu(anchor: HTMLElement, items: MenuItem[]) {
  closeActiveMenu?.();

  const menu = el("div", "table-grip-menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;

  function close() {
    menu.remove();
    document.removeEventListener("mousedown", onOutside);
    if (closeActiveMenu === close) closeActiveMenu = null;
  }

  function onOutside(e: MouseEvent) {
    const target = e.target as Node;
    if (menu.contains(target) || anchor.contains(target)) return;
    close();
  }

  items.forEach((item) => {
    const btn = el("button", item.danger ? "table-grip-menu-item danger" : "table-grip-menu-item");
    btn.type = "button";
    btn.textContent = item.label;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      close();
      item.onClick();
    });
    menu.append(btn);
  });

  document.body.append(menu);
  closeActiveMenu = close;
  setTimeout(() => document.addEventListener("mousedown", onOutside), 0);
}

function resolveCellPos(view: EditorView, cellDom: Element): number | null {
  try {
    return view.posAtDOM(cellDom, 0);
  } catch {
    return null;
  }
}

/** Walks up from a position inside a row's first cell to find the row node
 * itself - needed both to target row insert/delete and to write a resized
 * `height` attr back onto the right node. */
function resolveRowInfo(view: EditorView, trDom: HTMLTableRowElement) {
  const cellDom = trDom.cells[0];
  if (!cellDom) return null;
  const cellPos = resolveCellPos(view, cellDom);
  if (cellPos == null) return null;
  const $pos = view.state.doc.resolve(cellPos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "table_row" || node.type.name === "table_header_row") {
      return { rowPos: $pos.before(depth), rowNode: node, cellPos };
    }
  }
  return null;
}

function selectCell(view: EditorView, cellPos: number) {
  const $pos = view.state.doc.resolve(cellPos);
  view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
}

function runRowCommand(view: EditorView, trDom: HTMLTableRowElement, action: "before" | "after" | "delete") {
  const info = resolveRowInfo(view, trDom);
  if (!info) return;
  selectCell(view, info.cellPos);
  if (action === "before") addRowBefore(view.state, view.dispatch);
  else if (action === "after") addRowAfter(view.state, view.dispatch);
  else deleteRow(view.state, view.dispatch);
  view.focus();
}

function runColumnCommand(view: EditorView, cellDom: HTMLTableCellElement, action: "before" | "after" | "delete") {
  const pos = resolveCellPos(view, cellDom);
  if (pos == null) return;
  selectCell(view, pos);
  if (action === "before") addColumnBefore(view.state, view.dispatch);
  else if (action === "after") addColumnAfter(view.state, view.dispatch);
  else deleteColumn(view.state, view.dispatch);
  view.focus();
}

/** Dragging used to preview the resize by writing `trDom.style.height`
 * directly - but that's a DOM mutation ProseMirror didn't make itself, and
 * its DOM observer "corrects" unexpected mutations by redrawing the row
 * from the current document state, which detaches `trDom`/its cells out
 * from under the drag before `mouseup` ever fires. A separate ghost line
 * (not part of the table at all) avoids fighting the observer entirely -
 * the real height is only ever written once, via a single dispatch. */
function attachRowResize(handleDom: HTMLElement, trDom: HTMLTableRowElement, getView: () => EditorView) {
  handleDom.addEventListener("mousedown", (downEvent) => {
    downEvent.preventDefault();
    const view = getView();
    const info = resolveRowInfo(view, trDom);
    if (!info) return;
    const { rowPos, rowNode } = info;

    const startY = downEvent.clientY;
    const rowRect = trDom.getBoundingClientRect();
    const startHeight = rowRect.height;

    const ghost = el("div", "table-row-resize-ghost");
    ghost.style.left = `${rowRect.left}px`;
    ghost.style.width = `${rowRect.width}px`;
    document.body.append(ghost);

    function nextHeight(clientY: number) {
      return Math.max(MIN_ROW_HEIGHT, Math.round(startHeight + (clientY - startY)));
    }

    function placeGhost(clientY: number) {
      ghost.style.top = `${rowRect.top + nextHeight(clientY)}px`;
    }
    placeGhost(startY);

    function onMove(moveEvent: MouseEvent) {
      placeGhost(moveEvent.clientY);
    }

    function onUp(upEvent: MouseEvent) {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      ghost.remove();
      const latestView = getView();
      latestView.dispatch(
        latestView.state.tr.setNodeMarkup(rowPos, undefined, {
          ...rowNode.attrs,
          height: nextHeight(upEvent.clientY),
        }),
      );
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

/** Per-table overlay: a thin bar above the table (one segment per column)
 * and one to its left (one segment per row), each segment revealing a grip
 * handle on hover that opens an insert/delete menu targeted at that exact
 * row/column - independent of where the cursor currently is. Positioned
 * absolutely inside the Milkdown mount div (a sibling of `editorView.dom`,
 * never a child of it - ProseMirror owns and diffs `editorView.dom`'s
 * children against the document, so hand-inserted UI has to live outside
 * that subtree). */
class TableOverlay {
  private colBar = el("div", "table-grip-bar table-grip-col-bar");
  private rowBar = el("div", "table-grip-bar table-grip-row-bar");
  private addColBtn = el("button", "table-grip-add-btn table-grip-add-col");
  private addRowBtn = el("button", "table-grip-add-btn table-grip-add-row");
  private rowsCount = -1;
  private colsCount = -1;

  constructor(
    private table: HTMLTableElement,
    private host: HTMLElement,
    private getView: () => EditorView,
  ) {
    this.addColBtn.type = "button";
    this.addColBtn.title = "Add column";
    this.addColBtn.textContent = "+";
    this.addColBtn.addEventListener("mousedown", (e) => e.preventDefault());

    this.addRowBtn.type = "button";
    this.addRowBtn.title = "Add row";
    this.addRowBtn.textContent = "+";
    this.addRowBtn.addEventListener("mousedown", (e) => e.preventDefault());

    this.host.append(this.colBar, this.rowBar, this.addColBtn, this.addRowBtn);
  }

  destroy() {
    this.colBar.remove();
    this.rowBar.remove();
    this.addColBtn.remove();
    this.addRowBtn.remove();
  }

  reposition() {
    const rows = Array.from(this.table.rows);
    const cols = rows[0]?.cells.length ?? 0;
    if (rows.length !== this.rowsCount || cols !== this.colsCount) {
      this.rowsCount = rows.length;
      this.colsCount = cols;
      this.rebuild(rows, cols);
    }
    this.positionBars(rows);
  }

  private positionBars(rows: HTMLTableRowElement[]) {
    const hostRect = this.host.getBoundingClientRect();
    const tableRect = this.table.getBoundingClientRect();
    // The table's own wrapper (.tableWrapper, added by columnResizingPlugin)
    // scrolls horizontally once column widths exceed the space available -
    // the column bar has to clip to that same visible width, or its
    // segments end up floating past whatever's actually scrolled off. The
    // row bar and the add buttons sit outside the wrapper (above/left/right
    // of it) so they aren't subject to its clipping the same way.
    const wrapperRect = (this.table.parentElement ?? this.table).getBoundingClientRect();
    const top = tableRect.top - hostRect.top;
    const left = tableRect.left - hostRect.left;
    const wrapperLeft = wrapperRect.left - hostRect.left;

    this.colBar.style.top = `${top - BAR_THICKNESS - BAR_GAP}px`;
    this.colBar.style.left = `${wrapperLeft}px`;
    this.colBar.style.width = `${wrapperRect.width}px`;
    this.colBar.style.height = `${BAR_THICKNESS}px`;

    this.rowBar.style.top = `${top}px`;
    this.rowBar.style.left = `${left - BAR_THICKNESS - BAR_GAP}px`;
    this.rowBar.style.width = `${BAR_THICKNESS}px`;
    this.rowBar.style.height = `${tableRect.height}px`;

    // Anchored to the table's true (unclipped) edges - reachable by
    // scrolling the table's own wrapper into view, same as any other
    // off-screen part of an overflowing table.
    this.addColBtn.style.top = `${top - BAR_THICKNESS - BAR_GAP}px`;
    this.addColBtn.style.left = `${left + tableRect.width + 4}px`;

    this.addRowBtn.style.left = `${left - BAR_THICKNESS - BAR_GAP}px`;
    this.addRowBtn.style.top = `${top + tableRect.height + 4}px`;

    const headerRow = rows[0];
    if (headerRow) {
      Array.from(this.colBar.children).forEach((segment, i) => {
        const cell = headerRow.cells[i];
        if (!(segment instanceof HTMLElement) || !cell) return;
        const cellRect = cell.getBoundingClientRect();
        segment.style.left = `${cellRect.left - wrapperRect.left}px`;
        segment.style.width = `${cellRect.width}px`;
      });
    }
    Array.from(this.rowBar.children).forEach((segment, i) => {
      const row = rows[i];
      if (!(segment instanceof HTMLElement) || !row) return;
      const rowRect = row.getBoundingClientRect();
      segment.style.top = `${rowRect.top - tableRect.top}px`;
      segment.style.height = `${rowRect.height}px`;
    });
  }

  private rebuild(rows: HTMLTableRowElement[], cols: number) {
    this.colBar.replaceChildren();
    this.rowBar.replaceChildren();

    for (let c = 0; c < cols; c++) {
      const segment = el("div", "table-grip-segment table-grip-col-segment");
      const handle = el("div", "table-grip-handle");
      handle.title = "Column options";
      handle.textContent = "⋮";
      handle.addEventListener("mousedown", (e) => e.preventDefault());
      handle.addEventListener("click", () => {
        const view = this.getView();
        const headerCell = rows[0]?.cells[c];
        if (!headerCell) return;
        openGripMenu(handle, [
          { label: "Insert column left", onClick: () => runColumnCommand(view, headerCell, "before") },
          { label: "Insert column right", onClick: () => runColumnCommand(view, headerCell, "after") },
          { label: "Delete column", danger: true, onClick: () => runColumnCommand(view, headerCell, "delete") },
        ]);
      });
      segment.append(handle);
      this.colBar.append(segment);
    }
    this.addColBtn.onclick = () => {
      const lastCell = rows[0]?.cells[cols - 1];
      if (lastCell) runColumnCommand(this.getView(), lastCell, "after");
    };

    rows.forEach((row) => {
      const segment = el("div", "table-grip-segment table-grip-row-segment");
      const handle = el("div", "table-grip-handle");
      handle.title = "Row options";
      handle.textContent = "⋮";
      handle.addEventListener("mousedown", (e) => e.preventDefault());
      handle.addEventListener("click", () => {
        const view = this.getView();
        openGripMenu(handle, [
          { label: "Insert row above", onClick: () => runRowCommand(view, row, "before") },
          { label: "Insert row below", onClick: () => runRowCommand(view, row, "after") },
          { label: "Delete row", danger: true, onClick: () => runRowCommand(view, row, "delete") },
        ]);
      });
      const resizeHandle = el("div", "table-row-resize-handle");
      attachRowResize(resizeHandle, row, this.getView);
      segment.append(handle, resizeHandle);
      this.rowBar.append(segment);
    });
    this.addRowBtn.onclick = () => {
      const lastRow = rows[rows.length - 1];
      if (lastRow) runRowCommand(this.getView(), lastRow, "after");
    };
  }
}

class TableGripsView implements PluginView {
  private view: EditorView;
  private host: HTMLElement | null = null;
  private overlays = new Map<HTMLTableElement, TableOverlay>();
  // A live window-resize drag can report several ResizeObserver rounds faster than the display
  // refreshes - same reasoning as voiceNoteGrips.ts's onWindowResize - so this coalesces to one
  // repositionAll() pass per animation frame instead of one per observed table per round.
  private resizeRaf: number | null = null;
  private resizeObserver = new ResizeObserver(() => {
    if (this.resizeRaf !== null) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = null;
      this.repositionAll();
    });
  });

  constructor(view: EditorView) {
    this.view = view;
    this.sync();
  }

  update(view: EditorView, prevState: EditorView["state"]) {
    this.view = view;
    // See voiceNoteGrips.ts's identical gate: `doc !== prevState.doc` is true on every
    // keystroke, but sync() re-queries the whole rendered DOM for tables - isInlineOnlyChange
    // skips that unless a table could actually have been added/removed/resized.
    if (view.state.doc !== prevState.doc && !isInlineOnlyChange(prevState.doc, view.state.doc)) {
      this.sync();
    } else {
      this.repositionAll();
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
    if (this.resizeRaf !== null) cancelAnimationFrame(this.resizeRaf);
    this.overlays.forEach((overlay) => overlay.destroy());
    this.overlays.clear();
    closeActiveMenu?.();
  }

  private sync() {
    const host = this.view.dom.parentElement;
    if (!host) return;
    if (host !== this.host) {
      this.host = host;
      if (!host.style.position) host.style.position = "relative";
    }

    const current = new Set(Array.from(this.view.dom.querySelectorAll("table")) as HTMLTableElement[]);
    for (const [table, overlay] of this.overlays) {
      if (!current.has(table)) {
        overlay.destroy();
        this.resizeObserver.unobserve(table);
        this.overlays.delete(table);
      }
    }
    current.forEach((table) => {
      if (this.overlays.has(table)) return;
      const overlay = new TableOverlay(table, host, () => this.view);
      this.overlays.set(table, overlay);
      this.resizeObserver.observe(table);
    });

    this.repositionAll();
  }

  private repositionAll() {
    this.overlays.forEach((overlay) => overlay.reposition());
  }
}

export const tableGrips = $prose(() => new Plugin({ view: (view) => new TableGripsView(view) }));
