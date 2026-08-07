import { DEFAULT_SKETCH_COLOR } from "../components/SketchToolbar";
import { withAlpha } from "./boardTypes";
import type {
  BoardElement,
  BoardElementKind,
  BoardFontFamily,
  BoardShapeKind,
  BoardStrokeStyle,
  BoardTextAlign,
  InkElement,
  ShapeElement,
  TextElement,
} from "./boardTypes";

/** Which mode the board's pointer is in, and every option that mode exposes.
 *
 * Split out of BoardToolbar.tsx because three parties need this vocabulary: the workspace (which
 * holds the state and applies it to what gets drawn), the toolbar row (which arms tools), and the
 * options panel that drops out beneath the armed tool (BoardToolOptions.tsx). Keeping it in the
 * toolbar component would make the panel import the toolbar and the toolbar import the panel. */

/** Every mode the board's pointer can be in. "select" and "hand" manipulate what's already there;
 * the rest place something new. Placement tools revert to "select" once used (see BoardWorkspace's
 * `addElement`), matching how Miro/Figma behave - a tool that stays armed after use is the top
 * source of accidental duplicate elements. Ink tools are the exception: drawing is inherently
 * repetitive, so pen/highlighter/eraser stay selected. */
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

/** The tools with a size setting. Each keeps its *own* preset index: a highlighter's "medium" and a
 * pen's "medium" are different widths, and sharing one index (as the toolbar did originally) meant
 * fattening the pen every time you wanted a broader highlighter. */
export type BoardSizedTool = "pen" | "highlighter" | "eraser" | "shape";

/** Size presets per tool, in world px - stroke width for the drawing tools and the shape outline,
 * nib *diameter* for the eraser (which is the number the user sees as a circle on screen; the
 * region math halves it, see EraserRegion).
 *
 * Three presets each, mirroring SketchToolbar's SKETCH_TOOL_SIZES, so the two drawing surfaces in
 * the app feel the same. The per-tool ranges reproduce the multipliers the ink layer used to apply
 * to a single shared width (highlighter ~4x a pen, eraser broader still). */
export const BOARD_TOOL_SIZES: Record<BoardSizedTool, number[]> = {
  pen: [2, 4, 8],
  highlighter: [10, 18, 30],
  eraser: [16, 28, 48],
  shape: [2, 4, 8],
};

export const BOARD_SIZE_LABELS = ["Thin", "Medium", "Thick"];
export const BOARD_ERASER_SIZE_LABELS = ["Small", "Medium", "Large"];

/** Whether the eraser's nib is a disc or a square - a square nib is what makes clearing a
 * rectangular region of a diagram feel deliberate rather than nibbled. */
export type BoardEraserShape = "round" | "square";

/** What the eraser removes.
 *
 * "object" deletes whole elements the nib touches, which is the only thing that can be done to an
 * image, a table or a shape. "partial" cuts freehand ink where the nib crosses it, splitting one
 * stroke into the pieces that survive (see boardOps' eraseInk) and leaving every other kind of
 * element alone - erasing "half an image" has no meaning, and silently deleting the whole thing
 * while in partial mode would be the surprising outcome. */
export type BoardEraserMode = "object" | "partial";

/** How a new shape's interior is filled. "tint"/"solid" are both derived from the stroke colour
 * (see withAlpha), so the single colour swatch in the toolbar styles the whole shape. */
export type BoardFillStyle = "none" | "tint" | "solid";

/** How a new text box's background is filled: bare text, a sticky-note yellow, or a tint of the
 * text colour. */
export type BoardTextBackground = "none" | "sticky" | "tint";

/** Sticky-note yellow. A literal colour rather than a theme token: it is document content that
 * every collaborator has to see identically, not app chrome that follows the local theme. */
export const BOARD_STICKY_COLOR = "#fde68a";

export interface BoardTextStyle {
  fontSize: number;
  fontFamily: BoardFontFamily;
  bold: boolean;
  italic: boolean;
  align: BoardTextAlign;
  background: BoardTextBackground;
}

