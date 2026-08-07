import {
  BOARD_GRID_SIZE,
  elementText,
  isVectorShape,
  type BoardElement,
  type BoardFontFamily,
  type BoardPoint,
  type BoardRect,
  type BoardShapeKind,
  type BoardStrokeStyle,
  type BoardTextAlign,
  type CodeElement,
  type ImageElement,
  type InkElement,
  type ShapeElement,
  type TableElement,
  type TextElement,
  type VoiceElement,
} from "./boardTypes";
import {
  growRegion,
  pointInRegion,
  segmentRegionInterval,
  type EraserRegion,
} from "./geometry";

/** Element factories and pure transforms over a board's element list. Kept out of the React
 * components so every mutation is a plain, testable value->value function and the view layer only
 * ever does `commit(nextElements)` - which is also what makes undo/redo a matter of snapshotting
 * one array (see useBoardStore). */

function id(): string {
  return crypto.randomUUID();
}

/** Default box for a click-placed (rather than drag-sized) element, in world px. */
export const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  text: { w: 240, h: 72 },
  shape: { w: 160, h: 120 },
  code: { w: 380, h: 220 },
  table: { w: 360, h: 132 },
  voice: { w: 300, h: 88 },
  image: { w: 280, h: 200 },
};

/** Turns a finished (already assist-processed) stroke into an InkElement.
 *
 * Points arrive world-absolute and are re-based onto the element's own top-left origin, so moving
 * the stroke later is an x/y edit rather than a rewrite of every point. The box is padded by half
 * the stroke width on each side because a stroke's *drawn* extent is its centerline plus half its
 * width - without the pad, a horizontal line would get a zero-height box and become unselectable. */
export function inkFromPoints(
  points: BoardPoint[],
  tool: InkElement["tool"],
  color: string,
  width: number,
  dash?: BoardStrokeStyle,
): InkElement | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = width / 2;
  const originX = minX - pad;
  const originY = minY - pad;
  return {
    id: id(),
    kind: "ink",
    x: originX,
    y: originY,
    w: maxX - minX + width,
    h: maxY - minY + width,
    tool,
    color,
    width,
    // A solid stroke is stored as the *absence* of a dash, both to keep boards written before
    // stroke styles existed indistinguishable from new solid ones and to avoid handing Yjs an
    // explicit `undefined` (see boardSync - elements are stored as whole values).
    ...(dash && dash !== "solid" ? { dash } : {}),
    points: points.map((p) => ({ x: p.x - originX, y: p.y - originY })),
  };
}

/** Everything about a new shape except where it is - the toolbar's current shape options, resolved
 * (see boardTools' BoardToolSettings). */
export interface NewShapeStyle {
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash?: BoardStrokeStyle;
  /** "line"/"arrow" only: which diagonal of the box the line runs along - see ShapeElement. */
  flipped?: boolean;
}

export function createShape(
  rect: BoardRect,
  shape: BoardShapeKind,
  style: NewShapeStyle,
): ShapeElement {
  return {
    id: id(),
    kind: "shape",
    ...rect,
    shape,
    stroke: style.stroke,
    fill: style.fill,
    strokeWidth: style.strokeWidth,
    ...(style.dash && style.dash !== "solid" ? { dash: style.dash } : {}),
    flipped: style.flipped ?? false,
  };
}

/** Everything about a new text box except where it is. */
export interface NewTextStyle {
  color: string;
  /** A CSS colour, or "none" for bare text on the canvas - see TextElement.background. */
  background: string;
  fontSize: number;
  align: BoardTextAlign;
  fontFamily?: BoardFontFamily;
  bold?: boolean;
  italic?: boolean;
}

export function createText(at: BoardPoint, style: NewTextStyle): TextElement {
  return {
    id: id(),
    kind: "text",
    x: at.x,
    y: at.y,
    w: DEFAULT_SIZES.text.w,
    // The default box has to hold at least one line of whatever size was chosen, or a 40px heading
    // lands in a box it immediately overflows.
    h: Math.max(DEFAULT_SIZES.text.h, Math.round(style.fontSize * 2.6)),
    text: "",
    fontSize: style.fontSize,
    color: style.color,
    align: style.align,
    background: style.background,
    ...(style.fontFamily && style.fontFamily !== "sans" ? { fontFamily: style.fontFamily } : {}),
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
  };
}

export function createImage(at: BoardPoint, src: string, w: number, h: number): ImageElement {
  return { id: id(), kind: "image", x: at.x, y: at.y, w, h, src };
}

export function createCode(at: BoardPoint, language = "javascript"): CodeElement {
  return { id: id(), kind: "code", x: at.x, y: at.y, ...DEFAULT_SIZES.code, code: "", language };
}

