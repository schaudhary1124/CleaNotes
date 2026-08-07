import { useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Code2,
  Copy,
  Diamond,
  Eraser,
  Grid3x3,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Magnet,
  Maximize,
  Mic,
  Minus,
  MousePointer2,
  PenTool,
  Redo2,
  Square,
  Table,
  Trash2,
  Triangle,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SKETCH_COLORS } from "../components/SketchToolbar";
import { ToolbarPopover } from "../components/ToolbarPopover";
import type { BoardShapeKind, BoardSurface } from "./boardTypes";

/** Every mode the board's pointer can be in. "select" and "hand" manipulate what's already there;
 * the rest place something new. Placement tools revert to "select" once used (see
 * WhiteboardView's `finishPlacement`), matching how Miro/Figma behave - a tool that stays armed
 * after use is the top source of accidental duplicate elements. Ink tools are the exception:
 * drawing is inherently repetitive, so pen/highlighter/eraser stay selected. */
export type BoardTool =
  | "select"
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | "shape"
  | "text"
  | "image"
  | "code"
  | "table"
  | "voice";

export const SHAPE_OPTIONS: { shape: BoardShapeKind; label: string; icon: LucideIcon }[] = [
  { shape: "rect", label: "Rectangle", icon: Square },
  { shape: "ellipse", label: "Ellipse", icon: Circle },
  { shape: "diamond", label: "Diamond", icon: Diamond },
  { shape: "triangle", label: "Triangle", icon: Triangle },
  { shape: "line", label: "Line", icon: Minus },
  { shape: "arrow", label: "Arrow", icon: ArrowUpRight },
];

const SURFACE_OPTIONS: { id: BoardSurface; label: string; hint: string }[] = [
  { id: "plain", label: "Plain", hint: "Blank canvas, no drawing assists" },
  { id: "graph", label: "Graph paper", hint: "2D grid - straight strokes snap to axes and cells" },
  { id: "isometric", label: "Isometric", hint: "3D triangle grid - strokes snap to the 30° axes" },
];

/** Stroke/shape widths in world px, mirroring SketchToolbar's three-preset model so the two
 * drawing surfaces in the app feel the same. */
export const BOARD_WIDTHS = [2, 4, 8];

const POPOVER_CLASS = "glass-panel shadow-app-lg border-subtle overflow-hidden rounded-lg border";