/** Font size presets for the text tool, in world px. */
export const BOARD_FONT_SIZES: { size: number; label: string }[] = [
  { size: 14, label: "S" },
  { size: 18, label: "M" },
  { size: 26, label: "L" },
  { size: 40, label: "XL" },
];

/** Everything the toolbar's options panel can change: the settings that decide what the *next*
 * thing drawn looks like. Purely local to one device - none of it is document state, so nothing
 * here is shared with collaborators or written to the board file. */
export interface BoardToolSettings {
  color: string;
  /** Preset index into BOARD_TOOL_SIZES, per tool. */
  sizes: Record<BoardSizedTool, number>;
  penStyle: BoardStrokeStyle;
  shape: BoardShapeKind;
  shapeStyle: BoardStrokeStyle;
  fill: BoardFillStyle;
  eraserShape: BoardEraserShape;
  eraserMode: BoardEraserMode;
  text: BoardTextStyle;
}

export function defaultBoardToolSettings(): BoardToolSettings {
  return {
    color: DEFAULT_SKETCH_COLOR,
    sizes: { pen: 1, highlighter: 1, eraser: 1, shape: 1 },
    penStyle: "solid",
    shape: "rect",
    shapeStyle: "solid",
    fill: "none",
    eraserShape: "round",
    eraserMode: "object",
    text: {
      fontSize: 18,
      fontFamily: "sans",
      bold: false,
      italic: false,
      align: "left",
      background: "none",
    },
  };
}

/** Resolved size for a tool, in world px. Clamped rather than indexed blindly so a settings value
 * from a future/edited state can't produce `undefined` and paint a NaN-wide stroke. */
export function boardToolSize(settings: BoardToolSettings, tool: BoardSizedTool): number {
  const presets = BOARD_TOOL_SIZES[tool];
  const index = Math.min(presets.length - 1, Math.max(0, settings.sizes[tool] ?? 1));
  return presets[index];
}

/** A family of controls in the options panel, and the unit the panel is assembled from when it is
 * editing a selection.
 *
 * "color" is the odd one out: those swatches live up in the toolbar row rather than in the panel (see
 * BoardToolOptions' header), but they are still an option that only *some* kinds support, so they
 * take part in the same intersection. */
export type BoardOptionGroup = "color" | "ink" | "shape" | "text";

/** Which families of options each kind of element supports. The four kinds with an empty list can't
 * be styled at all - a picture, a code block, a table and a voice note are configured by their own
 * content, not by a stroke or a font. */
const GROUPS_BY_KIND: Record<BoardElementKind, readonly BoardOptionGroup[]> = {
  ink: ["color", "ink"],
  shape: ["color", "shape"],
  text: ["color", "text"],
  image: [],
  code: [],
  table: [],
  voice: [],
};

/** The option families supported by *every* element in `elements` - an intersection, not a union.
 *
 * A control that appears for a mixed selection but only reaches half of it is worse than no control:
 * clicking "dotted" with a stroke and a picture selected would look like it did nothing to the
 * picture, when in fact the picture was never eligible. So a mixed selection offers only what all of
 * it has in common, and a selection whose kinds have nothing in common offers nothing (see
 * BoardToolbar, which then leaves the panel closed entirely). */
export function sharedOptionGroups(elements: readonly BoardElement[]): ReadonlySet<BoardOptionGroup> {
  if (elements.length === 0) return new Set();
  let shared: readonly BoardOptionGroup[] = GROUPS_BY_KIND[elements[0].kind];
  for (let i = 1; i < elements.length && shared.length > 0; i++) {
    const groups = GROUPS_BY_KIND[elements[i].kind];
    shared = shared.filter((group) => groups.includes(group));
  }
  return new Set(shared);
}

/** The preset whose size is closest to `size`. Needed because an element's width is a *number*, not
 * a preset index - it can have been resized, or drawn under an older set of presets - and the panel
 * still has to show which preset it sits nearest to. */
