/** The Whiteboard kind's document model - an infinite canvas of free-floating elements, kept
 * entirely in a `.whiteboard.json` sidecar rather than in the note's Markdown (see fsNotes.ts's
 * readBoard/writeBoard). Unlike Default/Fixed-Size, where the `.md` file *is* the document, a
 * board's `.md` holds only a plain-text digest of its textual elements so the note still shows up
 * in search/backlinks - see WhiteboardView's `boardDigest`.
 *
 * Every element is stored in *world* coordinates: an unbounded, zoom-independent pixel space whose
 * origin is arbitrary (wherever the board happened to start). The viewport (see geometry.ts) is the
 * only thing that maps world -> screen, so panning/zooming never rewrites element data. This is the
 * opposite of SketchData's coordinate story (types.ts's SketchPoint, which is relative to a note's
 * text column and deliberately reflows with it) - a board has no text column to anchor to.
 *
 * Shape note: elements are a flat array, ordered back-to-front, and every element is addressed by a
 * stable `id`. That's deliberately the shape a Y.Map/Y.Array pair maps onto 1:1, so bringing boards
 * into the existing collab session later (src/collab/) is a matter of swapping the store, not
 * redesigning the document. */

/** The board's background paper, and with it which drawing assists are active - see
 * inkAssist.ts. Parallel to NoteLook (types.ts) but deliberately its own type: a board's surface
 * drives snapping geometry, not just a visual skin, and "paper"/"index-card" ruled lines are
 * meaningless on an infinite canvas. */
export type BoardSurface = "plain" | "graph" | "isometric";

/** World-space point. */
export interface BoardPoint {
  x: number;
  y: number;
}

/** Axis-aligned world-space rectangle - the bounding box every element resolves to for
 * hit-testing, marquee selection, and resize handles. */
export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardElementBase extends BoardRect {
  id: string;
  /** Prevents selection/move/resize without hiding the element - the usual whiteboard "pin this
   * down so I stop dragging it by accident" affordance. */
  locked?: boolean;
}

/** Freehand or assist-straightened ink. Points are world-space and stored *relative to the
 * element's own x/y origin*, not absolutely - that way dragging a stroke is a two-number edit
 * (x/y) instead of rewriting every point, and resizing can scale them proportionally. */
export interface InkElement extends BoardElementBase {
  kind: "ink";
  tool: "pen" | "highlighter";
  color: string;
  /** Stroke width in world pixels (i.e. at zoom 1). */
  width: number;
  points: BoardPoint[];
}

export type BoardShapeKind = "rect" | "ellipse" | "diamond" | "triangle" | "line" | "arrow";

export interface ShapeElement extends BoardElementBase {
  kind: "shape";
  shape: BoardShapeKind;
  stroke: string;
  /** "none" for an unfilled outline - stored as a string rather than `string | null` so the
   * JSON round-trips through one branch. */
  fill: string;
  strokeWidth: number;
  /** "line" and "arrow" only: which diagonal of the box the line runs along. False (the default)
   * is top-left -> bottom-right; true is bottom-left -> top-right.
   *
   * The obvious alternative - letting `w`/`h` go negative to encode direction - was rejected
   * because `w`/`h` are read by *everything*: bounding boxes, marquee intersection, culling, and
   * the element's own CSS width/height, none of which have any meaning for a negative extent. One
   * boolean confined to the two kinds that need it keeps every box on the board positive. */
  flipped?: boolean;
  /** Optional centered label, the way a Miro shape doubles as a labelled box. */
  text?: string;
  textColor?: string;
}

/** Whether a shape is a two-point vector (drawn corner to corner) rather than a filled box. */
export function isVectorShape(shape: BoardShapeKind): boolean {
  return shape === "line" || shape === "arrow";
}

/** The two world-space endpoints of a vector shape, resolving `flipped`. */
export function vectorEndpoints(el: ShapeElement): { a: BoardPoint; b: BoardPoint } {
  return el.flipped
    ? { a: { x: el.x, y: el.y + el.h }, b: { x: el.x + el.w, y: el.y } }
    : { a: { x: el.x, y: el.y }, b: { x: el.x + el.w, y: el.y + el.h } };
}

export type BoardTextAlign = "left" | "center" | "right";

export interface TextElement extends BoardElementBase {
  kind: "text";
  text: string;
  fontSize: number;
  color: string;
  align: BoardTextAlign;
  /** Sticky-note style background; "none" renders as bare text on the canvas. */
  background: string;
}

export interface ImageElement extends BoardElementBase {
  kind: "image";
  /** Content-hash key into the shared AssetStore (see collab/assetStore.ts and fsNotes.ts's
   * fsAssetStore), the same key shape Milkdown images already use - so a board image and an
   * in-note image of the same bytes dedupe onto one file. */
  src: string;
  alt?: string;
}