export function createTable(at: BoardPoint, rows = 3, cols = 3): TableElement {
  return {
    id: id(),
    kind: "table",
    x: at.x,
    y: at.y,
    w: DEFAULT_SIZES.table.w,
    h: DEFAULT_SIZES.table.h,
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => "")),
    headerRow: true,
  };
}

export function createVoice(
  at: BoardPoint,
  src: string,
  durationMs: number,
  peaks: number[],
): VoiceElement {
  return {
    id: id(),
    kind: "voice",
    x: at.x,
    y: at.y,
    ...DEFAULT_SIZES.voice,
    src,
    durationMs,
    peaks,
  };
}

/** Applies `patch` to whichever elements `ids` names, leaving the rest (and the array order,
 * i.e. z-order) untouched. */
export function updateElements(
  elements: readonly BoardElement[],
  ids: ReadonlySet<string>,
  patch: (el: BoardElement) => BoardElement,
): BoardElement[] {
  return elements.map((el) => (ids.has(el.id) ? patch(el) : el));
}

export function moveBy(el: BoardElement, dx: number, dy: number): BoardElement {
  return { ...el, x: el.x + dx, y: el.y + dy };
}

/** Resizes an element to `rect`. Ink is the one kind whose *contents* have to follow the box:
 * its stored points are element-relative, so they're scaled by the box's own dimension ratio.
 * Everything else re-lays-out from w/h alone. Guarded against a zero previous dimension (a
 * perfectly horizontal stroke has h === width, never 0, thanks to inkFromPoints' padding - but a
 * degenerate persisted element from a hand-edited file could still hit it). */