export function nearestSizeIndex(tool: BoardSizedTool, size: number): number {
  const presets = BOARD_TOOL_SIZES[tool];
  let best = 0;
  for (let i = 1; i < presets.length; i++) {
    if (Math.abs(presets[i] - size) < Math.abs(presets[best] - size)) best = i;
  }
  return best;
}

/** The settings as they should be *displayed* for a selection: `base` with every option the selected
 * elements actually carry read back out of them.
 *
 * This is what lets one panel serve both jobs. The tool's own settings describe the next thing to be
 * drawn; when the user instead clicks an existing element, the same controls have to show that
 * element's colour, width, dash and text style, or every option would read as "unset" and the panel
 * would be lying about what it is editing. On a mixed selection the first element of each kind wins -
 * there is one row of controls, so something has to. */
export function settingsFromSelection(
  elements: readonly BoardElement[],
  base: BoardToolSettings,
): BoardToolSettings {
  const ink = elements.find((el): el is InkElement => el.kind === "ink");
  const shape = elements.find((el): el is ShapeElement => el.kind === "shape");
  const text = elements.find((el): el is TextElement => el.kind === "text");
  const next: BoardToolSettings = { ...base, sizes: { ...base.sizes }, text: { ...base.text } };

  const coloured = ink ?? text ?? shape;
  if (coloured) next.color = coloured.kind === "shape" ? coloured.stroke : coloured.color;

  if (ink) {
    const sized: BoardSizedTool = ink.tool === "highlighter" ? "highlighter" : "pen";
    next.sizes[sized] = nearestSizeIndex(sized, ink.width);
    next.penStyle = ink.dash ?? "solid";
  }
  if (shape) {
    next.shape = shape.shape;
    next.sizes.shape = nearestSizeIndex("shape", shape.strokeWidth);
    next.shapeStyle = shape.dash ?? "solid";
    next.fill = shape.fill === "none" ? "none" : shape.fill.startsWith("rgba") ? "tint" : "solid";
  }
  if (text) {
    next.text = {
      fontSize: text.fontSize,
      fontFamily: text.fontFamily ?? "sans",
      bold: !!text.bold,
      italic: !!text.italic,
      align: text.align,
      background:
        text.background === "none"
          ? "none"
          : text.background === BOARD_STICKY_COLOR
            ? "sticky"
            : "tint",
    };
  }
  return next;
}

/** The CSS colour for a fill style, given the element's stroke colour. */
export function fillColor(fill: BoardFillStyle, color: string, alpha = 0.18): string {
  if (fill === "none") return "none";
  return fill === "solid" ? color : withAlpha(color, alpha);
}

/** The CSS colour for a text background style. */
export function textBackgroundColor(background: BoardTextBackground, color: string): string {
  switch (background) {
    case "sticky":
      return BOARD_STICKY_COLOR;
    case "tint":
      return withAlpha(color, 0.16);
    default:
      return "none";
  }
}

/** Every option change the toolbar can make. Implemented by BoardWorkspace, which is the only place
 * that can both update the settings *and* retint the current selection - the behaviour every
 * drawing tool has, where changing a setting with something selected restyles it instead of only
 * affecting the next thing drawn. */
export interface BoardToolActions {
  setColor: (color: string) => void;
  setSize: (tool: BoardSizedTool, index: number) => void;
  setPenStyle: (style: BoardStrokeStyle) => void;
  setShape: (shape: BoardShapeKind) => void;
  setShapeStyle: (style: BoardStrokeStyle) => void;
  setFill: (fill: BoardFillStyle) => void;
  setEraserShape: (shape: BoardEraserShape) => void;
  setEraserMode: (mode: BoardEraserMode) => void;
  setTextStyle: (patch: Partial<BoardTextStyle>) => void;
  /** Paint order for the selection. Only reachable from the selection panel (there is nothing to
   * reorder when no element is picked), and previously only from the `[` / `]` keys. */
  raiseSelection: () => void;
  lowerSelection: () => void;
  /** Asks to empty the board. The workspace confirms first and only then removes anything - the
   * confirmation lives there because its scrim has to cover the canvas, not the options panel it
   * was triggered from. */
  clearBoard: () => void;
}
