import { useState, useRef } from "react";
import { Table2, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash2 } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import type { BlockAlign } from "../milkdown/alignmentSchemaExtensions";

/** Extracted out of Editor.tsx so the browser-guest build's own toolbar (see
 * src/browser-guest/BrowserToolbar.tsx) can reuse it without pulling in the rest of that
 * file - pure presentational component, moved verbatim, no logic changes. */

/** Also used by Editor.tsx's own `alignGroup` toolbar buttons - kept here since TableMenu
 * needs it internally for the column-align picker, and there's only ever one copy either way. */
export const ALIGN_OPTIONS: { align: BlockAlign; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { align: "left", label: "Align left", icon: TextAlignStart },
  { align: "center", label: "Align center", icon: TextAlignCenter },
  { align: "right", label: "Align right", icon: TextAlignEnd },
];

const CELL_COLORS: { label: string; value: string }[] = [
  { label: "Red", value: "rgba(248, 113, 113, 0.35)" },
  { label: "Orange", value: "rgba(251, 146, 60, 0.35)" },
  { label: "Yellow", value: "rgba(250, 204, 21, 0.35)" },
  { label: "Green", value: "rgba(74, 222, 128, 0.3)" },
  { label: "Blue", value: "rgba(96, 165, 250, 0.3)" },
  { label: "Purple", value: "rgba(192, 132, 252, 0.3)" },
  { label: "Gray", value: "rgba(148, 163, 184, 0.3)" },
];

export function TableMenu({
  inTable,
  cellAlign,
  onInsert,
  onAddRow,
  onAddColumn,
  onDeleteRow,
  onDeleteColumn,
  onDeleteTable,
  onSetCellColor,
  onSetCellAlign,
}: {
  inTable: boolean;
  cellAlign: BlockAlign;
  onInsert: (row: number, col: number) => void;
  onAddRow: () => void;
  onAddColumn: () => void;
  onDeleteRow: () => void;
  onDeleteColumn: () => void;
  onDeleteTable: () => void;
  onSetCellColor: (color: string | null) => void;
  onSetCellAlign: (align: BlockAlign) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ row: 3, col: 3 });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const GRID = 6;

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Table"
        aria-label="Table"
        aria-expanded={open}
        aria-pressed={inTable}
        className={`btn-ghost h-7 w-7 shrink-0 ${inTable ? "bg-accent-soft text-accent" : ""}`}
      >
        <Table2 size={14} />
      </button>
      {open && !inTable && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle rounded-lg border p-2.5"
        >
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${GRID}, 16px)` }}
            onMouseLeave={() => setHover({ row: 3, col: 3 })}
          >
            {Array.from({ length: GRID * GRID }).map((_, i) => {
              const row = Math.floor(i / GRID) + 1;
              const col = (i % GRID) + 1;
              const active = row <= hover.row && col <= hover.col;
              return (
                <button
                  key={i}
                  type="button"
                  onMouseEnter={() => setHover({ row, col })}
                  onClick={() => {
                    onInsert(row, col);
                    setOpen(false);
                  }}
                  className={`h-4 w-4 rounded-sm border ${
                    active ? "bg-accent-solid border-accent-soft" : "border-subtle-strong"
                  }`}
                />
              );
            })}
          </div>
          <div className="text-tertiary mt-1.5 text-center text-xs">
            {hover.row} × {hover.col}
          </div>
        </ToolbarPopover>
      )}
      {open && inTable && (
        <ToolbarPopover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="glass-panel shadow-app-lg border-subtle w-44 overflow-hidden rounded-lg border py-1 text-sm"
        >
          <button
            type="button"
            className="hover:bg-surface-hover text-primary w-full px-3 py-1.5 text-left"
            onClick={() => {
              onAddRow();
              setOpen(false);
            }}
          >
            Insert row below
          </button>
          <button
            type="button"
            className="hover:bg-surface-hover text-primary w-full px-3 py-1.5 text-left"
            onClick={() => {
              onAddColumn();
              setOpen(false);
            }}
          >
            Insert column right
          </button>
          <button
            type="button"
            className="hover:bg-surface-hover text-primary w-full px-3 py-1.5 text-left"
            onClick={() => {
              onDeleteRow();
              setOpen(false);
            }}
          >
            Delete row
          </button>
          <button
            type="button"
            className="hover:bg-surface-hover text-primary w-full px-3 py-1.5 text-left"
            onClick={() => {
              onDeleteColumn();
              setOpen(false);
            }}
          >
            Delete column
          </button>
          <div className="border-subtle my-1 border-t" />
          <div className="text-tertiary px-3 pb-1 pt-0.5 text-xs">Column align</div>
          <div className="flex items-center gap-1 px-3 pb-1.5">
            {ALIGN_OPTIONS.map(({ align, label, icon: Icon }) => (
              <button
                key={align}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={cellAlign === align}
                className={`btn-ghost h-6 w-6 shrink-0 ${cellAlign === align ? "bg-accent-soft text-accent" : ""}`}
                onClick={() => onSetCellAlign(align)}
              >
                <Icon size={13} />
              </button>
            ))}
          </div>
          <div className="border-subtle my-1 border-t" />
          <div className="text-tertiary px-3 pb-1 pt-0.5 text-xs">Fill color</div>
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            {CELL_COLORS.map((color) => (
              <button
                key={color.label}
                type="button"
                title={color.label}
                aria-label={color.label}
                className="border-subtle-strong h-5 w-5 shrink-0 rounded-full border"
                style={{ background: color.value }}
                onClick={() => {
                  onSetCellColor(color.value);
                  setOpen(false);
                }}
              />
            ))}
            <button
              type="button"
              title="Clear color"
              aria-label="Clear color"
              className="border-subtle-strong text-tertiary hover:text-primary flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs"
              onClick={() => {
                onSetCellColor(null);
                setOpen(false);
              }}
            >
              ×
            </button>
          </div>
          <div className="border-subtle my-1 border-t" />
          <button
            type="button"
            className="hover:bg-danger-soft text-danger flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
            onClick={() => {
              onDeleteTable();
              setOpen(false);
            }}
          >
            <Trash2 size={13} />
            Delete table
          </button>
        </ToolbarPopover>
      )}
    </div>
  );
}