export function resizeElement(el: BoardElement, rect: BoardRect): BoardElement {
  const next = { ...el, ...rect };
  if (el.kind === "ink") {
    const sx = el.w > 0 ? rect.w / el.w : 1;
    const sy = el.h > 0 ? rect.h / el.h : 1;
    return { ...(next as InkElement), points: el.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
  }
  return next;
}

/** Minimum box an element may be resized to - small enough to be useful, large enough that an
 * element can never be shrunk into an unclickable speck. */
export const MIN_ELEMENT_SIZE = 12;

/** Normalizes a resize result: extents stay positive, and nothing shrinks below `min`.
 *
 * A dragged handle can legitimately cross the opposite edge (pulling the west handle past the east
 * one), which flips the rect inside out - so the sign is folded back into the origin here rather
 * than being allowed to reach an element's `w`/`h`, which are positive by invariant (see
 * ShapeElement.flipped). `min` is a parameter because a line or arrow is legitimately flat in one
 * axis - forcing it to MIN_ELEMENT_SIZE would silently rotate a horizontal line off true. */
export function clampRect(rect: BoardRect, min = MIN_ELEMENT_SIZE): BoardRect {
  const w = Math.max(min, Math.abs(rect.w));
  const h = Math.max(min, Math.abs(rect.h));
  return {
    x: rect.w < 0 ? rect.x + rect.w : rect.x,
    y: rect.h < 0 ? rect.y + rect.h : rect.y,
    w,
    h,
  };
}

/** Changes an existing shape's kind, keeping it where and how big it is - what the shape picker does
 * when the selection panel is editing a shape rather than arming the tool.
 *
 * The one thing that can't be preserved is a flat box: a line or arrow is legitimately zero-height
 * (see ShapeElement.flipped), and turning that into a rectangle would produce a shape with no
 * interior that vanishes from the canvas. So the box gets a floor on the way *out* of a vector kind -
 * generous enough to be visibly grabbable, since the user can resize from there. */
export function retargetShape(el: ShapeElement, shape: BoardShapeKind): ShapeElement {
  if (isVectorShape(shape)) return { ...el, shape };
  const floor = isVectorShape(el.shape) ? 40 : MIN_ELEMENT_SIZE;
  return { ...el, shape, w: Math.max(el.w, floor), h: Math.max(el.h, floor) };
}

/** Moves `ids` to the very front/back of the paint order, preserving their order relative to each
 * other. Array position *is* z-order (see BoardDoc.elements), so this is a partition. */
export function reorder(
  elements: readonly BoardElement[],
  ids: ReadonlySet<string>,
  to: "front" | "back",
): BoardElement[] {
  const moving = elements.filter((el) => ids.has(el.id));
  const rest = elements.filter((el) => !ids.has(el.id));
  return to === "front" ? [...rest, ...moving] : [...moving, ...rest];
}

/** Duplicates `ids`, offset by one grid cell so the copies are visibly on top rather than exactly
 * hiding their originals. Returns the new elements alongside the new list so the caller can select
 * them straight away. */
export function duplicate(
  elements: readonly BoardElement[],
  ids: ReadonlySet<string>,
): { elements: BoardElement[]; created: BoardElement[] } {
  const created = elements
    .filter((el) => ids.has(el.id))
    .map((el) => ({ ...el, id: id(), x: el.x + BOARD_GRID_SIZE, y: el.y + BOARD_GRID_SIZE }));
  return { elements: [...elements, ...created], created };
}

export function removeElements(
  elements: readonly BoardElement[],
  ids: ReadonlySet<string>,
): BoardElement[] {
  return elements.filter((el) => !ids.has(el.id));
}

/** Cuts an ink stroke where the eraser nib crosses it, returning the fragments that survive - the
 * partial eraser (see BoardEraserMode). `null` means the nib didn't reach this stroke, which is the
 * signal for the caller to keep the original element untouched rather than replace it with an
 * identical copy; an empty array means the whole stroke was rubbed out.
 *
 * The cut is computed against the *segments*, not the stored sample points: a straightened stroke
 * can be two points far apart (see inkAssist), so a point-only test would let the eraser pass
 * straight through the middle of a line without touching it. Each surviving run is rebuilt through
 * inkFromPoints so a fragment is a fully normal ink element - its own tight bounding box, its own
 * origin-relative points - and not a special "partial" variant the rest of the board has to know
 * about. */
export function eraseInk(el: InkElement, region: EraserRegion): InkElement[] | null {
  const pts = el.points;
  if (pts.length === 0) return null;
  // The nib erases the stroke's drawn extent, not its mathematical centerline, so it is grown by
  // half the stroke width before any of the geometry below.
  const grown = growRegion(region, el.width / 2);
  const local: EraserRegion = {
    square: grown.square,
    radius: grown.radius,
    center: { x: grown.center.x - el.x, y: grown.center.y - el.y },
  };

  if (pts.length === 1) return pointInRegion(pts[0], local) ? [] : null;

  const runs: BoardPoint[][] = [];
  let current: BoardPoint[] | null = pointInRegion(pts[0], local) ? null : [pts[0]];
  let cut = current === null;
  const closeRun = () => {
    // A one-point remnant is a sub-pixel speck the user can't see but can still select, so runs are
    // kept only once they have real extent.
    if (current && current.length > 1 && polylineLength(current) > el.width / 2) runs.push(current);
    current = null;
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i];
    const to = pts[i + 1];
    const interval = segmentRegionInterval(from, to, local);
    if (!interval) {
      if (!current) current = [from];
      current.push(to);
      continue;
    }
    cut = true;
    const [enter, exit] = interval;
    if (enter > 0) {
      if (!current) current = [from];
      current.push(lerp(from, to, enter));
    }
    closeRun();
    if (exit < 1) current = [lerp(from, to, exit), to];
  }
  closeRun();

  if (!cut) return null;
  const pieces = runs
    .map((run) =>
      inkFromPoints(
        // Fragments are handed back in world coordinates, since inkFromPoints re-bases them onto
        // each fragment's own origin.
        run.map((p) => ({ x: p.x + el.x, y: p.y + el.y })),
        el.tool,
        el.color,
        el.width,
        el.dash,
      ),
    )
    .filter((piece): piece is InkElement => piece !== null);
  // The first surviving fragment keeps the original's id. The eraser re-cuts the same stroke on
  // every pointer sample of a drag, and without this each sample would replace it with a
  // brand-new element - churning the collab document and dropping it out of the selection.
  return pieces.map((piece, index) => (index === 0 ? { ...piece, id: el.id } : piece));
}

function lerp(a: BoardPoint, b: BoardPoint, t: number): BoardPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function polylineLength(points: readonly BoardPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

/** The Markdown digest written into the board note's own `.md` file.
 *
 * A Whiteboard note's real document is its sidecar, but the vault is a folder of plain-text files
 * and every other part of the app (search index, backlinks, the notes tree) reads the `.md`. So the
 * `.md` gets a readable, regenerated-on-save transcript of everything textual on the canvas: the
 * note stays findable by its content, and someone browsing the vault outside the app sees something
 * meaningful instead of an empty file. It is strictly derived - nothing ever reads it back into the
 * board (see WhiteboardView, which loads only from the sidecar). */
export function boardDigest(elements: readonly BoardElement[]): string {
  const lines: string[] = [];
  for (const el of elements) {
    const text = elementText(el).trim();
    if (!text) continue;
    if (el.kind === "code") {
      lines.push("```" + el.language, text, "```");
    } else if (el.kind === "table") {
      lines.push(...text.split("\n").map((row) => `| ${row} |`));
    } else {
      lines.push(text);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + (lines.length ? "\n" : "");
}
