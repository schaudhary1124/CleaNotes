import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Code2,
  Copy,
  Eraser,
  Grid3x3,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Magnet,
  Maximize,
  Mic,
  MousePointer2,
  PenTool,
  Redo2,
  Table,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SKETCH_COLORS } from "../components/SketchToolbar";
import { ToolbarPopover } from "../components/ToolbarPopover";
import { BoardSelectionOptions, BoardToolOptions, SHAPE_OPTIONS, boardToolHasOptions } from "./BoardToolOptions";
import { BoardTooltipHost, useTip } from "./BoardTooltip";
import {
  settingsFromSelection,
  sharedOptionGroups,
  type BoardOptionGroup,
  type BoardTool,
  type BoardToolActions,
  type BoardToolSettings,
} from "./boardTools";
import type { BoardElement, BoardSurface } from "./boardTypes";

/** Stable empty set for "nothing is selected", so the no-selection render path doesn't allocate one
 * per keystroke of a pan or zoom. */
const EMPTY_GROUPS: ReadonlySet<BoardOptionGroup> = new Set();

const SURFACE_OPTIONS: { id: BoardSurface; label: string; hint: string }[] = [
  { id: "plain", label: "Plain", hint: "Blank canvas, no drawing assists" },
  { id: "graph", label: "Graph paper", hint: "2D grid - straight strokes snap to axes and cells" },
  { id: "isometric", label: "Isometric", hint: "3D triangle grid - strokes snap to the 30° axes" },
];

const POPOVER_CLASS = "glass-panel shadow-app-lg border-subtle overflow-hidden rounded-lg border";

/** The board's tool row, and the options panel that hangs beneath whichever tool is armed.
 *
 * The row itself only *arms* tools and holds what is shared between them (the colour swatches, the
 * board-wide surface/zoom/history controls). Everything specific to one tool - sizes, brush styles,
 * the shape picker, the eraser's mode - lives in the panel below it (BoardToolOptions.tsx), which
 * appears as soon as the tool is selected instead of needing a second click on an already-armed
 * button. The panel floats *over* the canvas rather than taking a row of its own, so switching tools
 * never resizes the board underneath.
 *
 * With the select tool active and something picked, that same panel switches to the *selection's*
 * options, so an element already on the canvas can be restyled in place. Placing anything selects it
 * (see BoardWorkspace's addElement), which means the panel that appears right after an insert is
 * already the new element's own.
 *
 * Controls here carry no text: their labels are instant tooltips instead (see BoardTooltip), which is
 * what keeps a five-group options panel narrower than the window. That is also why this component is
 * a thin wrapper - the tooltip host has to be an *ancestor* of everything calling `useTip`, including
 * the row itself. */
export function BoardToolbar(props: BoardToolbarProps) {
  return (
    <BoardTooltipHost>
      <ToolbarBody {...props} />
    </BoardTooltipHost>
  );
}

interface BoardToolbarProps {
  tool: BoardTool;
  onToolChange: (tool: BoardTool) => void;
  settings: BoardToolSettings;
  actions: BoardToolActions;
  /** The current selection, in board order. Drives the selection half of the options panel, and lets
   * the shared controls (colours, sizes, styles) show what the picked element actually is. */
  selectedElements: readonly BoardElement[];
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
  /** False for a collaborator with viewer access, or while the owner has the note locked. Every
   * control that would change the document is dropped, leaving navigation (select, pan, zoom) and
   * the surface indicator - the same "hide the way in, never hide existing content" rule the
   * feature flags above follow. */
  canEdit: boolean;
}

