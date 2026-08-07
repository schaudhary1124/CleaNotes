import {
  BOARD_GRID_SIZE,
  elementText,
  type BoardElement,
  type BoardPoint,
  type BoardRect,
  type BoardShapeKind,
  type CodeElement,
  type ImageElement,
  type InkElement,
  type ShapeElement,
  type TableElement,
  type TextElement,
  type VoiceElement,
} from "./boardTypes";

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
    points: points.map((p) => ({ x: p.x - originX, y: p.y - originY })),
  };
}

export function createShape(
  rect: BoardRect,
  shape: BoardShapeKind,
  stroke: string,
  fill: string,
  strokeWidth: number,
  flipped = false,
): ShapeElement {
  return { id: id(), kind: "shape", ...rect, shape, stroke, fill, strokeWidth, flipped };
}

export function createText(at: BoardPoint, color: string, background: string): TextElement {
  return {
    id: id(),
    kind: "text",
    x: at.x,
    y: at.y,
    ...DEFAULT_SIZES.text,
    text: "",
    fontSize: 16,
    color,
    align: "left",
    background,
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