export interface CodeElement extends BoardElementBase {
  kind: "code";
  code: string;
  /** CodeMirror language-data name, e.g. "javascript" - see codeWidgetLanguages.ts. */
  language: string;
}

export interface TableElement extends BoardElementBase {
  kind: "table";
  /** Row-major cell text. Every row is the same length; see tableOps.ts, which is the only
   * thing allowed to change the shape. */
  rows: string[][];
  headerRow: boolean;
}

export interface VoiceElement extends BoardElementBase {
  kind: "voice";
  /** AssetStore key for the recorded WAV bytes - same store as ImageElement's `src`. */
  src: string;
  durationMs: number;
  /** Precomputed waveform buckets in 0..1, so the widget can paint without decoding audio. */
  peaks: number[];
  title?: string;
}

export type BoardElement =
  | InkElement
  | ShapeElement
  | TextElement
  | ImageElement
  | CodeElement
  | TableElement
  | VoiceElement;

export type BoardElementKind = BoardElement["kind"];

/** Saved camera position, so reopening a board lands where the user left it rather than at an
 * arbitrary world origin. Purely a viewing preference (like PageSetup for Fixed-Size), but it
 * lives in the board file rather than meta because it's per-board, not per-note-path. */
export interface BoardViewport {
  /** World coordinate currently at the viewport's top-left corner. */
  x: number;
  y: number;
  zoom: number;
}

export interface BoardDoc {
  version: 1;
  surface: BoardSurface;
  /** Back-to-front paint order; index *is* z-order (see boardOps.ts's raise/lower). */
  elements: BoardElement[];
  viewport: BoardViewport;
}

/** World-pixel spacing of one graph-paper cell / isometric lattice step at zoom 1. Both the
 * background pattern (BoardBackground.tsx) and every snapping calculation (inkAssist.ts,
 * geometry.ts) read this single constant, so they can never drift out of alignment. */
export const BOARD_GRID_SIZE = 24;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

export function emptyBoard(surface: BoardSurface = "plain"): BoardDoc {
  return {
    version: 1,
    surface,
    elements: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** Coerces whatever came back from the sidecar into a usable BoardDoc. Boards are user-visible
 * files in a plain-text vault, so a hand-edited or partially-written one has to degrade into an
 * empty board rather than throwing on open - same tolerance readSketch/readMeta already apply. */
export function normalizeBoard(raw: unknown): BoardDoc {
  if (!raw || typeof raw !== "object") return emptyBoard();
  const doc = raw as Partial<BoardDoc>;
  const surface: BoardSurface =
    doc.surface === "graph" || doc.surface === "isometric" ? doc.surface : "plain";
  const elements = Array.isArray(doc.elements)
    ? doc.elements.filter((el): el is BoardElement => isBoardElement(el))
    : [];
  const vp = doc.viewport;
  const viewport: BoardViewport =
    vp && Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.zoom)
      ? { x: vp.x, y: vp.y, zoom: clampZoom(vp.zoom) }
      : { x: 0, y: 0, zoom: 1 };
  return { version: 1, surface, elements, viewport };
}

const ELEMENT_KINDS: ReadonlySet<string> = new Set<BoardElementKind>([
  "ink",
  "shape",
  "text",
  "image",
  "code",
  "table",
  "voice",
]);

function isBoardElement(value: unknown): value is BoardElement {
  if (!value || typeof value !== "object") return false;
  const el = value as Partial<BoardElement>;
  return (
    typeof el.id === "string" &&
    typeof el.kind === "string" &&
    ELEMENT_KINDS.has(el.kind) &&
    Number.isFinite(el.x) &&
    Number.isFinite(el.y) &&
    Number.isFinite(el.w) &&
    Number.isFinite(el.h)
  );
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Whether an element's box can be resized vertically as well as horizontally. Everything can be
 * made wider; a voice note is the one element whose height is fixed by its own chrome (one row of
 * transport controls), so stretching it vertically would only add dead space - see
 * BoardSelection's handle set, which drops the vertical handles for it. */
export function isFreelyResizable(kind: BoardElementKind): boolean {
  return kind !== "voice";
}

/** Plain-text a given element contributes to the note's Markdown digest (and so to search
 * results/backlinks). Elements with no text at all contribute nothing. */
export function elementText(el: BoardElement): string {
  switch (el.kind) {
    case "text":
      return el.text;
    case "shape":
      return el.text ?? "";
    case "code":
      return el.code;
    case "table":
      return el.rows.map((row) => row.join(" | ")).join("\n");
    case "image":
      return el.alt ?? "";
    case "voice":
      return el.title ?? "";
    case "ink":
      return "";
  }
}