function ToolbarBody({
  tool,
  onToolChange,
  settings,
  actions,
  selectedElements,
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
  canEdit,
}: BoardToolbarProps) {
  const tip = useTip();
  // Editing a selection, rather than arming a tool: the panel shows what the picked elements *are*,
  // read back out of them, so every control starts from the element's own style.
  const editingSelection = canEdit && tool === "select" && selectedElements.length > 0;
  const shown = editingSelection ? settingsFromSelection(selectedElements, settings) : settings;
  // What the whole selection has in common - an intersection, so no control ever appears that would
  // reach only part of it (see sharedOptionGroups).
  const shared = editingSelection ? sharedOptionGroups(selectedElements) : EMPTY_GROUPS;
  // The colour swatches live in the row, not the panel, so sharing only colour is not a reason to
  // open one.
  const panelGroups = new Set([...shared].filter((group) => group !== "color"));
  // A panel is worth opening when the selection shares something stylable, or when it is all one kind -
  // which is what still gives a lone picture or table its reorder controls. A mix of kinds with nothing
  // in common gets no panel at all, rather than a row of controls that would reach only part of it.
  const oneKind = selectedElements.every((el) => el.kind === selectedElements[0].kind);
  const selectionPanel = editingSelection && (panelGroups.size > 0 || oneKind);
  const activeShape = SHAPE_OPTIONS.find((s) => s.shape === shown.shape) ?? SHAPE_OPTIONS[0];
  const inkTool = tool === "pen" || tool === "highlighter";
  const showColors =
    inkTool ||
    tool === "shape" ||
    tool === "text" ||
    // Recolouring a selection has to reach all of it too: a stroke picked together with a picture
    // gets no swatches, because the picture has no colour to set.
    shared.has("color");
  const optionsOpen = canEdit && (selectionPanel || (!editingSelection && boardToolHasOptions(tool)));

  const toolButton = (id: BoardTool, label: string, Icon: LucideIcon, shortcut?: string) => (
    <button
      key={id}
      type="button"
      // The panel anchors itself to the armed tool's button by this attribute rather than by a ref
      // per tool - one lookup, no ref bookkeeping for eleven buttons that mostly don't have options.
      data-tool={id}
      onClick={() => onToolChange(id)}
      aria-label={label}
      aria-pressed={tool === id}
      className={`btn-ghost h-7 w-7 shrink-0 ${tool === id ? "bg-accent-soft text-accent" : ""}`}
      {...tip(shortcut ? `${label} (${shortcut})` : label)}
    >
      <Icon size={14} />
    </button>
  );

  return (
    <div className="board-toolbar-shell">
      <div className="border-subtle flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
        {toolButton("select", "Select", MousePointer2, "V")}
        {toolButton("hand", "Pan", Hand, "H")}

        {canEdit && <div className="divider mx-1 h-5 w-px shrink-0" />}

        {canEdit && toolButton("pen", "Pen", PenTool, "P")}
        {canEdit && toolButton("highlighter", "Highlighter", Highlighter, "M")}
        {canEdit && toolButton("eraser", "Eraser", Eraser, "E")}

        {canEdit && <div className="divider mx-1 h-5 w-px shrink-0" />}

        {/* Shows the shape it will place, and arms the tool in one click - the picker itself is in
            the options panel, so there is no second "click it again" step any more. */}
        {canEdit && toolButton("shape", activeShape.label, activeShape.icon, "S")}

        {canEdit && toolButton("text", "Text box", Type, "T")}
        {canEdit && toolButton("image", "Image", ImageIcon)}
        {canEdit && codeEnabled && toolButton("code", "Code block", Code2)}
        {canEdit && toolButton("table", "Table", Table)}
        {canEdit && voiceEnabled && toolButton("voice", "Voice note", Mic)}

        {/* Colour stays in the row: four tools share it, and a control that never moves between
            tools is faster to hit than one that re-lays-out per tool. */}
        {canEdit && showColors && (
          <>
            <div className="divider mx-1 h-5 w-px shrink-0" />
            {SKETCH_COLORS.map((c) => (
              <button
                key={c.label}
                type="button"
                aria-label={c.label}
                aria-pressed={shown.color === c.value}
                className={`h-5 w-5 shrink-0 rounded-full border transition-transform duration-100 ${
                  shown.color === c.value ? "border-accent-soft scale-110" : "border-subtle-strong"
                }`}
                style={{ background: c.value }}
                onClick={() => actions.setColor(c.value)}
                // Same reason as the options panel's buttons: recolouring a text box that is being
                // typed into must not steal the caret.
                onMouseDown={(e) => e.preventDefault()}
                {...tip(c.label)}
              />
            ))}
          </>
        )}

        <div className="divider mx-1 h-5 w-px shrink-0" />

        <SurfacePicker surface={surface} onChange={onSurfaceChange} canEdit={canEdit} />

        {canEdit && (
          // The tooltip lives on the wrapper, not the button: a disabled button receives no pointer
          // events, and "why is this off?" is exactly the case where the label matters most.
          <span
            className="flex shrink-0"
            {...tip(surface === "plain" ? "Snapping needs a grid surface" : "Snap to grid")}
          >
            <button
              type="button"
              onClick={onSnapToggle}
              // Snapping has nothing to bite on with a plain surface, so the control reflects that
              // rather than pretending to toggle something inert.
              disabled={surface === "plain"}
              aria-label="Snap to grid"
              aria-pressed={snapEnabled && surface !== "plain"}
              className={`btn-ghost h-7 w-7 shrink-0 disabled:opacity-30 ${
                snapEnabled && surface !== "plain" ? "bg-accent-soft text-accent" : ""
              }`}
            >
              <Magnet size={14} />
            </button>
          </span>
        )}

        <div className="divider mx-1 h-5 w-px shrink-0" />

        <button type="button" onClick={onZoomOut} aria-label="Zoom out" className="btn-ghost h-7 w-7 shrink-0" {...tip("Zoom out (⌘-)")}>
          <ZoomOut size={14} />
        </button>
        <button
          type="button"
          onClick={onZoomReset}
          aria-label="Reset zoom"
          className="btn-ghost text-secondary h-7 shrink-0 px-1.5 text-[11px] tabular-nums"
          {...tip("Reset zoom to 100%")}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" className="btn-ghost h-7 w-7 shrink-0" {...tip("Zoom in (⌘+)")}>
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={onZoomToFit} aria-label="Zoom to fit" className="btn-ghost h-7 w-7 shrink-0" {...tip("Zoom to fit (⇧1)")}>
          <Maximize size={14} />
        </button>

        {canEdit && <div className="divider mx-1 h-5 w-px shrink-0" />}

        {/* Wrapped for the same reason as the snap toggle above - these four spend much of their life
            disabled, and a disabled button never fires the pointer events the tooltip needs. */}
        {canEdit && (
          <span className="flex shrink-0" {...tip("Undo (⌘Z)")}>
            <button type="button" onClick={onUndo} disabled={!canUndo} aria-label="Undo" className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-30">
              <Undo2 size={14} />
            </button>
          </span>
        )}
        {canEdit && (
          <span className="flex shrink-0" {...tip("Redo (⇧⌘Z)")}>
            <button type="button" onClick={onRedo} disabled={!canRedo} aria-label="Redo" className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-30">
              <Redo2 size={14} />
            </button>
          </span>
        )}

        {canEdit && (
          <span className="flex shrink-0" {...tip("Duplicate (⌘D)")}>
            <button type="button" onClick={onDuplicate} disabled={!hasSelection} aria-label="Duplicate" className="btn-ghost h-7 w-7 shrink-0 disabled:opacity-30">
              <Copy size={14} />
            </button>
          </span>
        )}
        {canEdit && (
          <span className="flex shrink-0" {...tip("Delete")}>
            <button type="button" onClick={onDelete} disabled={!hasSelection} aria-label="Delete" className="btn-ghost hover:text-danger h-7 w-7 shrink-0 disabled:opacity-30">
              <Trash2 size={14} />
            </button>
          </span>
        )}
      </div>

      {optionsOpen && (
        // Keyed by which panel this is, so switching between a tool's options and a selection's
        // options replays the drop-in animation instead of morphing one row of controls into another.
        <ToolOptionsPanel key={editingSelection ? "selection" : tool} tool={tool}>
          {editingSelection ? (
            <BoardSelectionOptions
              elements={selectedElements}
              groups={panelGroups}
              settings={shown}
              actions={actions}
            />
          ) : (
            <BoardToolOptions tool={tool} settings={shown} actions={actions} />
          )}
        </ToolOptionsPanel>
      )}
    </div>
  );
}