export function BoardToolbar({
  tool,
  onToolChange,
  shape,
  onShapeChange,
  color,
  onColorChange,
  widthIndex,
  onWidthIndexChange,
  surface,
  onSurfaceChange,
  snapEnabled,
  onSnapToggle,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onZoomToFit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasSelection,
  onDuplicate,
  onDelete,
  voiceEnabled,
  codeEnabled,
}: {
  tool: BoardTool;
  onToolChange: (tool: BoardTool) => void;
  shape: BoardShapeKind;
  onShapeChange: (shape: BoardShapeKind) => void;
  color: string;
  onColorChange: (color: string) => void;
  widthIndex: number;
  onWidthIndexChange: (index: number) => void;
  surface: BoardSurface;
  onSurfaceChange: (surface: BoardSurface) => void;
  snapEnabled: boolean;
  onSnapToggle: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomToFit: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasSelection: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Mirror the app-level feature flags (see FeatureFlags) - a disabled feature hides its way in
   * here exactly like it does in the note toolbar, without touching content already on a board. */
  voiceEnabled: boolean;
  codeEnabled: boolean;
}) {
  const shapeAnchorRef = useRef<HTMLButtonElement>(null);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const activeShape = SHAPE_OPTIONS.find((s) => s.shape === shape) ?? SHAPE_OPTIONS[0];
  const inkTool = tool === "pen" || tool === "highlighter";
  const showColors = inkTool || tool === "shape" || tool === "text";

  const toolButton = (id: BoardTool, label: string, Icon: LucideIcon, shortcut?: string) => (
    <button
      key={id}
      type="button"
      onClick={() => onToolChange(id)}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={tool === id}
      className={`btn-ghost h-7 w-7 shrink-0 ${tool === id ? "bg-accent-soft text-accent" : ""}`}
    >
      <Icon size={14} />
    </button>
  );

  return (
    <div className="border-subtle flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
      {toolButton("select", "Select", MousePointer2, "V")}
      {toolButton("hand", "Pan", Hand, "H")}

      <div className="divider mx-1 h-5 w-px shrink-0" />

      {toolButton("pen", "Pen", PenTool, "P")}
      {toolButton("highlighter", "Highlighter", Highlighter, "M")}
      {toolButton("eraser", "Eraser", Eraser, "E")}

      <div className="divider mx-1 h-5 w-px shrink-0" />

      <button
        ref={shapeAnchorRef}
        type="button"
        title={`${activeShape.label} (S)`}
        aria-label="Shape"
        aria-pressed={tool === "shape"}
        onClick={() => {
          // Clicking arms the shape tool; clicking again while already armed opens the picker, so
          // the common case (place another of the same shape) stays a single click.
          if (tool === "shape") setShapeMenuOpen((open) => !open);
          else onToolChange("shape");
        }}
        className={`btn-ghost h-7 w-7 shrink-0 ${tool === "shape" ? "bg-accent-soft text-accent" : ""}`}
      >
        <activeShape.icon size={14} />
      </button>
      {shapeMenuOpen && (
        <ToolbarPopover
          anchorRef={shapeAnchorRef}
          onClose={() => setShapeMenuOpen(false)}
          className={`${POPOVER_CLASS} flex gap-1 p-1`}
        >
          {SHAPE_OPTIONS.map(({ shape: s, label, icon: Icon }) => (
            <button
              key={s}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={shape === s}
              onClick={() => {
                onShapeChange(s);
                onToolChange("shape");
                setShapeMenuOpen(false);
              }}
              className={`btn-ghost h-7 w-7 ${shape === s ? "bg-accent-soft text-accent" : ""}`}
            >
              <Icon size={14} />
            </button>
          ))}
        </ToolbarPopover>
      )}

      {toolButton("text", "Text box", Type, "T")}
      {toolButton("image", "Image", ImageIcon)}
      {codeEnabled && toolButton("code", "Code block", Code2)}
      {toolButton("table", "Table", Table)}
      {voiceEnabled && toolButton("voice", "Voice note", Mic)}

      {showColors && (
        <>
          <div className="divider mx-1 h-5 w-px shrink-0" />
          {SKETCH_COLORS.map((c) => (
            <button
              key={c.label}
              type="button"
              title={c.label}
              aria-label={c.label}
              aria-pressed={color === c.value}
              className={`h-5 w-5 shrink-0 rounded-full border transition-transform duration-100 ${
                color === c.value ? "border-accent-soft scale-110" : "border-subtle-strong"
              }`}
              style={{ background: c.value }}
              onClick={() => onColorChange(c.value)}
            />
          ))}
        </>
      )}

      {(inkTool || tool === "shape") && (
        <>
          <div className="divider mx-1 h-5 w-px shrink-0" />
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              type="button"
              title={["Thin", "Medium", "Thick"][i]}
              aria-label={["Thin", "Medium", "Thick"][i]}
              aria-pressed={widthIndex === i}
              onClick={() => onWidthIndexChange(i)}
              className={`btn-ghost flex h-7 w-7 shrink-0 items-center justify-center ${
                widthIndex === i ? "bg-accent-soft text-accent" : ""
              }`}
            >
              <span className="rounded-full bg-current" style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
            </button>
          ))}
        </>
      )}

      <div className="divider mx-1 h-5 w-px shrink-0" />

      <SurfacePicker surface={surface} onChange={onSurfaceChange} />

      <button
        type="button"
        onClick={onSnapToggle}
        // Snapping has nothing to bite on with a plain surface, so the control reflects that
        // rather than pretending to toggle something inert.
        disabled={surface === "plain"}
        title={surface === "plain" ? "Snapping needs a grid surface" : "Snap to grid"}
        aria-label="Snap to grid"
        aria-pressed={snapEnabled && surface !== "plain"}
        className={`btn-ghost h-7 w-7 shrink-0 disabled:opacity-30 ${
          snapEnabled && surface !== "plain" ? "bg-accent-soft text-accent" : ""
        }`}
      >
        <Magnet size={14} />
      </button>

      <div className="divider mx-1 h-5 w-px shrink-0" />

      <button type="button" onClick={onZoomOut} title="Zoom out (⌘-)" aria-label="Zoom out" className="btn-ghost h-7 w-7 shrink-0">
        <ZoomOut size={14} />
      </button>
      <button
        type="button"
        onClick={onZoomReset}
        title="Reset zoom to 100%"
        aria-label="Reset zoom"
        className="btn-ghost text-secondary h-7 shrink-0 px-1.5 text-[11px] tabular-nums"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={onZoomIn} title="Zoom in (⌘+)" aria-label="Zoom in" className="btn-ghost h-7 w-7 shrink-0">
        <ZoomIn size={14} />
      </button>
      <button type="button" onClick={onZoomToFit} title="Zoom to fit (⇧1)" aria-label="Zoom to fit" className="btn-ghost h-7 w-7 shrink-0">
        <Maximize size={14} />
      </button>

      <div className="divider mx-1 h-5 w-px shrink-0" />

      <button type="button" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo" className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-30">
        <Undo2 size={14} />
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo" className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-30">
        <Redo2 size={14} />
      </button>

      <div className="divider mx-1 h-5 w-px shrink-0" />

      <button type="button" onClick={onDuplicate} disabled={!hasSelection} title="Duplicate (⌘D)" aria-label="Duplicate" className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-30">
        <Copy size={14} />
      </button>
      <button type="button" onClick={onDelete} disabled={!hasSelection} title="Delete" aria-label="Delete" className="btn-ghost hover:text-danger h-7 w-7 shrink-0 disabled:opacity-30">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function SurfacePicker({ surface, onChange }: { surface: BoardSurface; onChange: (s: BoardSurface) => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const active = SURFACE_OPTIONS.find((s) => s.id === surface) ?? SURFACE_OPTIONS[0];
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Board surface"
        aria-label="Board surface"
        className="btn-ghost text-secondary flex h-7 shrink-0 items-center gap-1 px-1.5 text-[11px]"
      >
        <Grid3x3 size={14} />
        {active.label}
      </button>
      {open && (
        <ToolbarPopover anchorRef={anchorRef} onClose={() => setOpen(false)} className={`${POPOVER_CLASS} w-60 p-1`}>
          {SURFACE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
              className={`menu-item block w-full rounded-lg px-2 py-1.5 text-left text-xs ${
                option.id === surface ? "bg-accent-soft text-accent" : ""
              }`}
            >
              <span className="block font-medium">{option.label}</span>
              <span className="text-secondary block text-[10px] leading-tight">{option.hint}</span>
            </button>
          ))}
        </ToolbarPopover>
      )}
    </>
  );
}