/** Positions the options panel under the armed tool's button.
 *
 * The panel can't simply be a centred or left-aligned block: the point of the layout is that the
 * options visibly belong to the button above them. So it measures that button and centres itself on
 * it, clamped to stay inside the toolbar - and re-measures when the toolbar row scrolls (it is
 * horizontally scrollable, so the anchor moves without anything else changing) or when either box
 * resizes. Measured in a layout effect so the first paint is already in the right place. */
function ToolOptionsPanel({ tool, children }: { tool: BoardTool; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);

  const place = useCallback(() => {
    const panel = panelRef.current;
    // The panel is the shell's own child, so the shell - the box both the row and this panel are
    // measured against - is simply its parent.
    const shell = panel?.parentElement;
    const anchor = shell?.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
    if (!panel || !shell || !anchor) return;
    const shellBox = shell.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const centre = anchorBox.left - shellBox.left + anchorBox.width / 2;
    setLeft(Math.min(Math.max(8, centre - width / 2), Math.max(8, shellBox.width - width - 8)));
  }, [tool]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    const panel = panelRef.current;
    const shell = panel?.parentElement;
    if (!panel || !shell) return;
    const row = shell.firstElementChild;
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    observer.observe(shell);
    row?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      row?.removeEventListener("scroll", place);
    };
  }, [place]);

  return (
    <div
      ref={panelRef}
      className="board-tool-options"
      // Hidden rather than absent until measured: the panel has to be laid out to be measured at
      // all, and painting it at left: 0 for one frame reads as a jump.
      style={{ left: left ?? 0, visibility: left === null ? "hidden" : "visible" }}
    >
      {children}
    </div>
  );
}

function SurfacePicker({
  surface,
  onChange,
  canEdit,
}: {
  surface: BoardSurface;
  onChange: (s: BoardSurface) => void;
  canEdit: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const tip = useTip();
  const active = SURFACE_OPTIONS.find((s) => s.id === surface) ?? SURFACE_OPTIONS[0];
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => canEdit && setOpen((v) => !v)}
        // The surface is shared document state, not a per-viewer preference, so a viewer sees
        // which paper the board is on but can't change it out from under the owner.
        disabled={!canEdit}
        aria-label="Board surface"
        className="btn-ghost text-secondary flex h-7 shrink-0 items-center gap-1 px-1.5 text-[11px]"
        {...tip(canEdit ? "Board surface" : `Board surface: ${active.label}`)}
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
